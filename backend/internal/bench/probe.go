package bench

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const maxResponseBytes = 32 << 20

// NormalizeRoot converts a user supplied base URL into a scheme://host[/prefix]
// root without the trailing /v1 or /v1beta segment.
func NormalizeRoot(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("接口根地址不能为空")
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("接口地址无效：%v", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("仅支持 http / https 协议")
	}
	if u.Host == "" {
		return "", fmt.Errorf("接口地址缺少主机名")
	}
	path := strings.TrimSuffix(u.Path, "/")
	lower := strings.ToLower(path)
	suffixes := []string{
		"/v1/chat/completions",
		"/v1/messages",
		"/v1/completions",
		"/v1/responses",
		"/v1/embeddings",
		"/v1/models",
		"/v1beta/models",
	}
	for _, s := range suffixes {
		if strings.HasSuffix(lower, s) {
			path = path[:len(path)-len(s)]
			lower = lower[:len(lower)-len(s)]
			break
		}
	}
	for _, v := range []string{"/v1beta", "/v1"} {
		if strings.HasSuffix(lower, v) {
			path = strings.TrimSuffix(path, v)
			break
		}
	}
	path = strings.TrimSuffix(path, "/")
	u.Path = path
	u.RawQuery = ""
	u.Fragment = ""
	return strings.TrimSuffix(u.String(), "/"), nil
}

type Target struct {
	Root         string
	Key          string
	Protocol     string
	Model        string
	Stream       bool
	SystemPrompt string
	Prompt       string
	MaxTokens    int
	Temperature  *float64
	TopP         *float64
	Timeout      time.Duration
}

func NewTarget(cfg TestConfig, model, protocol string) (*Target, error) {
	root, err := NormalizeRoot(cfg.BaseURL)
	if err != nil {
		return nil, err
	}
	return &Target{
		Root:         root,
		Key:          cfg.APIKey,
		Protocol:     protocol,
		Model:        model,
		Stream:       cfg.Stream,
		SystemPrompt: cfg.SystemPrompt,
		Prompt:       cfg.Prompt,
		MaxTokens:    cfg.MaxTokens,
		Temperature:  cfg.Temperature,
		TopP:         cfg.TopP,
		Timeout:      time.Duration(cfg.TimeoutMs) * time.Millisecond,
	}, nil
}

func geminiModelPath(model string) string {
	m := strings.TrimPrefix(model, "models/")
	return url.PathEscape(m)
}

func (t *Target) Endpoint() string {
	switch t.Protocol {
	case ProtoClaude:
		return t.Root + "/v1/messages"
	case ProtoGemini:
		if t.Stream {
			return t.Root + "/v1beta/models/" + geminiModelPath(t.Model) + ":streamGenerateContent?alt=sse"
		}
		return t.Root + "/v1beta/models/" + geminiModelPath(t.Model) + ":generateContent"
	default:
		return t.Root + "/v1/chat/completions"
	}
}

func (t *Target) buildBody() ([]byte, error) {
	var payload any
	switch t.Protocol {
	case ProtoClaude:
		body := map[string]any{
			"model":      t.Model,
			"max_tokens": t.MaxTokens,
			"messages": []map[string]any{
				{"role": "user", "content": t.Prompt},
			},
			"stream": t.Stream,
		}
		if t.SystemPrompt != "" {
			body["system"] = t.SystemPrompt
		}
		if t.Temperature != nil {
			body["temperature"] = *t.Temperature
		}
		if t.TopP != nil {
			body["top_p"] = *t.TopP
		}
		payload = body

	case ProtoGemini:
		gen := map[string]any{"maxOutputTokens": t.MaxTokens}
		if t.Temperature != nil {
			gen["temperature"] = *t.Temperature
		}
		if t.TopP != nil {
			gen["topP"] = *t.TopP
		}
		body := map[string]any{
			"contents": []map[string]any{
				{
					"role":  "user",
					"parts": []map[string]any{{"text": t.Prompt}},
				},
			},
			"generationConfig": gen,
		}
		if t.SystemPrompt != "" {
			body["systemInstruction"] = map[string]any{
				"parts": []map[string]any{{"text": t.SystemPrompt}},
			}
		}
		payload = body

	default:
		messages := make([]map[string]any, 0, 2)
		if t.SystemPrompt != "" {
			messages = append(messages, map[string]any{"role": "system", "content": t.SystemPrompt})
		}
		messages = append(messages, map[string]any{"role": "user", "content": t.Prompt})
		body := map[string]any{
			"model":    t.Model,
			"messages": messages,
			"stream":   t.Stream,
		}
		if isReasoningModel(t.Model) {
			body["max_completion_tokens"] = t.MaxTokens
		} else {
			body["max_tokens"] = t.MaxTokens
			if t.Temperature != nil {
				body["temperature"] = *t.Temperature
			}
			if t.TopP != nil {
				body["top_p"] = *t.TopP
			}
		}
		if t.Stream {
			body["stream_options"] = map[string]any{"include_usage": true}
		}
		payload = body
	}
	return json.Marshal(payload)
}

func isReasoningModel(model string) bool {
	m := strings.ToLower(model)
	return strings.HasPrefix(m, "o1") || strings.HasPrefix(m, "o3") ||
		strings.HasPrefix(m, "o4") || strings.Contains(m, "gpt-5")
}

func (t *Target) setHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("User-Agent", "llm-stress-lab/1.0")
	switch t.Protocol {
	case ProtoClaude:
		req.Header.Set("x-api-key", t.Key)
		req.Header.Set("anthropic-version", "2023-06-01")
		req.Header.Set("Authorization", "Bearer "+t.Key)
	case ProtoGemini:
		req.Header.Set("x-goog-api-key", t.Key)
		req.Header.Set("Authorization", "Bearer "+t.Key)
	default:
		req.Header.Set("Authorization", "Bearer "+t.Key)
	}
}

type parsedResponse struct {
	text             string
	promptTokens     int
	completionTokens int
	totalTokens      int
	source           string
	finishReason     string
	errType          string
	errMsg           string
	hasPayload       bool
}

// Run executes one request and returns the measured result.
func (t *Target) Run(parent context.Context, client *http.Client, index, worker, conc int, offsetMs int64) RequestResult {
	res := RequestResult{
		Index:         index,
		Model:         t.Model,
		Protocol:      t.Protocol,
		Endpoint:      t.Endpoint(),
		Worker:        worker,
		Concurrency:   conc,
		StartOffsetMs: offsetMs,
		TokenSource:   "none",
	}
	body, err := t.buildBody()
	if err != nil {
		res.ErrorType = "request"
		res.ErrorMessage = "构造请求失败：" + err.Error()
		return res
	}
	res.RequestBytes = len(body)

	ctx, cancel := context.WithTimeout(parent, t.Timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, res.Endpoint, bytes.NewReader(body))
	if err != nil {
		res.ErrorType = "request"
		res.ErrorMessage = "构造请求失败：" + err.Error()
		return res
	}
	t.setHeaders(req)

	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		res.LatencyMs = msSince(start)
		res.TTFTMs = res.LatencyMs
		res.ErrorType, res.ErrorMessage = classifyTransportError(err)
		return res
	}
	defer resp.Body.Close()

	res.Status = resp.StatusCode
	res.RequestID = requestIDFromHeader(resp.Header)
	counter := &countingReader{r: io.LimitReader(resp.Body, maxResponseBytes)}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		errBody, _ := io.ReadAll(counter)
		res.ResponseBytes = counter.n
		res.LatencyMs = msSince(start)
		res.TTFTMs = res.LatencyMs
		res.ErrorType, res.ErrorMessage = classifyHTTPError(resp.StatusCode, errBody)
		return res
	}

	var parsed parsedResponse
	var ttft time.Duration
	if t.Stream {
		parsed, ttft = t.parseSSE(counter, start)
	} else {
		raw, readErr := io.ReadAll(counter)
		if readErr != nil {
			res.ResponseBytes = counter.n
			res.LatencyMs = msSince(start)
			res.TTFTMs = res.LatencyMs
			res.ErrorType, res.ErrorMessage = classifyTransportError(readErr)
			return res
		}
		parsed = t.parseNonStream(raw)
	}

	res.ResponseBytes = counter.n
	res.LatencyMs = msSince(start)

	// A request interrupted because the test was stopped must not be counted as
	// an API failure. The runner drops results marked as canceled.
	if parent.Err() != nil && parsed.errMsg != "" {
		res.OK = false
		res.ErrorType = "canceled"
		res.ErrorMessage = "测试停止，请求已取消"
		res.TTFTMs = res.LatencyMs
		return res
	}

	if ttft > 0 {
		res.TTFTMs = msSinceTime(time.Duration(ttft))
	} else {
		res.TTFTMs = res.LatencyMs
	}

	if parsed.errMsg != "" {
		res.OK = false
		res.ErrorType = parsed.errType
		if res.ErrorType == "" {
			res.ErrorType = "api"
		}
		res.ErrorMessage = parsed.errMsg
		res.FinishReason = parsed.finishReason
		res.ResponsePreview = previewText(parsed.text, 600)
		res.OutputChars = utf8.RuneCountInString(parsed.text)
		applyTokens(&res, parsed, t)
		return res
	}

	if !parsed.hasPayload && parsed.text == "" && parsed.promptTokens == 0 && parsed.completionTokens == 0 {
		res.OK = false
		res.ErrorType = "protocol"
		res.ErrorMessage = "HTTP 200，但未解析到有效的模型响应数据，请确认接口协议与模型是否匹配"
		return res
	}

	res.OK = true
	res.FinishReason = parsed.finishReason
	res.ResponsePreview = previewText(parsed.text, 600)
	res.OutputChars = utf8.RuneCountInString(parsed.text)
	applyTokens(&res, parsed, t)
	return res
}

func applyTokens(res *RequestResult, parsed parsedResponse, t *Target) {
	prompt := parsed.promptTokens
	completion := parsed.completionTokens
	total := parsed.totalTokens
	source := parsed.source

	if source != "usage" {
		prompt = EstimateTokens(t.SystemPrompt) + EstimateTokens(t.Prompt) + 6
		completion = EstimateTokens(parsed.text)
		total = prompt + completion
		source = "estimated"
	}
	if total <= 0 {
		total = prompt + completion
	}
	res.PromptTokens = prompt
	res.CompletionTokens = completion
	res.TotalTokens = total
	res.TokenSource = source

	if completion > 0 {
		genMs := res.LatencyMs - res.TTFTMs
		if genMs <= 0 {
			genMs = res.LatencyMs
		}
		if genMs > 0 {
			res.TokensPerSec = round2(float64(completion) / (genMs / 1000))
		}
	}
}

func (t *Target) parseNonStream(raw []byte) parsedResponse {
	if msg := detectErrorPayload(raw); msg != "" {
		return parsedResponse{errType: "api", errMsg: "接口返回错误：" + msg, hasPayload: true}
	}
	switch t.Protocol {
	case ProtoClaude:
		return parseClaudeResponse(raw)
	case ProtoGemini:
		return parseGeminiResponse(raw)
	default:
		return parseOpenAIResponse(raw)
	}
}

type oaiUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
	InputTokens      int `json:"input_tokens"`
	OutputTokens     int `json:"output_tokens"`
}

func (u *oaiUsage) values() (int, int, int) {
	p, c := u.PromptTokens, u.CompletionTokens
	if p == 0 && u.InputTokens > 0 {
		p = u.InputTokens
	}
	if c == 0 && u.OutputTokens > 0 {
		c = u.OutputTokens
	}
	total := u.TotalTokens
	if total == 0 {
		total = p + c
	}
	return p, c, total
}

func parseOpenAIResponse(raw []byte) parsedResponse {
	var payload struct {
		Choices []struct {
			Message struct {
				Content          json.RawMessage `json:"content"`
				ReasoningContent json.RawMessage `json:"reasoning_content"`
				Reasoning        json.RawMessage `json:"reasoning"`
			} `json:"message"`
			Text         string `json:"text"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage *oaiUsage `json:"usage"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return parsedResponse{errType: "parse", errMsg: "响应解析失败：" + err.Error()}
	}
	text := ""
	finish := ""
	for _, ch := range payload.Choices {
		if t := extractText(ch.Message.Content); t != "" {
			text += t
		}
		if r := extractText(ch.Message.ReasoningContent); r != "" {
			text += r
		} else if r := extractText(ch.Message.Reasoning); r != "" {
			text += r
		}
		if ch.Text != "" {
			text += ch.Text
		}
		if ch.FinishReason != "" {
			finish = ch.FinishReason
		}
	}
	out := parsedResponse{text: text, finishReason: finish, hasPayload: true}
	if payload.Usage != nil {
		p, c, total := payload.Usage.values()
		if p > 0 || c > 0 {
			out.promptTokens, out.completionTokens, out.totalTokens = p, c, total
			out.source = "usage"
		}
	}
	return out
}

type claudeUsage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
}

func parseClaudeResponse(raw []byte) parsedResponse {
	var payload struct {
		Type    string `json:"type"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		Usage      claudeUsage `json:"usage"`
		StopReason string      `json:"stop_reason"`
		Error      *struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return parsedResponse{errType: "parse", errMsg: "响应解析失败：" + err.Error()}
	}
	if payload.Error != nil || payload.Type == "error" {
		msg := "未知错误"
		if payload.Error != nil && payload.Error.Message != "" {
			msg = payload.Error.Message
		}
		return parsedResponse{errType: "api", errMsg: "接口返回错误：" + msg, hasPayload: true}
	}
	var sb strings.Builder
	for _, c := range payload.Content {
		if c.Type == "text" || c.Type == "" {
			sb.WriteString(c.Text)
		}
	}
	out := parsedResponse{text: sb.String(), finishReason: payload.StopReason, hasPayload: true}
	p := payload.Usage.InputTokens + payload.Usage.CacheReadInputTokens + payload.Usage.CacheCreationInputTokens
	c := payload.Usage.OutputTokens
	if p > 0 || c > 0 {
		out.promptTokens, out.completionTokens, out.totalTokens = p, c, p+c
		out.source = "usage"
	}
	return out
}

type geminiUsage struct {
	PromptTokenCount        int `json:"promptTokenCount"`
	CandidatesTokenCount    int `json:"candidatesTokenCount"`
	TotalTokenCount         int `json:"totalTokenCount"`
	ThoughtsTokenCount      int `json:"thoughtsTokenCount"`
	CachedContentTokenCount int `json:"cachedContentTokenCount"`
}

func (u *geminiUsage) values() (int, int, int) {
	p := u.PromptTokenCount
	c := u.CandidatesTokenCount + u.ThoughtsTokenCount
	total := u.TotalTokenCount
	if total == 0 {
		total = p + c
	}
	return p, c, total
}

func parseGeminiResponse(raw []byte) parsedResponse {
	var payload struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
			FinishReason string `json:"finishReason"`
		} `json:"candidates"`
		UsageMetadata  *geminiUsage `json:"usageMetadata"`
		PromptFeedback *struct {
			BlockReason string `json:"blockReason"`
		} `json:"promptFeedback"`
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
			Status  string `json:"status"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return parsedResponse{errType: "parse", errMsg: "响应解析失败：" + err.Error()}
	}
	if payload.Error != nil {
		return parsedResponse{errType: "api", errMsg: "接口返回错误：" + payload.Error.Message, hasPayload: true}
	}
	var sb strings.Builder
	finish := ""
	for _, c := range payload.Candidates {
		for _, p := range c.Content.Parts {
			sb.WriteString(p.Text)
		}
		if c.FinishReason != "" {
			finish = c.FinishReason
		}
	}
	if payload.PromptFeedback != nil && payload.PromptFeedback.BlockReason != "" {
		return parsedResponse{
			errType:    "api",
			errMsg:     "内容被拦截：" + payload.PromptFeedback.BlockReason,
			hasPayload: true,
		}
	}
	out := parsedResponse{text: sb.String(), finishReason: finish, hasPayload: true}
	if payload.UsageMetadata != nil {
		p, c, total := payload.UsageMetadata.values()
		if p > 0 || c > 0 {
			out.promptTokens, out.completionTokens, out.totalTokens = p, c, total
			out.source = "usage"
		}
	}
	return out
}

func (t *Target) parseSSE(body io.Reader, start time.Time) (parsedResponse, time.Duration) {
	reader := bufio.NewReaderSize(body, 64*1024)
	out := parsedResponse{}
	var ttft time.Duration
	var fallback bytes.Buffer
	sseSeen := false

	for {
		line, err := reader.ReadString('\n')
		if len(line) > 0 {
			trimmed := strings.TrimRight(line, "\r\n")
			lower := strings.ToLower(trimmed)
			switch {
			case strings.HasPrefix(lower, "data:"):
				sseSeen = true
				payload := strings.TrimSpace(trimmed[len("data:"):])
				if payload != "" {
					if payload == "[DONE]" {
						return finalizeParsed(out, fallback.Bytes(), sseSeen, t), ttft
					}
					switch t.Protocol {
					case ProtoClaude:
						applyClaudeChunk(&out, payload, start, &ttft)
					case ProtoGemini:
						applyGeminiChunk(&out, payload, start, &ttft)
					default:
						applyOpenAIChunk(&out, payload, start, &ttft)
					}
				}
			case strings.HasPrefix(lower, "event:"), strings.HasPrefix(trimmed, ":"), trimmed == "":
				// SSE framing, ignore.
			default:
				if !sseSeen && fallback.Len() < 2<<20 {
					fallback.WriteString(line)
				}
			}
		}
		if err != nil {
			if err != io.EOF {
				if out.errMsg == "" {
					out.errType = "stream"
					out.errMsg = "流式读取中断：" + err.Error()
				}
			}
			break
		}
	}

	if !sseSeen && fallback.Len() > 0 {
		raw := fallback.Bytes()
		parsed := t.parseNonStream(raw)
		return parsed, 0
	}
	return finalizeParsed(out, nil, sseSeen, t), ttft
}

func finalizeParsed(out parsedResponse, fallback []byte, sseSeen bool, t *Target) parsedResponse {
	if !sseSeen && len(fallback) > 0 {
		return t.parseNonStream(fallback)
	}
	if out.source != "usage" && (out.promptTokens == 0 && out.completionTokens == 0) {
		out.source = "estimated"
	}
	return out
}

func applyOpenAIChunk(out *parsedResponse, payload string, start time.Time, ttft *time.Duration) {
	if msg := detectErrorPayload([]byte(payload)); msg != "" {
		out.errType = "api"
		out.errMsg = "接口返回错误：" + msg
		out.hasPayload = true
		return
	}
	var chunk struct {
		Choices []struct {
			Delta struct {
				Content          json.RawMessage `json:"content"`
				ReasoningContent json.RawMessage `json:"reasoning_content"`
				Reasoning        json.RawMessage `json:"reasoning"`
			} `json:"delta"`
			FinishReason *string `json:"finish_reason"`
		} `json:"choices"`
		Usage *oaiUsage `json:"usage"`
	}
	if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
		return
	}
	out.hasPayload = true
	for _, ch := range chunk.Choices {
		text := extractText(ch.Delta.Content)
		if text == "" {
			text = extractText(ch.Delta.ReasoningContent)
		}
		if text == "" {
			text = extractText(ch.Delta.Reasoning)
		}
		if text != "" {
			if *ttft == 0 {
				*ttft = time.Since(start)
			}
			out.text += text
		}
		if ch.FinishReason != nil && *ch.FinishReason != "" {
			out.finishReason = *ch.FinishReason
		}
	}
	if chunk.Usage != nil {
		p, c, total := chunk.Usage.values()
		if p > 0 || c > 0 {
			out.promptTokens, out.completionTokens, out.totalTokens = p, c, total
			out.source = "usage"
		}
	}
}

func applyClaudeChunk(out *parsedResponse, payload string, start time.Time, ttft *time.Duration) {
	var ev struct {
		Type    string `json:"type"`
		Message struct {
			Usage claudeUsage `json:"usage"`
		} `json:"message"`
		Delta struct {
			Type       string `json:"type"`
			Text       string `json:"text"`
			StopReason string `json:"stop_reason"`
		} `json:"delta"`
		Usage claudeUsage `json:"usage"`
		Error *struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(payload), &ev); err != nil {
		return
	}
	out.hasPayload = true
	if ev.Error != nil {
		out.errType = "api"
		out.errMsg = "接口返回错误：" + ev.Error.Message
		return
	}
	switch ev.Type {
	case "message_start":
		u := ev.Message.Usage
		p := u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens
		if p > 0 {
			out.promptTokens = p
			out.source = "usage"
		}
	case "content_block_delta":
		if ev.Delta.Text != "" {
			if *ttft == 0 {
				*ttft = time.Since(start)
			}
			out.text += ev.Delta.Text
		}
	case "message_delta":
		if ev.Usage.OutputTokens > 0 {
			out.completionTokens = ev.Usage.OutputTokens
			out.source = "usage"
		}
		if ev.Delta.StopReason != "" {
			out.finishReason = ev.Delta.StopReason
		}
	case "error":
		out.errType = "api"
		out.errMsg = "接口返回流式错误"
	}
}

func applyGeminiChunk(out *parsedResponse, payload string, start time.Time, ttft *time.Duration) {
	if msg := detectErrorPayload([]byte(payload)); msg != "" {
		out.errType = "api"
		out.errMsg = "接口返回错误：" + msg
		out.hasPayload = true
		return
	}
	var chunk struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
			FinishReason string `json:"finishReason"`
		} `json:"candidates"`
		UsageMetadata *geminiUsage `json:"usageMetadata"`
	}
	if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
		return
	}
	out.hasPayload = true
	for _, c := range chunk.Candidates {
		for _, p := range c.Content.Parts {
			if p.Text != "" {
				if *ttft == 0 {
					*ttft = time.Since(start)
				}
				out.text += p.Text
			}
		}
		if c.FinishReason != "" {
			out.finishReason = c.FinishReason
		}
	}
	if chunk.UsageMetadata != nil {
		p, c, total := chunk.UsageMetadata.values()
		if p > 0 || c > 0 {
			out.promptTokens, out.completionTokens, out.totalTokens = p, c, total
			out.source = "usage"
		}
	}
}

func extractText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		return ""
	}
	var str string
	if json.Unmarshal(raw, &str) == nil {
		return str
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		var sb strings.Builder
		for _, p := range parts {
			if p.Text != "" {
				sb.WriteString(p.Text)
			}
		}
		return sb.String()
	}
	return ""
}

func detectErrorPayload(raw []byte) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return ""
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &m); err != nil {
		return ""
	}
	if rawErr, ok := m["error"]; ok {
		v := strings.TrimSpace(string(rawErr))
		if v != "" && v != "null" {
			return messageFromErrorRaw(rawErr)
		}
	}
	if rawType, ok := m["type"]; ok {
		var t string
		if json.Unmarshal(rawType, &t) == nil && t == "error" {
			if rawMsg, ok := m["message"]; ok {
				var s string
				if json.Unmarshal(rawMsg, &s) == nil && s != "" {
					return s
				}
			}
		}
	}
	return ""
}

func messageFromErrorRaw(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var obj struct {
		Message string          `json:"message"`
		Code    json.RawMessage `json:"code"`
		Type    string          `json:"type"`
	}
	if json.Unmarshal(raw, &obj) == nil {
		if obj.Message != "" {
			return obj.Message
		}
		if obj.Type != "" {
			return obj.Type
		}
		var code string
		if len(obj.Code) > 0 && json.Unmarshal(obj.Code, &code) == nil && code != "" {
			return code
		}
	}
	return strings.TrimSpace(string(raw))
}

func extractErrMessage(body []byte) string {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return ""
	}
	if trimmed[0] == '{' {
		if msg := detectErrorPayload(trimmed); msg != "" {
			return truncateRunes(msg, 1200)
		}
		var m map[string]json.RawMessage
		if json.Unmarshal(trimmed, &m) == nil {
			for _, key := range []string{"message", "msg", "detail", "error_msg", "error_description"} {
				if raw, ok := m[key]; ok {
					var s string
					if json.Unmarshal(raw, &s) == nil && strings.TrimSpace(s) != "" {
						return truncateRunes(strings.TrimSpace(s), 1200)
					}
				}
			}
		}
	}
	text := stripHTML(string(trimmed))
	text = strings.Join(strings.Fields(text), " ")
	if text == "" {
		text = truncateRunes(string(trimmed), 1200)
	}
	return truncateRunes(text, 1200)
}

func stripHTML(s string) string {
	var sb strings.Builder
	inTag := false
	for _, r := range s {
		switch {
		case r == '<':
			inTag = true
		case r == '>':
			inTag = false
			sb.WriteByte(' ')
		case !inTag:
			sb.WriteRune(r)
		}
	}
	return sb.String()
}

func classifyHTTPError(status int, body []byte) (string, string) {
	msg := extractErrMessage(body)
	statusText := http.StatusText(status)
	prefix := fmt.Sprintf("HTTP %d", status)
	if statusText != "" {
		prefix += " " + statusText
	}
	if msg == "" {
		msg = "服务端未返回错误详情"
	}
	return "http", prefix + "：" + msg
}

func classifyTransportError(err error) (string, string) {
	if err == nil {
		return "network", "未知网络错误"
	}
	if errors.Is(err, context.Canceled) {
		return "canceled", "请求已取消"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout", "请求超时：" + err.Error()
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "timeout", "请求超时：" + err.Error()
	}
	return "network", "网络请求失败：" + err.Error()
}

func requestIDFromHeader(h http.Header) string {
	keys := []string{
		"x-oneapi-request-id",
		"x-request-id",
		"request-id",
		"x-amzn-requestid",
		"x-amzn-request-id",
		"cf-ray",
	}
	for _, k := range keys {
		if v := h.Get(k); v != "" {
			return v
		}
	}
	return ""
}

func previewText(s string, limit int) string {
	s = strings.Join(strings.Fields(s), " ")
	return truncateRunes(s, limit)
}

// EstimateTokens gives a rough token count when the API does not return usage.
func EstimateTokens(s string) int {
	if s == "" {
		return 0
	}
	var ascii, wide int
	for _, r := range s {
		switch {
		case r < 128:
			ascii++
		case r >= 0x2E80:
			wide++
		default:
			ascii += 2
		}
	}
	v := float64(ascii)/4 + float64(wide)
	if v < 1 {
		return 1
	}
	return int(math.Ceil(v))
}

type countingReader struct {
	r io.Reader
	n int
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += n
	return n, err
}

func msSince(t time.Time) float64 {
	return round2(float64(time.Since(t).Microseconds()) / 1000)
}

func msSinceTime(d time.Duration) float64 {
	return round2(float64(d.Microseconds()) / 1000)
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

func ModelsURL(cfg TestConfig) (string, error) {
	root, err := NormalizeRoot(cfg.BaseURL)
	if err != nil {
		return "", err
	}
	if cfg.Protocol == ProtoGemini {
		return root + "/v1beta/models", nil
	}
	return root + "/v1/models", nil
}

// FetchModels discovers available models using OpenAI, Anthropic or Gemini
// compatible listing endpoints.
func FetchModels(ctx context.Context, baseURL, apiKey, protocol string) ([]ModelInfo, string, []string, error) {
	root, err := NormalizeRoot(baseURL)
	if err != nil {
		return nil, "", nil, err
	}
	if strings.TrimSpace(apiKey) == "" {
		return nil, "", nil, fmt.Errorf("请填写 API 密钥")
	}
	client := &http.Client{Timeout: 25 * time.Second}
	var warnings []string

	type attempt struct {
		url     string
		headers map[string]string
		label   string
	}
	var attempts []attempt
	openaiAttempts := []attempt{
		{
			url:     root + "/v1/models",
			headers: map[string]string{"Authorization": "Bearer " + apiKey},
			label:   "OpenAI 兼容 /v1/models",
		},
		{
			url: root + "/v1/models",
			headers: map[string]string{
				"x-api-key":         apiKey,
				"anthropic-version": "2023-06-01",
				"Authorization":     "Bearer " + apiKey,
			},
			label: "Anthropic 风格 /v1/models",
		},
	}
	geminiAttempt := attempt{
		url: root + "/v1beta/models",
		headers: map[string]string{
			"x-goog-api-key": apiKey,
			"Authorization":  "Bearer " + apiKey,
		},
		label: "Gemini /v1beta/models",
	}

	switch protocol {
	case ProtoGemini:
		attempts = []attempt{geminiAttempt, openaiAttempts[0]}
	case ProtoClaude:
		attempts = []attempt{openaiAttempts[1], openaiAttempts[0], geminiAttempt}
	default:
		attempts = append(attempts, openaiAttempts...)
		attempts = append(attempts, geminiAttempt)
	}

	lastEndpoint := root + "/v1/models"
	for _, a := range attempts {
		models, msg, err := fetchModelList(ctx, client, a.url, a.headers)
		lastEndpoint = a.url
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("%s：%s", a.label, msg))
			continue
		}
		if len(models) == 0 {
			warnings = append(warnings, fmt.Sprintf("%s：返回了 0 个模型", a.label))
			continue
		}
		sort.Slice(models, func(i, j int) bool { return models[i].ID < models[j].ID })
		return models, a.url, warnings, nil
	}
	if len(warnings) == 0 {
		warnings = append(warnings, "未能从目标地址获取模型列表")
	}
	return nil, lastEndpoint, warnings, fmt.Errorf("获取模型列表失败：%s", strings.Join(warnings, "；"))
}

func fetchModelList(ctx context.Context, client *http.Client, endpoint string, headers map[string]string) ([]ModelInfo, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err.Error(), err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "llm-stress-lab/1.0")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, "网络请求失败：" + err.Error(), err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := extractErrMessage(body)
		if msg == "" {
			msg = http.StatusText(resp.StatusCode)
		}
		return nil, fmt.Sprintf("HTTP %d：%s", resp.StatusCode, msg), fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	models, err := parseModelList(body)
	if err != nil {
		return nil, err.Error(), err
	}
	return models, "", nil
}

func parseModelList(body []byte) ([]ModelInfo, error) {
	var payload struct {
		Data []struct {
			ID          string `json:"id"`
			OwnedBy     string `json:"owned_by"`
			DisplayName string `json:"display_name"`
		} `json:"data"`
		Models []struct {
			Name        string `json:"name"`
			DisplayName string `json:"displayName"`
			BaseModelID string `json:"baseModelId"`
		} `json:"models"`
		Error json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("模型列表解析失败：%v", err)
	}
	if len(payload.Error) > 0 && string(payload.Error) != "null" {
		return nil, fmt.Errorf("接口返回错误：%s", messageFromErrorRaw(payload.Error))
	}

	seen := make(map[string]bool)
	out := make([]ModelInfo, 0, len(payload.Data)+len(payload.Models))
	add := func(id, ownedBy, display string) {
		id = strings.TrimSpace(id)
		id = strings.TrimPrefix(id, "models/")
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		if !looksLikeChatModel(id) {
			return
		}
		if ownedBy == "" {
			ownedBy = display
		}
		out = append(out, ModelInfo{
			ID:       id,
			OwnedBy:  ownedBy,
			Protocol: inferProtocol(ProtoAuto, id),
		})
	}
	for _, m := range payload.Data {
		add(m.ID, m.OwnedBy, m.DisplayName)
	}
	for _, m := range payload.Models {
		name := m.Name
		if name == "" {
			name = m.BaseModelID
		}
		add(name, "", m.DisplayName)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func looksLikeChatModel(id string) bool {
	l := strings.ToLower(id)
	blocked := []string{
		"embedding", "embed-", "-embed", "whisper", "tts", "moderation",
		"rerank", "dall-e", "gpt-image", "imagen", "stable-diffusion",
		"text-to-speech", "speech-to-text", "transcribe", "sora",
	}
	for _, b := range blocked {
		if strings.Contains(l, b) {
			return false
		}
	}
	return true
}
