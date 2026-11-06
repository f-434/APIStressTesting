package bench

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sort"
	"sync"
	"time"
)

type Test struct {
	ID          string
	Config      TestConfig
	Status      string
	CreatedAt   time.Time
	StartedAt   time.Time
	FinishedAt  time.Time
	Mode        string
	Planned     int
	DurationSec int

	mu                 sync.Mutex
	states             map[string]*ModelState
	order              []string
	currentModel       string
	currentProtocol    string
	modelIndex         int
	modelCount         int
	currentConcurrency int
	totalResults       int
	recent             []RequestResult
	report             *Report
	errMsg             string
	cancel             context.CancelFunc
	subs               map[chan Event]struct{}
}

func newTestID() string {
	b := make([]byte, 5)
	_, _ = rand.Read(b)
	return fmt.Sprintf("T%s%s", time.Now().Format("20060102-150405"), hex.EncodeToString(b))
}

func NewTest(cfg TestConfig) *Test {
	return &Test{
		ID:        newTestID(),
		Config:    cfg,
		Status:    StatusRunning,
		CreatedAt: time.Now(),
		StartedAt: time.Now(),
		Mode:      cfg.Mode,
		states:    make(map[string]*ModelState),
		subs:      make(map[chan Event]struct{}),
		recent:    make([]RequestResult, 0, 24),
	}
}

func (t *Test) SetCancel(cancel context.CancelFunc) {
	t.mu.Lock()
	t.cancel = cancel
	t.mu.Unlock()
}

func (t *Test) Stop() bool {
	t.mu.Lock()
	cancel := t.cancel
	running := t.Status == StatusRunning
	t.mu.Unlock()
	if running && cancel != nil {
		cancel()
		return true
	}
	return false
}

func (t *Test) SetPlanned(planned, durationSec int, mode string) {
	t.mu.Lock()
	t.Planned = planned
	t.DurationSec = durationSec
	t.Mode = mode
	t.mu.Unlock()
}

func (t *Test) SetPhase(index int, model, protocol, endpoint string, concurrency int, modelCount int) {
	t.mu.Lock()
	t.currentModel = model
	t.currentProtocol = protocol
	t.modelIndex = index
	t.modelCount = modelCount
	t.currentConcurrency = concurrency
	if _, ok := t.states[model]; !ok {
		t.states[model] = newModelState(model, protocol, endpoint)
		t.order = append(t.order, model)
	}
	t.mu.Unlock()
}

func (t *Test) SetConcurrency(c int) {
	t.mu.Lock()
	t.currentConcurrency = c
	t.mu.Unlock()
}

func (t *Test) AddResult(res RequestResult) {
	t.mu.Lock()
	st, ok := t.states[res.Model]
	if !ok {
		st = newModelState(res.Model, res.Protocol, res.Endpoint)
		t.states[res.Model] = st
		t.order = append(t.order, res.Model)
	}
	st.record(res)
	if res.Concurrency > st.MaxConcurrency {
		st.MaxConcurrency = res.Concurrency
	}
	t.totalResults++
	t.recent = append(t.recent, res)
	if len(t.recent) > 24 {
		t.recent = t.recent[len(t.recent)-24:]
	}
	t.mu.Unlock()
}

func (t *Test) statesLocked() []*ModelState {
	out := make([]*ModelState, 0, len(t.order))
	for _, m := range t.order {
		if st, ok := t.states[m]; ok {
			out = append(out, st)
		}
	}
	return out
}

func (t *Test) liveLocked() LiveUpdate {
	if t.StartedAt.IsZero() {
		t.StartedAt = time.Now()
	}
	end := t.FinishedAt
	if end.IsZero() {
		end = time.Now()
	}
	elapsedMs := end.Sub(t.StartedAt).Milliseconds()
	if elapsedMs < 0 {
		elapsedMs = 0
	}
	// Live charts use only fully elapsed seconds so the newest partial bucket
	// does not read as a throughput dip.
	maxSec := int(elapsedMs / 1000)
	if maxSec > 0 {
		maxSec--
	}

	states := t.statesLocked()
	merged := mergeStates(states)
	agg := aggregateState(merged, maxSec, 0)

	live := LiveUpdate{
		TestID:             t.ID,
		Status:             t.Status,
		Mode:               t.Mode,
		ElapsedMs:          elapsedMs,
		Planned:            t.Planned,
		DurationSec:        t.DurationSec,
		Completed:          agg.Total,
		Success:            agg.Success,
		Failed:             agg.Failed,
		SuccessRate:        agg.SuccessRate,
		QPS:                agg.QPS,
		Latency:            agg.Latency,
		TTFT:               agg.TTFT,
		Tokens:             agg.Tokens,
		CurrentModel:       t.currentModel,
		CurrentProtocol:    t.currentProtocol,
		ModelIndex:         t.modelIndex,
		ModelCount:         t.modelCount,
		CurrentConcurrency: t.currentConcurrency,
		StatusCodes:        agg.StatusCodes,
		Errors:             agg.Errors,
		Series:             agg.Series,
		Histogram:          agg.Histogram,
		Models:             []ModelLive{},
		Recent:             []RequestResult{},
		Config:             t.Config,
		Error:              t.errMsg,
	}
	if elapsedMs > 0 {
		live.QPS = round2(float64(agg.Success) / (float64(elapsedMs) / 1000))
	}
	if len(live.Errors) > 8 {
		live.Errors = live.Errors[:8]
	}

	for _, st := range states {
		elapsed := st.elapsedMs()
		secs := float64(elapsed) / 1000
		if secs < 0.001 {
			secs = 0.001
		}
		ml := ModelLive{
			Model:       st.Model,
			Protocol:    st.Protocol,
			Endpoint:    st.Endpoint,
			Total:       st.Total,
			Success:     st.Success,
			Failed:      st.Failed,
			Latency:     computeStats(st.Latencies),
			TTFT:        computeStats(st.TTFTs),
			Tokens:      tokenStats(st),
			Concurrency: st.MaxConcurrency,
		}
		if st.Total > 0 {
			ml.SuccessRate = round2(float64(st.Success) / float64(st.Total) * 100)
		}
		ml.QPS = round2(float64(st.Success) / secs)
		live.Models = append(live.Models, ml)
	}

	for i := len(t.recent) - 1; i >= 0; i-- {
		live.Recent = append(live.Recent, t.recent[i])
	}
	return live
}

func (t *Test) Live() LiveUpdate {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.liveLocked()
}

func (t *Test) PublishLive() {
	live := t.Live()
	t.publish(Event{Type: "update", Data: live})
}

func (t *Test) publish(ev Event) {
	t.mu.Lock()
	subs := make([]chan Event, 0, len(t.subs))
	for ch := range t.subs {
		subs = append(subs, ch)
	}
	t.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

func (t *Test) Subscribe() (<-chan Event, LiveUpdate, bool) {
	ch := make(chan Event, 32)
	t.mu.Lock()
	t.subs[ch] = struct{}{}
	finished := t.Status != StatusRunning
	live := t.liveLocked()
	t.mu.Unlock()
	if finished {
		t.Unsubscribe(ch)
	}
	return ch, live, finished
}

func (t *Test) Unsubscribe(ch <-chan Event) {
	t.mu.Lock()
	for c := range t.subs {
		if c == ch {
			delete(t.subs, c)
			break
		}
	}
	t.mu.Unlock()
}

func (t *Test) Finish(status, errMsg string) {
	t.mu.Lock()
	if t.Status != StatusRunning {
		t.mu.Unlock()
		return
	}
	t.Status = status
	t.FinishedAt = time.Now()
	if errMsg != "" {
		t.errMsg = errMsg
	}
	report := t.buildReportLocked(status, errMsg)
	t.report = report
	t.mu.Unlock()

	t.publish(Event{Type: "done", Data: map[string]any{
		"testId": t.ID,
		"status": status,
		"error":  errMsg,
	}})
}

func (t *Test) buildReportLocked(status, errMsg string) *Report {
	durationMs := t.FinishedAt.Sub(t.StartedAt).Milliseconds()
	if durationMs < 0 {
		durationMs = 0
	}
	maxSec := int(durationMs/1000) + 1

	report := &Report{
		ID:         t.ID,
		Status:     status,
		CreatedAt:  t.CreatedAt,
		StartedAt:  t.StartedAt,
		FinishedAt: t.FinishedAt,
		DurationMs: durationMs,
		Config:     t.Config,
		Models:     []ModelReport{},
		Error:      errMsg,
	}

	states := t.statesLocked()
	for _, st := range states {
		agg := aggregateState(st, maxSec, 0)
		results := make([]RequestResult, len(st.Samples))
		copy(results, st.Samples)
		sort.Slice(results, func(i, j int) bool { return results[i].Index < results[j].Index })
		report.Models = append(report.Models, ModelReport{
			Model:            st.Model,
			Protocol:         st.Protocol,
			Endpoint:         st.Endpoint,
			Aggregate:        agg,
			Results:          results,
			ResultsTruncated: st.SamplesTruncated,
		})
	}

	merged := mergeStates(states)
	canceled := 0
	if t.Mode == ModeFixed && status != StatusFailed {
		canceled = t.Planned - merged.Total
		if canceled < 0 {
			canceled = 0
		}
	}
	totals := aggregateState(merged, maxSec, canceled)
	totals.ElapsedMs = durationMs
	if durationMs > 0 {
		totals.QPS = round2(float64(totals.Success) / (float64(durationMs) / 1000))
	}
	report.Totals = totals
	return report
}

func (t *Test) Report() *Report {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.report
}

func (t *Test) CurrentStatus() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.Status
}

func (t *Test) Summary() TestSummary {
	t.mu.Lock()
	defer t.mu.Unlock()

	elapsed := int64(0)
	if !t.StartedAt.IsZero() {
		end := t.FinishedAt
		if end.IsZero() {
			end = time.Now()
		}
		elapsed = end.Sub(t.StartedAt).Milliseconds()
	}
	summary := TestSummary{
		ID:         t.ID,
		Status:     t.Status,
		CreatedAt:  t.CreatedAt,
		Mode:       t.Mode,
		Protocol:   t.Config.Protocol,
		Models:     append([]string{}, t.order...),
		ModelCount: len(t.order),
		ElapsedMs:  elapsed,
	}
	if t.report != nil {
		summary.Total = t.report.Totals.Total
		summary.Success = t.report.Totals.Success
		summary.Failed = t.report.Totals.Failed
		summary.SuccessRate = t.report.Totals.SuccessRate
		summary.QPS = t.report.Totals.QPS
		summary.AvgLatency = t.report.Totals.Latency.Avg
		summary.P95 = t.report.Totals.Latency.P95
		summary.DurationMs = t.report.DurationMs
		summary.ElapsedMs = t.report.DurationMs
		return summary
	}

	states := t.statesLocked()
	merged := mergeStates(states)
	summary.Total = merged.Total
	summary.Success = merged.Success
	summary.Failed = merged.Failed
	if merged.Total > 0 {
		summary.SuccessRate = round2(float64(merged.Success) / float64(merged.Total) * 100)
	}
	stats := computeStats(merged.Latencies)
	summary.AvgLatency = stats.Avg
	summary.P95 = stats.P95
	secs := float64(elapsed) / 1000
	if secs < 0.001 {
		secs = 0.001
	}
	summary.QPS = round2(float64(merged.Success) / secs)
	summary.DurationMs = elapsed
	return summary
}

func (t *Test) Models() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]string{}, t.order...)
}

func (t *Test) ResultCount() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.totalResults
}

func (t *Test) BaseURL() string { return t.Config.BaseURL }

// Store keeps tests in memory (reports are ephemeral by design).
type Store struct {
	mu    sync.RWMutex
	tests map[string]*Test
	order []string
}

func NewStore() *Store {
	return &Store{tests: make(map[string]*Test)}
}

func (s *Store) Add(t *Test) {
	s.mu.Lock()
	s.tests[t.ID] = t
	s.order = append(s.order, t.ID)
	s.evictLocked()
	s.mu.Unlock()
}

func (s *Store) evictLocked() {
	if len(s.order) <= 60 {
		return
	}
	for i := 0; i < len(s.order) && len(s.order) > 40; {
		id := s.order[i]
		t, ok := s.tests[id]
		if ok && t.CurrentStatus() == StatusRunning {
			i++
			continue
		}
		delete(s.tests, id)
		s.order = append(s.order[:i], s.order[i+1:]...)
	}
}

func (s *Store) Get(id string) (*Test, bool) {
	s.mu.RLock()
	t, ok := s.tests[id]
	s.mu.RUnlock()
	return t, ok
}

func (s *Store) List() []TestSummary {
	s.mu.RLock()
	ids := append([]string{}, s.order...)
	s.mu.RUnlock()
	out := make([]TestSummary, 0, len(ids))
	for i := len(ids) - 1; i >= 0; i-- {
		if t, ok := s.Get(ids[i]); ok {
			out = append(out, t.Summary())
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}
