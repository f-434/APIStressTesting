package bench

import (
	"context"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

const maxTotalResults = 100000

type Runner struct {
	Store *Store
}

func NewRunner(store *Store) *Runner {
	return &Runner{Store: store}
}

func (r *Runner) Start(cfg TestConfig) (*Test, error) {
	cfg.ApplyDefaults()
	if _, err := NormalizeRoot(cfg.BaseURL); err != nil {
		return nil, err
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}

	t := NewTest(cfg.Sanitized())
	planned := 0
	if cfg.Mode == ModeFixed {
		planned = len(cfg.Models) * cfg.TotalRequests
	}
	t.SetPlanned(planned, cfg.DurationSec, cfg.Mode)

	ctx, cancel := context.WithCancel(context.Background())
	t.SetCancel(cancel)
	r.Store.Add(t)
	go r.execute(ctx, t, cfg)
	return t, nil
}

func (r *Runner) execute(ctx context.Context, t *Test, cfg TestConfig) {
	stopUpdates := make(chan struct{})
	var updateWG sync.WaitGroup
	updateWG.Add(1)
	go func() {
		defer updateWG.Done()
		ticker := time.NewTicker(400 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				t.PublishLive()
			case <-stopUpdates:
				return
			}
		}
	}()

	status := StatusCompleted
	errMsg := ""

loop:
	for i, model := range cfg.Models {
		if ctx.Err() != nil {
			status = StatusStopped
			break
		}
		protocol := inferProtocol(cfg.Protocol, model)
		target, err := NewTarget(cfg, model, protocol)
		if err != nil {
			status = StatusFailed
			errMsg = err.Error()
			break
		}
		t.SetPhase(i, model, protocol, target.Endpoint(), cfg.Concurrency, len(cfg.Models))

		client := newHTTPClient(cfg.Concurrency)

		switch cfg.Mode {
		case ModeFixed:
			r.runFixed(ctx, t, target, client, cfg, cfg.TotalRequests)
		case ModeDuration:
			r.runDuration(ctx, t, target, client, cfg, cfg.Concurrency, cfg.DurationSec)
		case ModeRamp:
			r.runRamp(ctx, t, target, client, cfg)
		}

		client.CloseIdleConnections()

		if t.ResultCount() >= maxTotalResults {
			status = StatusStopped
			errMsg = "已达到单次测试 100000 条请求上限，测试提前结束"
			break loop
		}
		if ctx.Err() != nil {
			status = StatusStopped
			break loop
		}
	}

	close(stopUpdates)
	updateWG.Wait()

	if status == StatusCompleted && t.ResultCount() == 0 {
		status = StatusFailed
		if errMsg == "" {
			errMsg = "未执行任何请求，请检查配置"
		}
	}
	t.Finish(status, errMsg)
}

func (r *Runner) runFixed(ctx context.Context, t *Test, target *Target, client *http.Client, cfg TestConfig, total int) {
	jobs := make(chan struct{})
	var wg sync.WaitGroup
	var seq atomic.Int64

	for w := 0; w < cfg.Concurrency; w++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for range jobs {
				if ctx.Err() != nil || t.ResultCount() >= maxTotalResults {
					return
				}
				offset := time.Since(t.StartedAt).Milliseconds()
				res := target.Run(ctx, client, int(seq.Add(1))-1, worker, cfg.Concurrency, offset)
				if res.ErrorType == "canceled" {
					return
				}
				t.AddResult(res)
			}
		}(w)
	}

feed:
	for i := 0; i < total; i++ {
		select {
		case jobs <- struct{}{}:
		case <-ctx.Done():
			break feed
		}
	}
	close(jobs)
	wg.Wait()
}

func (r *Runner) runDuration(ctx context.Context, t *Test, target *Target, client *http.Client, cfg TestConfig, concurrency, seconds int) {
	if seconds <= 0 {
		return
	}
	deadline := time.Now().Add(time.Duration(seconds) * time.Second)
	var wg sync.WaitGroup
	var seq atomic.Int64

	for w := 0; w < concurrency; w++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for {
				if ctx.Err() != nil || time.Now().After(deadline) || t.ResultCount() >= maxTotalResults {
					return
				}
				offset := time.Since(t.StartedAt).Milliseconds()
				res := target.Run(ctx, client, int(seq.Add(1))-1, worker, concurrency, offset)
				if res.ErrorType == "canceled" {
					return
				}
				t.AddResult(res)
			}
		}(w)
	}
	wg.Wait()
}

func (r *Runner) runRamp(ctx context.Context, t *Test, target *Target, client *http.Client, cfg TestConfig) {
	for level := cfg.RampStart; level <= cfg.RampEnd; level += cfg.RampStep {
		if ctx.Err() != nil {
			return
		}
		t.SetConcurrency(level)
		r.runDuration(ctx, t, target, client, cfg, level, cfg.RampStepSec)
		if ctx.Err() != nil || t.ResultCount() >= maxTotalResults {
			return
		}
	}
}

func newHTTPClient(concurrency int) *http.Client {
	maxIdle := concurrency * 2
	if maxIdle < 20 {
		maxIdle = 20
	}
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   15 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          maxIdle * 2,
		MaxIdleConnsPerHost:   maxIdle,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	return &http.Client{Transport: transport}
}
