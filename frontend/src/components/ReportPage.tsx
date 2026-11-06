import { useEffect, useMemo, useRef, useState } from 'react'
import { getTest } from '../api'
import type { Report, RequestResult } from '../types'
import {
  errorTypeLabel,
  fmtBytes,
  fmtDuration,
  fmtInt,
  fmtMs,
  fmtNum,
  fmtOffset,
  fmtPct,
  fmtTime,
  modeLabel,
  protocolLabel,
} from '../format'
import { exportReportHtml, exportReportJson } from '../exportHtml'
import { ConcurrencyChart, Histogram, LatencyScatter, StatusBars, ThroughputChart } from './Charts'
import { Badge, Empty, Icon, InlineError, ProtocolBadge, Spinner, Stat, StatusPill } from './ui'

const PAGE_SIZE = 20

function tokenSourceLabel(src: string): string {
  if (src === 'usage') return '接口 usage'
  if (src === 'estimated') return '本地估算'
  return '无'
}

function ModelDetail({ report, index }: { report: Report; index: number }) {
  const model = report.models[index]
  const [filter, setFilter] = useState<'all' | 'failed'>('all')
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<number | null>(null)

  useEffect(() => {
    setFilter('all')
    setPage(0)
    setExpanded(null)
  }, [index])

  const results = model?.results ?? []
  const filtered = useMemo(() => {
    return filter === 'failed' ? results.filter((r) => !r.ok) : results
  }, [results, filter])

  if (!model) return null
  const agg = model.aggregate

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const rows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  const statusItems = agg.statusCodes.map((s) => ({
    label: `HTTP ${s.code}`,
    value: s.count,
    tone: s.code === 200 ? 'ok' : s.code >= 500 ? 'danger' : 'warn',
  }))

  return (
    <div className="model-detail">
      <div className="model-detail-head">
        <div>
          <div className="model-detail-title">
            <h2>{model.model}</h2>
            <ProtocolBadge protocol={model.protocol} />
          </div>
          <code className="endpoint-inline">{model.endpoint}</code>
        </div>
        <div className="model-detail-count">
          {fmtInt(agg.total)} 次请求 · 失败 {fmtInt(agg.failed)}
        </div>
      </div>

      <div className="kpi-grid">
        <Stat label="成功率" value={fmtPct(agg.successRate)} sub={`${fmtInt(agg.success)} 成功 / ${fmtInt(agg.failed)} 失败`} tone={agg.failed ? 'danger' : 'ok'} />
        <Stat label="QPS" value={fmtNum(agg.qps, 2)} sub={`耗时 ${fmtDuration(agg.elapsedMs)}`} />
        <Stat label="平均延迟" value={fmtMs(agg.latency.avg)} sub={`P50 ${fmtMs(agg.latency.p50)}`} />
        <Stat label="P95 延迟" value={fmtMs(agg.latency.p95)} sub={`P99 ${fmtMs(agg.latency.p99)} · 最大 ${fmtMs(agg.latency.max)}`} />
        <Stat label="平均 TTFT" value={fmtMs(agg.ttft.avg)} sub={`P95 ${fmtMs(agg.ttft.p95)}`} />
        <Stat label="输出速度" value={`${fmtNum(agg.tokens.avgTokensPerSec, 1)} tok/s`} sub={`平均输出 ${fmtNum(agg.tokens.avgCompletion, 0)} token`} />
      </div>

      <div className="chart-grid">
        <section className="card chart-card">
          <div className="chart-head">
            <h3>延迟分布</h3>
            <span className="chart-hint">按总延迟分桶</span>
          </div>
          <Histogram buckets={agg.histogram} />
        </section>
        <section className="card chart-card">
          <div className="chart-head">
            <h3>每秒完成请求</h3>
            <span className="chart-hint">成功 / 失败</span>
          </div>
          <ThroughputChart series={agg.series} />
        </section>
      </div>

      <section className="card chart-card">
        <div className="chart-head">
          <h3>请求延迟时间线</h3>
          <span className="chart-hint">每个点代表一次请求</span>
        </div>
        <LatencyScatter results={model.results} />
      </section>

      <div className="chart-grid">
        <section className="card">
          <div className="chart-head">
            <h3>活跃并发</h3>
          </div>
          <ConcurrencyChart series={agg.series} />
        </section>
        <section className="card">
          <div className="chart-head">
            <h3>状态码分布</h3>
            <span className="chart-hint">共 {fmtInt(agg.total)} 次</span>
          </div>
          <StatusBars items={statusItems} />
          <div className="token-summary">
            <div><span>输入 token</span><b>{fmtInt(agg.tokens.prompt)}</b></div>
            <div><span>输出 token</span><b>{fmtInt(agg.tokens.completion)}</b></div>
            <div><span>估算请求</span><b>{fmtInt(agg.tokens.estimated)}</b></div>
          </div>
        </section>
      </div>

      <section className="card">
        <div className="section-head">
          <h3>错误分析</h3>
          <span className="muted small">{agg.errors.length ? `共 ${agg.errors.length} 类错误` : '无错误'}</span>
        </div>
        {agg.errors.length === 0 ? (
          <div className="ok-banner">
            <Icon name="check" size={16} />
            该模型全部请求均返回 HTTP 200。
          </div>
        ) : (
          <div className="error-list">
            {agg.errors.map((g, i) => (
              <div key={i} className="error-item">
                <div className="error-item-head">
                  <Badge tone="danger">{errorTypeLabel(g.type)}</Badge>
                  {g.statuses.map((s) => (
                    <Badge key={s} tone="neutral">HTTP {s}</Badge>
                  ))}
                  <span className="error-count">{fmtInt(g.count)} 次</span>
                  <span className="muted small">首次出现于 {fmtOffset(g.firstAtMs)}</span>
                </div>
                {g.models.length > 1 && <div className="muted small">涉及模型：{g.models.join('、')}</div>}
                <pre className="error-pre">{g.message}</pre>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="section-head">
          <h3>请求明细</h3>
          <div className="table-tools">
            <div className="segmented small">
              <button className={filter === 'all' ? 'active' : ''} onClick={() => { setFilter('all'); setPage(0) }}>
                全部 {fmtInt(model.results.length)}
              </button>
              <button className={filter === 'failed' ? 'active' : ''} onClick={() => { setFilter('failed'); setPage(0) }}>
                仅失败 {fmtInt(model.results.filter((r) => !r.ok).length)}
              </button>
            </div>
          </div>
        </div>

        {model.resultsTruncated && (
          <p className="field-note">明细已截断，仅保存前 20000 条请求；所有统计指标基于完整数据计算。</p>
        )}

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th className="num">开始</th>
                <th>状态</th>
                <th className="num">延迟</th>
                <th className="num">TTFT</th>
                <th className="num">Token 入/出</th>
                <th className="num">tok/s</th>
                <th>Request ID</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <RequestRow
                  key={r.index}
                  r={r}
                  expanded={expanded === r.index}
                  onToggle={() => setExpanded(expanded === r.index ? null : r.index)}
                />
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="table-empty">没有符合条件的请求</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {pageCount > 1 && (
          <div className="pager">
            <button className="btn tiny ghost" onClick={() => setPage(Math.max(0, safePage - 1))} disabled={safePage === 0}>
              上一页
            </button>
            <span>
              第 {safePage + 1} / {pageCount} 页
            </span>
            <button className="btn tiny ghost" onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))} disabled={safePage >= pageCount - 1}>
              下一页
            </button>
          </div>
        )}
      </section>
    </div>
  )
}

function RequestRow({ r, expanded, onToggle }: { r: RequestResult; expanded: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className={`clickable ${r.ok ? '' : 'failed-row'}`} onClick={onToggle}>
        <td className="muted">#{r.index + 1}</td>
        <td className="num">{fmtOffset(r.startOffsetMs)}</td>
        <td>
          <Badge tone={r.ok ? 'ok' : 'danger'}>{r.ok ? '200' : r.status || 'ERR'}</Badge>
        </td>
        <td className="num">{fmtMs(r.latencyMs)}</td>
        <td className="num">{fmtMs(r.ttftMs)}</td>
        <td className="num">{r.promptTokens} / {r.completionTokens}</td>
        <td className="num">{fmtNum(r.tokensPerSec, 1)}</td>
        <td className="mono ellipsis reqid" title={r.requestId || ''}>{r.requestId || '—'}</td>
        <td className="ellipsis result-cell">
          {r.ok ? (
            <span className="muted">{r.finishReason || (r.responsePreview ? r.responsePreview : '—')}</span>
          ) : (
            <span className="danger-text">{r.errorMessage || '—'}</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="detail-row">
          <td colSpan={9}>
            <div className="req-detail">
              <div className="detail-grid">
                <div><span>Request ID</span><code>{r.requestId || '—'}</code></div>
                <div><span>Token 来源</span><b>{tokenSourceLabel(r.tokenSource)}</b></div>
                <div><span>协议</span><b>{r.protocol}</b></div>
                <div><span>并发档位</span><b>{r.concurrency}</b></div>
                <div><span>请求 / 响应大小</span><b>{fmtBytes(r.requestBytes)} / {fmtBytes(r.responseBytes)}</b></div>
                <div><span>输出字符数</span><b>{fmtInt(r.outputChars)}</b></div>
                <div><span>完成原因</span><b>{r.finishReason || '—'}</b></div>
                <div><span>错误类型</span><b>{r.errorType ? errorTypeLabel(r.errorType) : '—'}</b></div>
              </div>
              {r.errorMessage && (
                <div className="detail-pre">
                  <span>错误信息</span>
                  <pre>{r.errorMessage}</pre>
                </div>
              )}
              {r.responsePreview && (
                <div className="detail-pre">
                  <span>响应预览</span>
                  <pre>{r.responsePreview}</pre>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

export function ReportPage({ id, onOpenRun }: { id: string; onOpenRun: (id: string) => void }) {
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [active, setActive] = useState(0)
  const detailRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setReport(null)
    getTest(id)
      .then((res) => {
        if (cancelled) return
        if (res.report) {
          const rep = res.report
          setReport({
            ...rep,
            models: (rep.models ?? []).map((m) => ({
              ...m,
              results: m.results ?? [],
              aggregate: {
                ...m.aggregate,
                errors: m.aggregate.errors ?? [],
                statusCodes: m.aggregate.statusCodes ?? [],
                series: m.aggregate.series ?? [],
                histogram: m.aggregate.histogram ?? [],
              },
            })),
            totals: {
              ...rep.totals,
              errors: rep.totals.errors ?? [],
              statusCodes: rep.totals.statusCodes ?? [],
              series: rep.totals.series ?? [],
              histogram: rep.totals.histogram ?? [],
            },
          })
          setActive(0)
        } else {
          onOpenRun(id)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || '加载报告失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id, onOpenRun])

  const allResults = useMemo(() => {
    if (!report) return []
    return report.models.flatMap((m) => m.results)
  }, [report])

  if (loading) {
    return (
      <div className="card loading-card">
        <div className="loading-orb">
          <Spinner size={20} />
        </div>
        <div>
          <b>正在加载报告</b>
          <p>从本机内存读取测试结果…</p>
        </div>
      </div>
    )
  }

  if (error || !report) {
    return (
      <div className="card">
        <Empty title="无法加载报告" desc={error || '报告不存在或已被清理'} />
        <div className="center">
          <a className="btn secondary" href="#/">返回新建压测</a>
        </div>
      </div>
    )
  }

  const cfg = report.config
  const totals = report.totals
  const activeModel = report.models[active]

  return (
    <div className="report-page">
      <section className="card report-head">
        <div>
          <div className="run-eyebrow">
            <StatusPill status={report.status} />
            <span className="run-id">#{report.id}</span>
          </div>
          <h1>压测报告</h1>
          <p className="run-sub">
            {fmtTime(report.startedAt)} · 用时 {fmtDuration(report.durationMs)} · {report.models.length} 个模型 ·{' '}
            {modeLabel(cfg.mode)} · 并发 {cfg.concurrency}
          </p>
        </div>
        <div className="report-actions">
          <button className="btn secondary" onClick={() => exportReportJson(report)}>
            <Icon name="download" size={15} />
            JSON
          </button>
          <button className="btn secondary" onClick={() => exportReportHtml(report)}>
            <Icon name="file" size={15} />
            导出 HTML
          </button>
          <button className="btn primary" onClick={() => window.print()}>
            打印 / PDF
          </button>
        </div>
      </section>

      {report.status === 'stopped' && (
        <div className="notice warn">
          <Icon name="alert" size={15} />
          测试被手动停止，统计仅包含已完成的请求{report.error ? `（${report.error}）` : ''}。
        </div>
      )}
      {report.status === 'failed' && (
        <div className="notice danger">
          <Icon name="alert" size={15} />
          测试执行失败{report.error ? `：${report.error}` : ''}。
        </div>
      )}

      <section className="card">
        <div className="section-head">
          <h3>总体表现</h3>
          <span className="muted small">
            执行 {fmtDuration(totals.elapsedMs)}
            {totals.canceled > 0 && ` · 未执行 ${fmtInt(totals.canceled)} 次`}
          </span>
        </div>
        <div className="kpi-grid wide">
          <Stat label="总请求" value={fmtInt(totals.total)} sub={`成功 ${fmtInt(totals.success)} · 失败 ${fmtInt(totals.failed)}`} />
          <Stat label="成功率" value={fmtPct(totals.successRate)} sub={`错误率 ${fmtPct(totals.errorRate)}`} tone={totals.failed ? 'danger' : 'ok'} />
          <Stat label="吞吐 QPS" value={fmtNum(totals.qps, 2)} sub="成功请求 / 秒" />
          <Stat label="平均延迟" value={fmtMs(totals.latency.avg)} sub={`P50 ${fmtMs(totals.latency.p50)}`} />
          <Stat label="P95 延迟" value={fmtMs(totals.latency.p95)} sub={`P99 ${fmtMs(totals.latency.p99)}`} />
          <Stat label="平均 TTFT" value={fmtMs(totals.ttft.avg)} sub={`P95 ${fmtMs(totals.ttft.p95)}`} />
          <Stat label="输出速度" value={`${fmtNum(totals.tokens.avgTokensPerSec, 1)} tok/s`} sub={`平均输出 ${fmtNum(totals.tokens.avgCompletion, 0)} token`} />
          <Stat label="Token 总量" value={fmtInt(totals.tokens.total)} sub={`入 ${fmtInt(totals.tokens.prompt)} · 出 ${fmtInt(totals.tokens.completion)}`} />
        </div>
      </section>

      {totals.errors.length > 0 && (
        <section className="card">
          <div className="section-head">
            <h3>错误汇总（全部模型）</h3>
            <span className="muted small">
              共 {fmtInt(totals.failed)} 次失败 · {totals.errors.length} 类错误
            </span>
          </div>
          <div className="error-list">
            {totals.errors.map((g, i) => (
              <div key={i} className="error-item">
                <div className="error-item-head">
                  <Badge tone="danger">{errorTypeLabel(g.type)}</Badge>
                  {g.statuses.map((s) => (
                    <Badge key={s} tone="neutral">HTTP {s}</Badge>
                  ))}
                  <span className="error-count">{fmtInt(g.count)} 次</span>
                  <span className="muted small">首次出现于 {fmtOffset(g.firstAtMs)}</span>
                </div>
                {g.models.length > 0 && <div className="muted small">涉及模型：{g.models.join('、')}</div>}
                <pre className="error-pre">{g.message}</pre>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <div className="section-head">
          <h3>测试配置</h3>
          <span className="muted small">地址与密钥仅用于本次测试</span>
        </div>
        <div className="meta-grid">
          <div className="meta-cell"><span>目标地址</span><b title={cfg.baseUrl}>{cfg.baseUrl}</b></div>
          <div className="meta-cell"><span>接口协议</span><b>{protocolLabel(cfg.protocol)}</b></div>
          <div className="meta-cell"><span>API 密钥</span><b className="mono">{cfg.apiKey}</b></div>
          <div className="meta-cell"><span>响应模式</span><b>{cfg.stream ? '流式（stream）' : '非流式'}</b></div>
          <div className="meta-cell"><span>max_tokens</span><b>{cfg.maxTokens}</b></div>
          <div className="meta-cell"><span>temperature / top_p</span><b>{cfg.temperature ?? '默认'} / {cfg.topP ?? '默认'}</b></div>
          <div className="meta-cell"><span>单请求超时</span><b>{cfg.timeoutMs / 1000} 秒</b></div>
          <div className="meta-cell"><span>负载参数</span><b>
            {cfg.mode === 'fixed' && `${cfg.totalRequests} 次 × ${cfg.concurrency} 并发`}
            {cfg.mode === 'duration' && `${cfg.durationSec} 秒 × ${cfg.concurrency} 并发`}
            {cfg.mode === 'ramp' && `${cfg.rampStart} → ${cfg.rampEnd}（步长 ${cfg.rampStep}）× ${cfg.rampStepSec}s`}
          </b></div>
        </div>
        <details className="prompt-details">
          <summary>查看测试提示词</summary>
          {cfg.systemPrompt && (
            <div className="prompt-block">
              <span>System Prompt</span>
              <pre>{cfg.systemPrompt}</pre>
            </div>
          )}
          <div className="prompt-block">
            <span>User Prompt</span>
            <pre>{cfg.prompt}</pre>
          </div>
        </details>
      </section>

      <section className="card chart-card">
        <div className="chart-head">
          <h3>全部请求延迟时间线</h3>
          <span className="chart-hint">横轴为相对开始时间，红点为失败请求</span>
        </div>
        <LatencyScatter results={allResults} />
      </section>

      <section className="card">
        <div className="section-head">
          <h3>模型对比</h3>
          <span className="muted small">点击行可查看该模型详情</span>
        </div>
        <div className="table-scroll">
          <table className="data-table comparison">
            <thead>
              <tr>
                <th>模型</th>
                <th>协议</th>
                <th className="num">请求</th>
                <th className="num">成功率</th>
                <th className="num">QPS</th>
                <th className="num">平均延迟</th>
                <th className="num">P95</th>
                <th className="num">TTFT</th>
                <th className="num">tok/s</th>
                <th>状态码</th>
              </tr>
            </thead>
            <tbody>
              {report.models.map((m, i) => (
                <tr key={m.model} className={`clickable ${i === active ? 'active-row' : ''}`} onClick={() => { setActive(i); detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>
                  <td className="mono">{m.model}</td>
                  <td><ProtocolBadge protocol={m.protocol} /></td>
                  <td className="num">{fmtInt(m.aggregate.total)}</td>
                  <td className={`num ${m.aggregate.failed ? 'danger-text' : 'ok-text'}`}>{fmtPct(m.aggregate.successRate)}</td>
                  <td className="num">{fmtNum(m.aggregate.qps, 2)}</td>
                  <td className="num">{fmtMs(m.aggregate.latency.avg)}</td>
                  <td className="num">{fmtMs(m.aggregate.latency.p95)}</td>
                  <td className="num">{fmtMs(m.aggregate.ttft.avg)}</td>
                  <td className="num">{fmtNum(m.aggregate.tokens.avgTokensPerSec, 1)}</td>
                  <td className="status-cell">
                    {m.aggregate.statusCodes.map((s) => (
                      <Badge key={s.code} tone={s.code === 200 ? 'ok' : 'danger'}>{s.code}×{s.count}</Badge>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div ref={detailRef} className="detail-anchor" />

      {report.models.length > 1 && (
        <div className="model-tabs">
          {report.models.map((m, i) => (
            <button key={m.model} className={i === active ? 'active' : ''} onClick={() => setActive(i)}>
              <span>{m.model}</span>
              <em className={m.aggregate.failed ? 'danger-text' : 'ok-text'}>{fmtPct(m.aggregate.successRate)}</em>
            </button>
          ))}
        </div>
      )}

      {activeModel ? <ModelDetail report={report} index={active} /> : <InlineError>报告缺少模型数据</InlineError>}
    </div>
  )
}
