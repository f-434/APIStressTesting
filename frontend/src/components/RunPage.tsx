import { useCallback, useEffect, useRef, useState } from 'react'
import { getTest, stopTest, subscribeTest } from '../api'
import type { LiveUpdate } from '../types'
import { errorTypeLabel, fmtDuration, fmtInt, fmtMs, fmtNum, fmtPct, modeLabel, protocolLabel } from '../format'
import { ConcurrencyChart, ThroughputChart } from './Charts'
import { Badge, Icon, InlineError, Spinner, Stat, StatusPill } from './ui'

export function RunPage({ id, onReport }: { id: string; onReport: (id: string) => void }) {
  const [live, setLive] = useState<LiveUpdate | null>(null)
  const [connError, setConnError] = useState('')
  const [stopping, setStopping] = useState(false)
  const finishedRef = useRef(false)
  const timerRef = useRef<number | null>(null)

  const navigateToReport = useCallback(() => {
    if (timerRef.current) return
    timerRef.current = window.setTimeout(() => onReport(id), 800)
  }, [id, onReport])

  const handleLive = useCallback(
    (next: LiveUpdate) => {
      setLive(next)
      if (next.status !== 'running' && !finishedRef.current) {
        finishedRef.current = true
        navigateToReport()
      }
    },
    [navigateToReport],
  )

  useEffect(() => {
    let cancelled = false
    finishedRef.current = false
    setLive(null)
    setConnError('')

    getTest(id)
      .then((res) => {
        if (cancelled) return
        if (res.report) {
          finishedRef.current = true
          onReport(id)
        } else if (res.live) {
          handleLive(res.live)
        }
      })
      .catch((e) => setConnError(e?.message || '无法加载测试状态'))

    const es = subscribeTest(id, {
      onSnapshot: handleLive,
      onUpdate: handleLive,
      onDone: (payload) => {
        if (payload.status) {
          setLive((prev) => (prev ? { ...prev, status: payload.status as any } : prev))
        }
        if (!finishedRef.current) {
          finishedRef.current = true
          navigateToReport()
        }
      },
      onError: () => setConnError('实时连接已断开，正在尝试重连…'),
    })

    return () => {
      cancelled = true
      es.close()
      if (timerRef.current) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [id, handleLive, navigateToReport, onReport])

  const handleStop = async () => {
    setStopping(true)
    try {
      await stopTest(id)
    } catch (e: any) {
      setConnError(e?.message || '停止测试失败')
    } finally {
      setStopping(false)
    }
  }

  if (!live) {
    return (
      <div className="card loading-card">
        <div className="loading-orb">
          <Spinner size={20} />
        </div>
        <div>
          <b>正在连接测试进程</b>
          <p>{connError || '等待服务端推送实时数据…'}</p>
        </div>
      </div>
    )
  }

  const cfg = live.config
  const models = live.models ?? []
  const recent = live.recent ?? []
  const errors = live.errors ?? []
  const series = live.series ?? []
  const modelCount = Math.max(1, cfg?.models?.length || live.modelCount || 1)
  const levels =
    cfg?.mode === 'ramp'
      ? Math.max(1, Math.floor((cfg.rampEnd - cfg.rampStart) / Math.max(1, cfg.rampStep)) + 1)
      : 0
  const totalSec =
    cfg?.mode === 'duration'
      ? (cfg.durationSec || 0) * modelCount
      : cfg?.mode === 'ramp'
        ? levels * (cfg.rampStepSec || 0) * modelCount
        : 0
  const totalPlannedMs = totalSec * 1000

  let percent = 0
  if (live.planned > 0) percent = (live.completed / live.planned) * 100
  else if (totalPlannedMs > 0) percent = (live.elapsedMs / totalPlannedMs) * 100
  percent = Math.max(0, Math.min(100, percent))

  const finished = live.status !== 'running'
  const progressLabel =
    live.planned > 0
      ? `${fmtInt(live.completed)} / ${fmtInt(live.planned)} 请求`
      : totalPlannedMs > 0
        ? `${fmtDuration(live.elapsedMs)} / ${fmtDuration(totalPlannedMs)}`
        : `${fmtDuration(live.elapsedMs)} 已运行`

  return (
    <div className="run-page">
      <section className="card run-head">
        <div className="run-head-main">
          <div className="run-eyebrow">
            <StatusPill status={live.status} />
            <span className="run-id">#{live.testId}</span>
          </div>
          <h1>{live.currentModel || '正在初始化…'}</h1>
          <p className="run-sub">
            {protocolLabel(live.currentProtocol || cfg?.protocol || 'auto')} · {modeLabel(live.mode)} ·{' '}
            {modelCount} 个模型 · 并发 {live.currentConcurrency}
            {live.modelCount > 1 && ` · 模型 ${Math.min(live.modelIndex + 1, live.modelCount)}/${live.modelCount}`}
          </p>
        </div>
        <div className="run-actions">
          {finished ? (
            <button className="btn primary" onClick={() => onReport(id)}>
              <Icon name="file" size={15} />
              查看报告
            </button>
          ) : (
            <button className="btn danger" onClick={handleStop} disabled={stopping}>
              {stopping ? <Spinner size={15} /> : <Icon name="stop" size={15} />}
              停止测试
            </button>
          )}
        </div>
      </section>

      <section className="card progress-card" aria-busy={!finished}>
        <div className="progress-top">
          <span>{progressLabel}</span>
          <span>{fmtNum(percent, 1)}%</span>
        </div>
        <div className="progress">
          <div
            className={`progress-bar ${finished ? 'done' : 'running'}`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="progress-meta">
          <span><Icon name="clock" size={13} />已运行 {fmtDuration(live.elapsedMs)}</span>
          <span><Icon name="zap" size={13} />成功 {fmtInt(live.success)} · 失败 {fmtInt(live.failed)}</span>
          {!finished && (
            <span className="running-indicator">
              <Spinner size={12} />
              实时采集中
            </span>
          )}
          {live.status === 'stopped' && <span className="warn-text">测试已手动停止</span>}
          {live.status === 'failed' && <span className="danger-text">测试执行失败</span>}
          {finished && <span className="muted">正在打开报告…</span>}
        </div>
        {live.error && <InlineError>{live.error}</InlineError>}
        {connError && <InlineError>{connError}</InlineError>}
      </section>

      {models.length > 1 && (
        <div className="model-strip">
          {models.map((m, i) => (
            <div key={m.model} className={`model-pill ${i === live.modelIndex && !finished ? 'active' : ''}`}>
              <span className="model-pill-name">{m.model}</span>
              <span className="model-pill-meta">
                {fmtInt(m.total)} 次 · {fmtPct(m.successRate)}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="kpi-grid">
        <Stat label="成功 / 失败" value={`${fmtInt(live.success)} / ${fmtInt(live.failed)}`} sub={`共 ${fmtInt(live.completed)} 次请求`} tone="ok" />
        <Stat label="成功率" value={fmtPct(live.successRate)} sub={`错误率 ${fmtPct(100 - live.successRate)}`} tone={live.successRate >= 99 ? 'ok' : live.failed > 0 ? 'danger' : 'default'} />
        <Stat label="吞吐 QPS" value={fmtNum(live.qps, 2)} sub="成功请求 / 秒" />
        <Stat label="P95 延迟" value={fmtMs(live.latency.p95)} sub={`平均 ${fmtMs(live.latency.avg)} · P50 ${fmtMs(live.latency.p50)}`} />
        <Stat label="平均 TTFT" value={fmtMs(live.ttft.avg)} sub={`P95 ${fmtMs(live.ttft.p95)}`} />
        <Stat label="输出速度" value={`${fmtNum(live.tokens.avgTokensPerSec, 1)}`} sub={`tok/s · 共 ${fmtInt(live.tokens.completion)} 输出 token`} />
      </div>

      <div className="chart-grid">
        <section className="card chart-card">
          <div className="chart-head">
            <h3>每秒完成请求</h3>
            <span className="chart-hint">按完成时间聚合</span>
          </div>
          <ThroughputChart series={series} />
        </section>
        <section className="card chart-card">
          <div className="chart-head">
            <h3>活跃并发</h3>
            <span className="chart-hint">当前并发水平</span>
          </div>
          <ConcurrencyChart series={series} />
        </section>
      </div>

      {errors.length > 0 && (
        <section className="card">
          <div className="section-head">
            <h3>错误汇总</h3>
            <span className="muted small">按出现次数排序</span>
          </div>
          <div className="error-list">
            {errors.map((g, i) => (
              <div key={i} className="error-item">
                <div className="error-item-head">
                  <Badge tone="danger">{errorTypeLabel(g.type)}</Badge>
                  {g.statuses.map((s) => (
                    <Badge key={s} tone="neutral">HTTP {s}</Badge>
                  ))}
                  <span className="error-count">{fmtInt(g.count)} 次</span>
                </div>
                <p className="error-message">{g.message}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <div className="section-head">
          <h3>最近请求</h3>
          <span className="muted small">最新 {recent.length} 条</span>
        </div>
        <div className="table-scroll">
          <table className="data-table compact">
            <thead>
              <tr>
                <th>#</th>
                <th>模型</th>
                <th>状态</th>
                <th className="num">延迟</th>
                <th className="num">TTFT</th>
                <th className="num">Token 入/出</th>
                <th className="num">tok/s</th>
                <th>错误信息</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r, i) => (
                <tr key={`${r.index}-${i}`}>
                  <td className="muted">#{r.index + 1}</td>
                  <td className="mono ellipsis" title={r.model}>{r.model}</td>
                  <td>
                    <Badge tone={r.ok ? 'ok' : 'danger'}>{r.ok ? '200' : r.status || 'ERR'}</Badge>
                  </td>
                  <td className="num">{fmtMs(r.latencyMs)}</td>
                  <td className="num">{fmtMs(r.ttftMs)}</td>
                  <td className="num">{r.promptTokens} / {r.completionTokens}</td>
                  <td className="num">{fmtNum(r.tokensPerSec, 1)}</td>
                  <td className="ellipsis error-cell" title={r.errorMessage || ''}>
                    {r.ok ? <span className="muted">{r.finishReason || '—'}</span> : r.errorMessage || '—'}
                  </td>
                </tr>
              ))}
              {recent.length === 0 && (
                <tr>
                  <td colSpan={8} className="table-empty">
                    <span className="typing-dots"><i /><i /><i /></span>
                    正在等待首个请求完成…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
