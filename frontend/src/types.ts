export type Protocol = 'auto' | 'openai' | 'claude' | 'gemini'
export type Mode = 'fixed' | 'duration' | 'ramp'
export type TestStatus = 'running' | 'completed' | 'stopped' | 'failed'

export interface TestConfig {
  baseUrl: string
  apiKey: string
  protocol: Protocol
  models: string[]
  systemPrompt: string
  prompt: string
  maxTokens: number
  temperature: number | null
  topP: number | null
  stream: boolean
  mode: Mode
  totalRequests: number
  durationSec: number
  rampStart: number
  rampEnd: number
  rampStep: number
  rampStepSec: number
  concurrency: number
  timeoutMs: number
}

export interface ModelInfo {
  id: string
  ownedBy?: string
  protocol: Protocol
}

export interface ModelsResponse {
  models: ModelInfo[]
  endpoint: string
  warnings?: string[]
  count: number
}

export interface Stats {
  count: number
  min: number
  max: number
  avg: number
  p50: number
  p90: number
  p95: number
  p99: number
  sum: number
}

export interface TokenStats {
  prompt: number
  completion: number
  total: number
  avgCompletion: number
  avgTokensPerSec: number
  estimated: number
}

export interface StatusCount {
  code: number
  count: number
}

export interface ErrorGroup {
  type: string
  message: string
  count: number
  statuses: number[]
  models: string[]
  firstAtMs: number
}

export interface SeriesPoint {
  sec: number
  started: number
  completed: number
  success: number
  failed: number
  avgLatency: number
  concurrency: number
}

export interface HistBucket {
  from: number
  to: number
  count: number
}

export interface RequestResult {
  index: number
  model: string
  protocol: string
  endpoint?: string
  worker: number
  concurrency: number
  startOffsetMs: number
  latencyMs: number
  ttftMs: number
  status: number
  ok: boolean
  promptTokens: number
  completionTokens: number
  totalTokens: number
  tokenSource: string
  outputChars: number
  tokensPerSec: number
  finishReason?: string
  responsePreview?: string
  errorType?: string
  errorMessage?: string
  requestId?: string
  requestBytes: number
  responseBytes: number
}

export interface Aggregate {
  total: number
  success: number
  failed: number
  canceled: number
  successRate: number
  errorRate: number
  qps: number
  elapsedMs: number
  latency: Stats
  ttft: Stats
  tokens: TokenStats
  statusCodes: StatusCount[]
  errors: ErrorGroup[]
  series: SeriesPoint[]
  histogram: HistBucket[]
}

export interface ModelReport {
  model: string
  protocol: string
  endpoint: string
  aggregate: Aggregate
  results: RequestResult[]
  resultsTruncated: boolean
}

export interface Report {
  id: string
  status: TestStatus
  createdAt: string
  startedAt: string
  finishedAt: string
  durationMs: number
  config: TestConfig
  totals: Aggregate
  models: ModelReport[]
  error?: string
}

export interface ModelLive {
  model: string
  protocol: string
  endpoint: string
  total: number
  success: number
  failed: number
  successRate: number
  qps: number
  latency: Stats
  ttft: Stats
  tokens: TokenStats
  concurrency: number
}

export interface LiveUpdate {
  testId: string
  status: TestStatus
  mode: Mode
  elapsedMs: number
  planned: number
  durationSec: number
  completed: number
  success: number
  failed: number
  successRate: number
  qps: number
  latency: Stats
  ttft: Stats
  tokens: TokenStats
  currentModel: string
  currentProtocol: string
  modelIndex: number
  modelCount: number
  currentConcurrency: number
  statusCodes: StatusCount[]
  errors: ErrorGroup[]
  series: SeriesPoint[]
  histogram: HistBucket[]
  models: ModelLive[]
  recent: RequestResult[]
  config: TestConfig
  error?: string
}

export interface TestSummary {
  id: string
  status: TestStatus
  createdAt: string
  durationMs: number
  models: string[]
  modelCount: number
  protocol: string
  mode: Mode
  total: number
  success: number
  failed: number
  successRate: number
  qps: number
  avgLatency: number
  p95: number
  elapsedMs: number
}

export interface TestResponse {
  status: TestStatus
  report?: Report
  live?: LiveUpdate
}

export function emptyStats(): Stats {
  return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0, sum: 0 }
}
