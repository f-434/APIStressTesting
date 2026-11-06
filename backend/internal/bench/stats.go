package bench

import (
	"math"
	"sort"
	"strings"
)

// ModelState accumulates everything recorded for one model.
type ModelState struct {
	Model    string
	Protocol string
	Endpoint string

	Total   int
	Success int
	Failed  int

	PromptTokens     int
	CompletionTokens int
	EstimatedTokens  int
	TokenCount       int
	TPSum            float64
	TPSCount         int

	Latencies []float64
	TTFTs     []float64

	StatusCodes map[int]int
	Errors      map[string]*ErrorGroup

	Samples          []RequestResult
	SamplesTruncated bool

	Starts      map[int]int
	Ends        map[int]int
	CompBySec   map[int]int
	SuccBySec   map[int]int
	FailBySec   map[int]int
	LatSumBySec map[int]float64
	LatMaxBySec map[int]float64
	ConcBySec   map[int]int

	FirstMs int64
	LastMs  int64
	MaxSec  int
	HasData bool

	Concurrency    int
	MaxConcurrency int
}

func newModelState(model, protocol, endpoint string) *ModelState {
	return &ModelState{
		Model:       model,
		Protocol:    protocol,
		Endpoint:    endpoint,
		StatusCodes: make(map[int]int),
		Errors:      make(map[string]*ErrorGroup),
		Starts:      make(map[int]int),
		Ends:        make(map[int]int),
		CompBySec:   make(map[int]int),
		SuccBySec:   make(map[int]int),
		FailBySec:   make(map[int]int),
		LatSumBySec: make(map[int]float64),
		LatMaxBySec: make(map[int]float64),
		ConcBySec:   make(map[int]int),
	}
}

func (st *ModelState) record(res RequestResult) {
	st.Total++
	if res.OK {
		st.Success++
	} else {
		st.Failed++
	}

	st.Latencies = append(st.Latencies, res.LatencyMs)
	if res.TTFTMs > 0 {
		st.TTFTs = append(st.TTFTs, res.TTFTMs)
	}

	st.PromptTokens += res.PromptTokens
	st.CompletionTokens += res.CompletionTokens
	if res.TotalTokens > 0 {
		st.TokenCount++
	}
	if res.TokenSource == "estimated" {
		st.EstimatedTokens++
	}
	if res.TokensPerSec > 0 {
		st.TPSum += res.TokensPerSec
		st.TPSCount++
	}

	st.StatusCodes[res.Status]++
	if !res.OK {
		key := res.ErrorType + "|" + errorSignature(res.ErrorMessage)
		g, ok := st.Errors[key]
		if !ok {
			g = &ErrorGroup{
				Type:      res.ErrorType,
				Message:   truncateRunes(strings.TrimSpace(res.ErrorMessage), 800),
				FirstAtMs: res.StartOffsetMs,
			}
			st.Errors[key] = g
		}
		g.Count++
		g.Statuses = appendUniqueInt(g.Statuses, res.Status)
		g.Models = appendUniqueString(g.Models, res.Model)
		if res.StartOffsetMs < g.FirstAtMs {
			g.FirstAtMs = res.StartOffsetMs
		}
	}

	startSec := int(res.StartOffsetMs / 1000)
	endMs := res.StartOffsetMs + int64(math.Round(res.LatencyMs))
	endSec := int(endMs / 1000)
	st.Starts[startSec]++
	st.Ends[endSec]++
	st.CompBySec[endSec]++
	if res.OK {
		st.SuccBySec[endSec]++
	} else {
		st.FailBySec[endSec]++
	}
	st.LatSumBySec[endSec] += res.LatencyMs
	if res.LatencyMs > st.LatMaxBySec[endSec] {
		st.LatMaxBySec[endSec] = res.LatencyMs
	}
	if res.Concurrency > st.ConcBySec[endSec] {
		st.ConcBySec[endSec] = res.Concurrency
	}
	if endSec > st.MaxSec {
		st.MaxSec = endSec
	}

	if !st.HasData || res.StartOffsetMs < st.FirstMs {
		st.FirstMs = res.StartOffsetMs
	}
	if endMs > st.LastMs {
		st.LastMs = endMs
	}
	st.HasData = true

	if len(st.Samples) < sampleLimit {
		st.Samples = append(st.Samples, res)
	} else {
		st.SamplesTruncated = true
	}
}

func (st *ModelState) elapsedMs() int64 {
	if !st.HasData || st.LastMs <= st.FirstMs {
		return 0
	}
	return st.LastMs - st.FirstMs
}

const sampleLimit = 20000

// computeStats returns descriptive statistics using nearest-rank percentiles.
func computeStats(values []float64) Stats {
	n := len(values)
	if n == 0 {
		return Stats{}
	}
	sorted := make([]float64, n)
	copy(sorted, values)
	sort.Float64s(sorted)

	var sum float64
	for _, v := range sorted {
		sum += v
	}
	return Stats{
		Count: n,
		Min:   sorted[0],
		Max:   sorted[n-1],
		Avg:   round2(sum / float64(n)),
		P50:   round2(percentile(sorted, 50)),
		P90:   round2(percentile(sorted, 90)),
		P95:   round2(percentile(sorted, 95)),
		P99:   round2(percentile(sorted, 99)),
		Sum:   round2(sum),
	}
}

func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	if p <= 0 {
		return sorted[0]
	}
	idx := int(math.Ceil(p/100*float64(len(sorted)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

func round2(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Round(v*100) / 100
}

func buildHistogram(values []float64) []HistBucket {
	if len(values) == 0 {
		return []HistBucket{}
	}
	maxV := 0.0
	for _, v := range values {
		if v > maxV {
			maxV = v
		}
	}
	if maxV <= 0 {
		maxV = 1
	}
	steps := []float64{1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 15000, 20000, 30000, 60000, 120000, 300000, 600000}
	step := steps[len(steps)-1]
	raw := maxV / 12
	for _, s := range steps {
		if s >= raw {
			step = s
			break
		}
	}
	n := int(math.Ceil(maxV / step))
	if n < 1 {
		n = 1
	}
	if n > 60 {
		n = 60
		step = maxV / float64(n)
	}
	buckets := make([]HistBucket, n)
	for i := 0; i < n; i++ {
		buckets[i] = HistBucket{From: round2(float64(i) * step), To: round2(float64(i+1) * step)}
	}
	for _, v := range values {
		idx := int(v / step)
		if idx >= n {
			idx = n - 1
		}
		buckets[idx].Count++
	}
	return buckets
}

func buildSeries(st *ModelState, maxSec int) []SeriesPoint {
	if maxSec < 0 {
		maxSec = 0
	}
	points := make([]SeriesPoint, 0, maxSec+1)
	level := 0
	for sec := 0; sec <= maxSec; sec++ {
		started := st.Starts[sec]
		if v := st.ConcBySec[sec]; v > 0 {
			level = v
		}
		completed := st.CompBySec[sec]
		avg := 0.0
		if completed > 0 {
			avg = round2(st.LatSumBySec[sec] / float64(completed))
		}
		points = append(points, SeriesPoint{
			Sec:         sec,
			Started:     started,
			Completed:   completed,
			Success:     st.SuccBySec[sec],
			Failed:      st.FailBySec[sec],
			AvgLatency:  avg,
			Concurrency: level,
		})
	}
	return points
}

func mergeStates(states []*ModelState) *ModelState {
	merged := newModelState("全部模型", "", "")
	for _, st := range states {
		merged.Total += st.Total
		merged.Success += st.Success
		merged.Failed += st.Failed
		merged.PromptTokens += st.PromptTokens
		merged.CompletionTokens += st.CompletionTokens
		merged.EstimatedTokens += st.EstimatedTokens
		merged.TokenCount += st.TokenCount
		merged.TPSum += st.TPSum
		merged.TPSCount += st.TPSCount
		merged.Latencies = append(merged.Latencies, st.Latencies...)
		merged.TTFTs = append(merged.TTFTs, st.TTFTs...)
		for code, count := range st.StatusCodes {
			merged.StatusCodes[code] += count
		}
		for _, g := range st.Errors {
			key := g.Type + "|" + errorSignature(g.Message)
			mg, ok := merged.Errors[key]
			if !ok {
				mg = &ErrorGroup{Type: g.Type, Message: g.Message, FirstAtMs: g.FirstAtMs}
				merged.Errors[key] = mg
			}
			mg.Count += g.Count
			for _, s := range g.Statuses {
				mg.Statuses = appendUniqueInt(mg.Statuses, s)
			}
			for _, m := range g.Models {
				mg.Models = appendUniqueString(mg.Models, m)
			}
			if g.FirstAtMs < mg.FirstAtMs {
				mg.FirstAtMs = g.FirstAtMs
			}
		}
		for sec, v := range st.Starts {
			merged.Starts[sec] += v
		}
		for sec, v := range st.Ends {
			merged.Ends[sec] += v
		}
		for sec, v := range st.CompBySec {
			merged.CompBySec[sec] += v
		}
		for sec, v := range st.SuccBySec {
			merged.SuccBySec[sec] += v
		}
		for sec, v := range st.FailBySec {
			merged.FailBySec[sec] += v
		}
		for sec, v := range st.LatSumBySec {
			merged.LatSumBySec[sec] += v
		}
		for sec, v := range st.LatMaxBySec {
			if v > merged.LatMaxBySec[sec] {
				merged.LatMaxBySec[sec] = v
			}
		}
		for sec, v := range st.ConcBySec {
			if v > merged.ConcBySec[sec] {
				merged.ConcBySec[sec] = v
			}
		}
		if st.HasData && (!merged.HasData || st.FirstMs < merged.FirstMs) {
			merged.FirstMs = st.FirstMs
		}
		if st.HasData && st.LastMs > merged.LastMs {
			merged.LastMs = st.LastMs
		}
		if st.HasData {
			merged.HasData = true
		}
		if st.MaxSec > merged.MaxSec {
			merged.MaxSec = st.MaxSec
		}
		if st.MaxConcurrency > merged.MaxConcurrency {
			merged.MaxConcurrency = st.MaxConcurrency
		}
	}
	return merged
}

func aggregateState(st *ModelState, maxSec int, canceled int) Aggregate {
	elapsed := st.elapsedMs()
	agg := Aggregate{
		Total:       st.Total,
		Success:     st.Success,
		Failed:      st.Failed,
		Canceled:    canceled,
		ElapsedMs:   elapsed,
		Latency:     computeStats(st.Latencies),
		TTFT:        computeStats(st.TTFTs),
		Tokens:      tokenStats(st),
		StatusCodes: statusCodes(st.StatusCodes),
		Errors:      errorGroups(st.Errors),
		Series:      buildSeries(st, maxSec),
		Histogram:   buildHistogram(st.Latencies),
	}
	if st.Total > 0 {
		agg.SuccessRate = round2(float64(st.Success) / float64(st.Total) * 100)
		agg.ErrorRate = round2(float64(st.Failed) / float64(st.Total) * 100)
	}
	secs := float64(elapsed) / 1000
	if secs < 0.001 {
		secs = 0.001
	}
	agg.QPS = round2(float64(st.Success) / secs)
	return agg
}

func tokenStats(st *ModelState) TokenStats {
	ts := TokenStats{
		Prompt:     st.PromptTokens,
		Completion: st.CompletionTokens,
		Total:      st.PromptTokens + st.CompletionTokens,
		Estimated:  st.EstimatedTokens,
	}
	if st.TokenCount > 0 {
		ts.AvgCompletion = round2(float64(st.CompletionTokens) / float64(st.TokenCount))
	}
	if st.TPSCount > 0 {
		ts.AvgTokensPerSec = round2(st.TPSum / float64(st.TPSCount))
	}
	return ts
}

func statusCodes(m map[int]int) []StatusCount {
	out := make([]StatusCount, 0, len(m))
	for code, count := range m {
		out = append(out, StatusCount{Code: code, Count: count})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count == out[j].Count {
			return out[i].Code < out[j].Code
		}
		return out[i].Count > out[j].Count
	})
	return out
}

func errorGroups(m map[string]*ErrorGroup) []ErrorGroup {
	out := make([]ErrorGroup, 0, len(m))
	for _, g := range m {
		gc := *g
		sort.Ints(gc.Statuses)
		out = append(out, gc)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count == out[j].Count {
			return out[i].FirstAtMs < out[j].FirstAtMs
		}
		return out[i].Count > out[j].Count
	})
	if len(out) > 60 {
		out = out[:60]
	}
	return out
}

func appendUniqueInt(s []int, v int) []int {
	for _, x := range s {
		if x == v {
			return s
		}
	}
	return append(s, v)
}

func appendUniqueString(s []string, v string) []string {
	if v == "" {
		return s
	}
	for _, x := range s {
		if x == v {
			return s
		}
	}
	return append(s, v)
}

func errorSignature(message string) string {
	message = strings.TrimSpace(message)
	if message == "" {
		return "unknown"
	}
	line := message
	if idx := strings.IndexAny(line, "\r\n"); idx >= 0 {
		line = line[:idx]
	}
	return truncateRunes(line, 120)
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// inferProtocol maps a model id to the most likely native protocol.
func inferProtocol(force, model string) string {
	switch force {
	case ProtoOpenAI, ProtoClaude, ProtoGemini:
		return force
	}
	m := strings.ToLower(model)
	switch {
	case strings.Contains(m, "claude"):
		return ProtoClaude
	case strings.Contains(m, "gemini"), strings.Contains(m, "learnlm"):
		return ProtoGemini
	default:
		return ProtoOpenAI
	}
}
