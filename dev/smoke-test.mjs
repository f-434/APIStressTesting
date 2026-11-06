// End-to-end smoke test against a running app + mock relay.
// Usage: node dev/smoke-test.mjs [appBase] [relayBase] [key]
const APP = process.argv[2] || 'http://127.0.0.1:8099'
const RELAY = process.argv[3] || 'http://127.0.0.1:9099'
const KEY = process.argv[4] || 'sk-test'

const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exitCode = 1
    throw new Error(msg)
  }
  console.log('ok:', msg)
}

async function post(path, body) {
  const res = await fetch(APP + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

const baseConfig = {
  baseUrl: RELAY,
  apiKey: KEY,
  protocol: 'auto',
  models: ['gpt-4o-mini', 'claude-sonnet-4-20250514', 'gemini-2.5-flash'],
  systemPrompt: '你是一个简洁的助手',
  prompt: '用一句话介绍你自己',
  maxTokens: 64,
  temperature: 0.7,
  topP: null,
  stream: true,
  mode: 'fixed',
  totalRequests: 6,
  durationSec: 30,
  rampStart: 1,
  rampEnd: 5,
  rampStep: 2,
  rampStepSec: 3,
  concurrency: 3,
  timeoutMs: 30000,
}

async function waitReport(id, timeoutMs = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${APP}/api/tests/${id}`)
    const data = await res.json()
    if (data.report) return data.report
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('report timeout')
}

async function main() {
  console.log('== models ==')
  const models = await post('/api/models', { baseUrl: RELAY, apiKey: KEY, protocol: 'auto' })
  assert(models.models.length >= 3, `model discovery returned ${models.models.length} models`)
  assert(models.models.every((m) => m.id && m.protocol), 'each model has id and protocol hint')

  console.log('== fixed mode, multi model, streaming ==')
  const started = await post('/api/tests', baseConfig)
  assert(started.id, 'test started')
  const report = await waitReport(started.id)
  assert(report.status === 'completed', `report status is ${report.status}`)
  assert(report.models.length === 3, 'three model reports present')
  assert(report.totals.total === 18, `total == 18 (got ${report.totals.total})`)
  assert(report.totals.success + report.totals.failed === report.totals.total, 'success + failed == total')
  assert(report.totals.successRate > 0, 'success rate computed')
  const byModel = Object.fromEntries(report.models.map((m) => [m.model, m]))
  assert(byModel['gpt-4o-mini'].protocol === 'openai', 'gpt uses openai protocol')
  assert(byModel['claude-sonnet-4-20250514'].protocol === 'claude', 'claude uses native protocol')
  assert(byModel['gemini-2.5-flash'].protocol === 'gemini', 'gemini uses native protocol')
  for (const m of report.models) {
    assert(m.aggregate.latency.count === 6, `${m.model} recorded 6 latencies`)
    assert(m.aggregate.ttft.avg > 0, `${m.model} has TTFT`)
    assert(m.aggregate.series.length > 0, `${m.model} has timeline series`)
    assert(m.results.length === 6, `${m.model} keeps 6 result rows`)
  }
  const failed = report.totals.failed
  if (failed > 0) {
    assert(report.totals.errors.length > 0, 'errors aggregated')
    const e = report.totals.errors[0]
    assert(e.message.includes('HTTP ') || e.message.length > 0, 'error message recorded')
    const withErr = report.models.flatMap((m) => m.results).find((r) => !r.ok)
    assert(withErr.errorMessage && withErr.errorMessage.length > 0, 'per-request error message retained')
  } else {
    console.log('ok: no failed requests this run (mock returns 8% 429 randomly)')
  }

  console.log('== duration mode + SSE + stop ==')
  const durationTest = await post('/api/tests', {
    ...baseConfig,
    models: ['claude-sonnet-4-20250514'],
    stream: false,
    mode: 'duration',
    durationSec: 60,
    concurrency: 2,
  })
  let events = 0
  let sawSnapshot = false
  const controller = new AbortController()
  const sse = fetch(`${APP}/api/tests/${durationTest.id}/events`, { signal: controller.signal })
  const sseRes = await sse
  assert(sseRes.headers.get('content-type')?.includes('text/event-stream'), 'SSE content type')
  const reader = sseRes.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const sseStart = Date.now()
  while (Date.now() - sseStart < 2500) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    if (buf.includes('event: snapshot')) sawSnapshot = true
    events = (buf.match(/event: update/g) || []).length
  }
  controller.abort()
  assert(sawSnapshot, 'received SSE snapshot')
  assert(events >= 1, `received live updates (${events})`)

  await post(`/api/tests/${durationTest.id}/stop`, {})
  const stopped = await waitReport(durationTest.id)
  assert(stopped.status === 'stopped', `stopped status (${stopped.status})`)
  assert(stopped.totals.total > 0, `stopped test kept ${stopped.totals.total} results`)
  const okResult = stopped.models[0].results.find((r) => r.ok)
  assert(okResult && okResult.tokenSource === 'usage', 'non-stream usage parsed')
  assert(stopped.totals.failed === 0, 'canceled in-flight requests are not counted as failures')

  console.log('== ramp mode ==')
  const rampTest = await post('/api/tests', {
    ...baseConfig,
    models: ['gemini-2.5-flash'],
    mode: 'ramp',
    rampStart: 1,
    rampEnd: 3,
    rampStep: 2,
    rampStepSec: 3,
    concurrency: 1,
  })
  const rampReport = await waitReport(rampTest.id, 90000)
  assert(rampReport.status === 'completed', 'ramp completed')
  const levels = new Set(rampReport.models[0].results.map((r) => r.concurrency))
  assert(levels.has(1) && levels.has(3), `ramp levels recorded: ${[...levels].join(',')}`)

  console.log('== history ==')
  const history = await (await fetch(`${APP}/api/tests`)).json()
  assert(history.tests.length >= 3, `history contains ${history.tests.length} tests`)
  assert(history.tests[0].id, 'history summary has id')

  console.log('\nALL SMOKE TESTS PASSED')
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
