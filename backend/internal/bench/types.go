package bench

import (
	"fmt"
	"strings"
	"time"
)

const (
	ProtoAuto   = "auto"
	ProtoOpenAI = "openai"
	ProtoClaude = "claude"
	ProtoGemini = "gemini"

	ModeFixed    = "fixed"
	ModeDuration = "duration"
	ModeRamp     = "ramp"

	StatusRunning   = "running"
	StatusCompleted = "completed"
	StatusStopped   = "stopped"
	StatusFailed    = "failed"
)

// TestConfig is the user supplied benchmark configuration.
type TestConfig struct {
	BaseURL string `json:"baseUrl"`
	APIKey  string `json:"apiKey"`

	Protocol string   `json:"protocol"` // auto | openai | claude | gemini
	Models   []string `json:"models"`

	SystemPrompt string   `json:"systemPrompt"`
	Prompt       string   `json:"prompt"`
	MaxTokens    int      `json:"maxTokens"`
	Temperature  *float64 `json:"temperature"`
	TopP         *float64 `json:"topP"`
	Stream       bool     `json:"stream"`

	Mode          string `json:"mode"` // fixed | duration | ramp
	TotalRequests int    `json:"totalRequests"`
	DurationSec   int    `json:"durationSec"`
	RampStart     int    `json:"rampStart"`
	RampEnd       int    `json:"rampEnd"`
	RampStep      int    `json:"rampStep"`
	RampStepSec   int    `json:"rampStepSec"`
	Concurrency   int    `json:"concurrency"`
	TimeoutMs     int    `json:"timeoutMs"`
}

func (c *TestConfig) ApplyDefaults() {
	if c.BaseURL != "" {
		c.BaseURL = strings.TrimSpace(c.BaseURL)
	}
	if c.Protocol == "" {
		c.Protocol = ProtoAuto
	}
	if c.Mode == "" {
		c.Mode = ModeFixed
	}
	if c.MaxTokens <= 0 {
		c.MaxTokens = 256
	}
	if c.Concurrency <= 0 {
		c.Concurrency = 5
	}
	if c.TimeoutMs <= 0 {
		c.TimeoutMs = 120000
	}
	if strings.TrimSpace(c.Prompt) == "" {
		c.Prompt = "请用三句话介绍你自己，并说明你最擅长的能力。"
	}
	switch c.Mode {
	case ModeFixed:
		if c.TotalRequests <= 0 {
			c.TotalRequests = 20
		}
	case ModeDuration:
		if c.DurationSec <= 0 {
			c.DurationSec = 30
		}
	case ModeRamp:
		if c.RampStart <= 0 {
			c.RampStart = 1
		}
		if c.RampEnd <= 0 {
			c.RampEnd = 10
		}
		if c.RampStep <= 0 {
			c.RampStep = 3
		}
		if c.RampStepSec <= 0 {
			c.RampStepSec = 10
		}
	}
	seen := make(map[string]bool, len(c.Models))
	models := make([]string, 0, len(c.Models))
	for _, m := range c.Models {
		m = strings.TrimSpace(m)
		if m == "" || seen[m] {
			continue
		}
		seen[m] = true
		models = append(models, m)
	}
	c.Models = models
}

func (c TestConfig) Validate() error {
	if c.BaseURL == "" {
		return fmt.Errorf("请填写 API 接口根地址")
	}
	if c.APIKey == "" {
		return fmt.Errorf("请填写 API 密钥")
	}
	if len(c.Models) == 0 {
		return fmt.Errorf("请至少选择一个测试模型")
	}
	switch c.Protocol {
	case ProtoAuto, ProtoOpenAI, ProtoClaude, ProtoGemini:
	default:
		return fmt.Errorf("不支持的接口协议：%s", c.Protocol)
	}
	if c.Concurrency < 1 || c.Concurrency > 100 {
		return fmt.Errorf("并发数需在 1 - 100 之间")
	}
	if c.MaxTokens < 1 || c.MaxTokens > 32000 {
		return fmt.Errorf("max_tokens 需在 1 - 32000 之间")
	}
	if c.Temperature != nil && (*c.Temperature < 0 || *c.Temperature > 2) {
		return fmt.Errorf("temperature 需在 0 - 2 之间")
	}
	if c.TopP != nil && (*c.TopP < 0 || *c.TopP > 1) {
		return fmt.Errorf("top_p 需在 0 - 1 之间")
	}
	if c.TimeoutMs < 1000 || c.TimeoutMs > 600000 {
		return fmt.Errorf("单请求超时需在 1 - 600 秒之间")
	}
	switch c.Mode {
	case ModeFixed:
		if c.TotalRequests < 1 || c.TotalRequests > 20000 {
			return fmt.Errorf("总请求数需在 1 - 20000 之间")
		}
		if len(c.Models)*c.TotalRequests > 30000 {
			return fmt.Errorf("全部模型的总请求数超过 30000，请减少模型数量或请求数")
		}
	case ModeDuration:
		if c.DurationSec < 5 || c.DurationSec > 3600 {
			return fmt.Errorf("压测时长需在 5 - 3600 秒之间")
		}
	case ModeRamp:
		if c.RampStart < 1 || c.RampStart > 100 {
			return fmt.Errorf("起始并发需在 1 - 100 之间")
		}
		if c.RampEnd < c.RampStart || c.RampEnd > 100 {
			return fmt.Errorf("结束并发需大于等于起始并发，且不超过 100")
		}
		if c.RampStep < 1 {
			return fmt.Errorf("并发步长至少为 1")
		}
		if c.RampStepSec < 3 || c.RampStepSec > 600 {
			return fmt.Errorf("每档持续时长需在 3 - 600 秒之间")
		}
	default:
		return fmt.Errorf("不支持的压测模式：%s", c.Mode)
	}
	return nil
}

func (c TestConfig) Sanitized() TestConfig {
	c.APIKey = MaskKey(c.APIKey)
	return c
}

func MaskKey(key string) string {
	key = strings.TrimSpace(key)
	if key == "" {
		return ""
	}
	runes := []rune(key)
	if len(runes) <= 8 {
		return "****"
	}
	return string(runes[:4]) + "****" + string(runes[len(runes)-4:])
}

// ModelInfo is a model discovered from the target endpoint.
type ModelInfo struct {
	ID       string `json:"id"`
	OwnedBy  string `json:"ownedBy,omitempty"`
	Protocol string `json:"protocol"`
}

// RequestResult captures a single completed request.
type RequestResult struct {
	Index       int    `json:"index"`
	Model       string `json:"model"`
	Protocol    string `json:"protocol"`
	Endpoint    string `json:"endpoint,omitempty"`
	Worker      int    `json:"worker"`
	Concurrency int    `json:"concurrency"`

	StartOffsetMs int64   `json:"startOffsetMs"`
	LatencyMs     float64 `json:"latencyMs"`
	TTFTMs        float64 `json:"ttftMs"`

	Status int  `json:"status"`
	OK     bool `json:"ok"`

	PromptTokens     int     `json:"promptTokens"`
	CompletionTokens int     `json:"completionTokens"`
	TotalTokens      int     `json:"totalTokens"`
	TokenSource      string  `json:"tokenSource"` // usage | estimated | none
	OutputChars      int     `json:"outputChars"`
	TokensPerSec     float64 `json:"tokensPerSec"`

	FinishReason    string `json:"finishReason,omitempty"`
	ResponsePreview string `json:"responsePreview,omitempty"`

	ErrorType    string `json:"errorType,omitempty"`
	ErrorMessage string `json:"errorMessage,omitempty"`

	RequestID     string `json:"requestId,omitempty"`
	RequestBytes  int    `json:"requestBytes"`
	ResponseBytes int    `json:"responseBytes"`
}

type Stats struct {
	Count int     `json:"count"`
	Min   float64 `json:"min"`
	Max   float64 `json:"max"`
	Avg   float64 `json:"avg"`
	P50   float64 `json:"p50"`
	P90   float64 `json:"p90"`
	P95   float64 `json:"p95"`
	P99   float64 `json:"p99"`
	Sum   float64 `json:"sum"`
}

type TokenStats struct {
	Prompt          int     `json:"prompt"`
	Completion      int     `json:"completion"`
	Total           int     `json:"total"`
	AvgCompletion   float64 `json:"avgCompletion"`
	AvgTokensPerSec float64 `json:"avgTokensPerSec"`
	Estimated       int     `json:"estimated"`
}

type StatusCount struct {
	Code  int `json:"code"`
	Count int `json:"count"`
}

type ErrorGroup struct {
	Type      string   `json:"type"`
	Message   string   `json:"message"`
	Count     int      `json:"count"`
	Statuses  []int    `json:"statuses"`
	Models    []string `json:"models"`
	FirstAtMs int64    `json:"firstAtMs"`
}

type SeriesPoint struct {
	Sec         int     `json:"sec"`
	Started     int     `json:"started"`
	Completed   int     `json:"completed"`
	Success     int     `json:"success"`
	Failed      int     `json:"failed"`
	AvgLatency  float64 `json:"avgLatency"`
	Concurrency int     `json:"concurrency"`
}

type HistBucket struct {
	From  float64 `json:"from"`
	To    float64 `json:"to"`
	Count int     `json:"count"`
}

type Aggregate struct {
	Total       int     `json:"total"`
	Success     int     `json:"success"`
	Failed      int     `json:"failed"`
	Canceled    int     `json:"canceled"`
	SuccessRate float64 `json:"successRate"`
	ErrorRate   float64 `json:"errorRate"`
	QPS         float64 `json:"qps"`
	ElapsedMs   int64   `json:"elapsedMs"`

	Latency Stats      `json:"latency"`
	TTFT    Stats      `json:"ttft"`
	Tokens  TokenStats `json:"tokens"`

	StatusCodes []StatusCount `json:"statusCodes"`
	Errors      []ErrorGroup  `json:"errors"`
	Series      []SeriesPoint `json:"series"`
	Histogram   []HistBucket  `json:"histogram"`
}

type ModelReport struct {
	Model            string          `json:"model"`
	Protocol         string          `json:"protocol"`
	Endpoint         string          `json:"endpoint"`
	Aggregate        Aggregate       `json:"aggregate"`
	Results          []RequestResult `json:"results"`
	ResultsTruncated bool            `json:"resultsTruncated"`
}

type Report struct {
	ID         string        `json:"id"`
	Status     string        `json:"status"`
	CreatedAt  time.Time     `json:"createdAt"`
	StartedAt  time.Time     `json:"startedAt"`
	FinishedAt time.Time     `json:"finishedAt"`
	DurationMs int64         `json:"durationMs"`
	Config     TestConfig    `json:"config"`
	Totals     Aggregate     `json:"totals"`
	Models     []ModelReport `json:"models"`
	Error      string        `json:"error,omitempty"`
}

type ModelLive struct {
	Model       string     `json:"model"`
	Protocol    string     `json:"protocol"`
	Endpoint    string     `json:"endpoint"`
	Total       int        `json:"total"`
	Success     int        `json:"success"`
	Failed      int        `json:"failed"`
	SuccessRate float64    `json:"successRate"`
	QPS         float64    `json:"qps"`
	Latency     Stats      `json:"latency"`
	TTFT        Stats      `json:"ttft"`
	Tokens      TokenStats `json:"tokens"`
	Concurrency int        `json:"concurrency"`
}

type LiveUpdate struct {
	TestID      string `json:"testId"`
	Status      string `json:"status"`
	Mode        string `json:"mode"`
	ElapsedMs   int64  `json:"elapsedMs"`
	Planned     int    `json:"planned"`
	DurationSec int    `json:"durationSec"`

	Completed   int     `json:"completed"`
	Success     int     `json:"success"`
	Failed      int     `json:"failed"`
	SuccessRate float64 `json:"successRate"`
	QPS         float64 `json:"qps"`

	Latency Stats      `json:"latency"`
	TTFT    Stats      `json:"ttft"`
	Tokens  TokenStats `json:"tokens"`

	CurrentModel       string `json:"currentModel"`
	CurrentProtocol    string `json:"currentProtocol"`
	ModelIndex         int    `json:"modelIndex"`
	ModelCount         int    `json:"modelCount"`
	CurrentConcurrency int    `json:"currentConcurrency"`

	StatusCodes []StatusCount   `json:"statusCodes"`
	Errors      []ErrorGroup    `json:"errors"`
	Series      []SeriesPoint   `json:"series"`
	Histogram   []HistBucket    `json:"histogram"`
	Models      []ModelLive     `json:"models"`
	Recent      []RequestResult `json:"recent"`
	Config      TestConfig      `json:"config"`
	Error       string          `json:"error,omitempty"`
}

type TestSummary struct {
	ID          string    `json:"id"`
	Status      string    `json:"status"`
	CreatedAt   time.Time `json:"createdAt"`
	DurationMs  int64     `json:"durationMs"`
	Models      []string  `json:"models"`
	ModelCount  int       `json:"modelCount"`
	Protocol    string    `json:"protocol"`
	Mode        string    `json:"mode"`
	Total       int       `json:"total"`
	Success     int       `json:"success"`
	Failed      int       `json:"failed"`
	SuccessRate float64   `json:"successRate"`
	QPS         float64   `json:"qps"`
	AvgLatency  float64   `json:"avgLatency"`
	P95         float64   `json:"p95"`
	ElapsedMs   int64     `json:"elapsedMs"`
}

type Event struct {
	Type string
	Data any
}
