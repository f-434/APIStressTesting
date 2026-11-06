import { useEffect, useMemo, useState } from 'react'
import { fetchModels, startTest } from '../api'
import type { Mode, ModelInfo, Protocol, TestConfig } from '../types'
import { modeLabel, protocolLabel } from '../format'
import { ModelPicker } from './ModelPicker'
import { Field, Icon, InlineError, Spinner, Switch } from './ui'

const STORAGE_KEY = 'llm-stress-lab:conn'

function inferProtocol(id: string): Protocol {
  const m = id.toLowerCase()
  if (m.includes('claude')) return 'claude'
  if (m.includes('gemini') || m.includes('learnlm')) return 'gemini'
  return 'openai'
}

function loadConn(): { baseUrl: string; protocol: Protocol } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return { baseUrl: parsed.baseUrl || '', protocol: parsed.protocol || 'auto' }
    }
  } catch {
    /* ignore */
  }
  return { baseUrl: '', protocol: 'auto' }
}

const MODES: { id: Mode; title: string; desc: string }[] = [
  { id: 'fixed', title: '固定请求数', desc: '跑满指定请求数后结束' },
  { id: 'duration', title: '按时长压测', desc: '在指定时长内持续发压' },
  { id: 'ramp', title: '阶梯并发', desc: '逐档提升并发，观察拐点' },
]

export function ConfigPage({ onStart }: { onStart: (id: string) => void }) {
  const saved = useMemo(loadConn, [])
  const [baseUrl, setBaseUrl] = useState(saved.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [protocol, setProtocol] = useState<Protocol>(saved.protocol)

  const [models, setModels] = useState<ModelInfo[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [endpoint, setEndpoint] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState('')

  const [systemPrompt, setSystemPrompt] = useState('')
  const [prompt, setPrompt] = useState('请用三句话介绍你自己，并说明你最擅长的能力。')
  const [maxTokens, setMaxTokens] = useState(256)
  const [temperature, setTemperature] = useState('0.7')
  const [topP, setTopP] = useState('')
  const [stream, setStream] = useState(true)
  const [timeoutSec, setTimeoutSec] = useState(120)

  const [mode, setMode] = useState<Mode>('fixed')
  const [totalRequests, setTotalRequests] = useState(20)
  const [durationSec, setDurationSec] = useState(30)
  const [rampStart, setRampStart] = useState(1)
  const [rampEnd, setRampEnd] = useState(10)
  const [rampStep, setRampStep] = useState(3)
  const [rampStepSec, setRampStepSec] = useState(10)
  const [concurrency, setConcurrency] = useState(5)

  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseUrl, protocol }))
    } catch {
      /* ignore */
    }
  }, [baseUrl, protocol])

  const hostLabel = useMemo(() => {
    const raw = baseUrl.trim()
    if (!raw) return '—'
    try {
      const u = new URL(raw.includes('://') ? raw : `https://${raw}`)
      return u.host + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''))
    } catch {
      return raw
    }
  }, [baseUrl])

  const levels = useMemo(() => {
    if (mode !== 'ramp') return 0
    const step = Math.max(1, rampStep)
    if (rampEnd < rampStart) return 0
    return Math.floor((rampEnd - rampStart) / step) + 1
  }, [mode, rampStart, rampEnd, rampStep])

  const plan = useMemo(() => {
    const n = selected.length
    if (mode === 'fixed') return { main: `${n * totalRequests}`, unit: '次请求', sub: `${n} 模型 × ${totalRequests} 次` }
    if (mode === 'duration') return { main: `${n * durationSec}`, unit: '秒', sub: `${n} 模型 × ${durationSec}s` }
    const total = levels * rampStepSec * n
    return { main: `${total}`, unit: '秒', sub: `${levels} 档 × ${rampStepSec}s × ${n} 模型` }
  }, [mode, selected.length, totalRequests, durationSec, levels, rampStepSec])

  const handleFetch = async () => {
    if (!baseUrl.trim() || !apiKey.trim()) {
      setFetchError('请先填写接口根地址与 API 密钥')
      return
    }
    setFetching(true)
    setFetchError('')
    setWarnings([])
    setEndpoint('')
    try {
      const res = await fetchModels(baseUrl.trim(), apiKey.trim(), protocol)
      setModels(res.models)
      setEndpoint(res.endpoint)
      setWarnings(res.warnings || [])
      const existing = new Set(res.models.map((m) => m.id))
      setSelected((prev) => prev.filter((id) => existing.has(id)))
      if (!res.models.length) setFetchError('接口返回的模型列表为空，可手动添加模型 ID')
    } catch (e: any) {
      setFetchError(e?.message || '获取模型列表失败')
    } finally {
      setFetching(false)
    }
  }

  const addManual = (id: string) => {
    setModels((prev) => {
      if (prev.some((m) => m.id === id)) return prev
      return [...prev, { id, protocol: inferProtocol(id) }]
    })
    setSelected((prev) => (prev.includes(id) ? prev : [...prev, id]))
  }

  const validate = (): string | null => {
    if (!baseUrl.trim()) return '请填写接口根地址'
    if (!apiKey.trim()) return '请填写 API 密钥'
    if (!selected.length) return '请至少选择一个测试模型'
    if (maxTokens < 1 || maxTokens > 32000) return 'max_tokens 需在 1 - 32000 之间'
    const temp = temperature.trim() === '' ? null : Number(temperature)
    if (temp !== null && (!isFinite(temp) || temp < 0 || temp > 2)) return 'temperature 需在 0 - 2 之间'
    const tp = topP.trim() === '' ? null : Number(topP)
    if (tp !== null && (!isFinite(tp) || tp < 0 || tp > 1)) return 'top_p 需在 0 - 1 之间'
    if (timeoutSec < 1 || timeoutSec > 600) return '单请求超时需在 1 - 600 秒之间'
    if (mode === 'fixed') {
      if (totalRequests < 1 || totalRequests > 20000) return '总请求数需在 1 - 20000 之间'
      if (selected.length * totalRequests > 30000) return '全部模型的总请求数超过 30000，请减少模型数量或请求数'
    }
    if (mode === 'duration' && (durationSec < 5 || durationSec > 3600)) return '压测时长需在 5 - 3600 秒之间'
    if (mode === 'ramp') {
      if (rampStart < 1 || rampEnd > 100) return '并发档位需在 1 - 100 之间'
      if (rampEnd < rampStart) return '结束并发不能小于起始并发'
      if (rampStep < 1) return '并发步长至少为 1'
      if (rampStepSec < 3 || rampStepSec > 600) return '每档持续时长需在 3 - 600 秒之间'
    }
    return null
  }

  const handleStart = async () => {
    const problem = validate()
    if (problem) {
      setError(problem)
      return
    }
    setError('')
    setStarting(true)
    const cfg: TestConfig = {
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      protocol,
      models: selected,
      systemPrompt,
      prompt,
      maxTokens,
      temperature: temperature.trim() === '' ? null : Number(temperature),
      topP: topP.trim() === '' ? null : Number(topP),
      stream,
      mode,
      totalRequests,
      durationSec,
      rampStart,
      rampEnd,
      rampStep,
      rampStepSec,
      concurrency,
      timeoutMs: timeoutSec * 1000,
    }
    try {
      const res = await startTest(cfg)
      onStart(res.id)
    } catch (e: any) {
      setError(e?.message || '启动测试失败')
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="config-layout">
      <div className="stack">
        <section className="card">
          <div className="card-head">
            <span className="step">1</span>
            <div className="card-heading">
              <h2>连接目标</h2>
              <p>兼容 New API / One API 中转站，以及 OpenAI、Claude、Gemini 官方接口</p>
            </div>
          </div>

          <div className="grid-2">
            <Field label="接口根地址" hint="Base URL">
              <input
                className="input"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://your-relay.example.com"
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
            <Field label="API 密钥" hint="仅用于本次请求">
              <div className="input-group">
                <input
                  className="input"
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  spellCheck={false}
                  autoComplete="off"
                />
                <button type="button" className="input-action" onClick={() => setShowKey((v) => !v)}>
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
            </Field>
          </div>

          <div className="conn-row">
            <div className="protocol-select">
              <span className="protocol-label">接口协议</span>
              <div className="segmented">
                {(['auto', 'openai', 'claude', 'gemini'] as Protocol[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={protocol === p ? 'active' : ''}
                    onClick={() => setProtocol(p)}
                  >
                    {p === 'auto' ? '自动' : p === 'openai' ? 'OpenAI' : p === 'claude' ? 'Claude' : 'Gemini'}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              className="btn secondary"
              onClick={handleFetch}
              disabled={fetching || !baseUrl.trim() || !apiKey.trim()}
            >
              {fetching ? <Spinner size={15} /> : <Icon name="refresh" size={15} />}
              {fetching ? '正在获取…' : '获取模型列表'}
            </button>
          </div>

          <p className="field-note">
            自动模式按模型名选择原生协议：claude* 走 /v1/messages，gemini* 走 /v1beta/models，其余走
            /v1/chat/completions。
          </p>

          {endpoint && (
            <div className="endpoint-line">
              <Icon name="link" size={14} />
              <span>模型列表来源</span>
              <code>{endpoint}</code>
            </div>
          )}
          {fetchError && <InlineError>{fetchError}</InlineError>}
          {warnings.length > 0 && (
            <details className="warn-box">
              <summary>部分探测方式未成功（{warnings.length}）</summary>
              <ul>
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <span className="step">2</span>
            <div className="card-heading">
              <h2>测试模型</h2>
              <p>从自动获取的列表中勾选，可同时测试多个模型（顺序执行）</p>
            </div>
          </div>
          <ModelPicker
            models={models}
            selected={selected}
            onChange={setSelected}
            onAddManual={addManual}
          />
        </section>

        <section className="card">
          <div className="card-head">
            <span className="step">3</span>
            <div className="card-heading">
              <h2>请求参数</h2>
              <p>每个并发请求都会携带以下配置</p>
            </div>
          </div>

          <Field label="System Prompt" hint="可选">
            <textarea
              className="input textarea"
              rows={2}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="例如：你是一个严谨的技术助手，回答尽量简洁。"
            />
          </Field>
          <Field label="User Prompt" hint="必填">
            <textarea
              className="input textarea"
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="输入每次请求发送的用户消息"
            />
          </Field>

          <div className="grid-4">
            <Field label="max_tokens">
              <input
                className="input"
                type="number"
                min={1}
                max={32000}
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
              />
            </Field>
            <Field label="temperature" hint="留空不传">
              <input
                className="input"
                type="number"
                step="0.1"
                min={0}
                max={2}
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                placeholder="0.7"
              />
            </Field>
            <Field label="top_p" hint="留空不传">
              <input
                className="input"
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={topP}
                onChange={(e) => setTopP(e.target.value)}
                placeholder="1"
              />
            </Field>
            <Field label="单请求超时" hint="秒">
              <input
                className="input"
                type="number"
                min={1}
                max={600}
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(Number(e.target.value))}
              />
            </Field>
          </div>

          <div className="switch-line">
            <Switch
              checked={stream}
              onChange={setStream}
              label="流式响应（stream）"
              hint="开启后可统计首 token 延迟 TTFT；关闭时 TTFT 等于总延迟"
            />
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <span className="step">4</span>
            <div className="card-heading">
              <h2>压测参数</h2>
              <p>选择施加负载的方式与并发强度</p>
            </div>
          </div>

          <div className="mode-tabs">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`mode-tab ${mode === m.id ? 'active' : ''}`}
                onClick={() => setMode(m.id)}
              >
                <span className="mode-title">{m.title}</span>
                <span className="mode-desc">{m.desc}</span>
              </button>
            ))}
          </div>

          {mode === 'fixed' && (
            <div className="grid-2">
              <Field label="总请求数" hint="每个模型">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={20000}
                  value={totalRequests}
                  onChange={(e) => setTotalRequests(Number(e.target.value))}
                />
              </Field>
              <Field label="并发数" hint="1 - 100">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={100}
                  value={concurrency}
                  onChange={(e) => setConcurrency(Number(e.target.value))}
                />
              </Field>
            </div>
          )}

          {mode === 'duration' && (
            <div className="grid-2">
              <Field label="压测时长" hint="秒 / 每个模型">
                <input
                  className="input"
                  type="number"
                  min={5}
                  max={3600}
                  value={durationSec}
                  onChange={(e) => setDurationSec(Number(e.target.value))}
                />
              </Field>
              <Field label="并发数" hint="1 - 100">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={100}
                  value={concurrency}
                  onChange={(e) => setConcurrency(Number(e.target.value))}
                />
              </Field>
            </div>
          )}

          {mode === 'ramp' && (
            <>
              <div className="grid-4">
                <Field label="起始并发">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={100}
                    value={rampStart}
                    onChange={(e) => setRampStart(Number(e.target.value))}
                  />
                </Field>
                <Field label="结束并发">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={100}
                    value={rampEnd}
                    onChange={(e) => setRampEnd(Number(e.target.value))}
                  />
                </Field>
                <Field label="并发步长">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={100}
                    value={rampStep}
                    onChange={(e) => setRampStep(Number(e.target.value))}
                  />
                </Field>
                <Field label="每档时长" hint="秒">
                  <input
                    className="input"
                    type="number"
                    min={3}
                    max={600}
                    value={rampStepSec}
                    onChange={(e) => setRampStepSec(Number(e.target.value))}
                  />
                </Field>
              </div>
              <p className="field-note">
                共 {levels} 个并发档位（{rampStart} → {rampEnd}，步长 {rampStep}），并发数由档位自动决定。
              </p>
            </>
          )}
        </section>
      </div>

      <aside className="config-side">
        <div className="card summary-card">
          <div className="summary-title">
            <Icon name="zap" size={17} />
            测试概览
          </div>
          <div className="summary-rows">
            <div>
              <span>目标地址</span>
              <b title={baseUrl}>{hostLabel}</b>
            </div>
            <div>
              <span>接口协议</span>
              <b>{protocolLabel(protocol)}</b>
            </div>
            <div>
              <span>测试模型</span>
              <b>{selected.length} 个</b>
            </div>
            <div>
              <span>负载模式</span>
              <b>{modeLabel(mode)}</b>
            </div>
            <div>
              <span>{mode === 'fixed' ? '并发数' : mode === 'ramp' ? '并发区间' : '并发数'}</span>
              <b>{mode === 'ramp' ? `${rampStart} → ${rampEnd}` : concurrency}</b>
            </div>
            <div>
              <span>响应模式</span>
              <b>{stream ? '流式' : '非流式'}</b>
            </div>
          </div>

          <div className="plan-box">
            <span>预计执行</span>
            <div>
              <b>{plan.main}</b>
              <em>{plan.unit}</em>
            </div>
            <small>{plan.sub}</small>
          </div>

          {error && <InlineError>{error}</InlineError>}

          <button type="button" className="btn primary block lg" onClick={handleStart} disabled={starting}>
            {starting ? <Spinner size={16} /> : <Icon name="play" size={16} />}
            {starting ? '正在启动…' : '开始压测'}
          </button>
          <p className="fineprint">报告仅保存在本机内存，服务重启后将清空。</p>
        </div>

        <div className="card tips-card">
          <h4>使用提示</h4>
          <ul>
            <li>先点击「获取模型列表」验证地址与密钥是否可用。</li>
            <li>非 200 响应会记录完整错误信息、状态码与 request id。</li>
            <li>流式模式下 TTFT 为首 token 到达时间，更贴近真实体验。</li>
            <li>中转站可能限流，建议从低并发开始阶梯加压。</li>
          </ul>
        </div>
      </aside>
    </div>
  )
}
