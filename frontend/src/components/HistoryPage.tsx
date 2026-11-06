import { useCallback, useEffect, useState } from 'react'
import { listTests } from '../api'
import type { TestSummary } from '../types'
import { fmtDuration, fmtInt, fmtMs, fmtNum, fmtPct, fmtTime, modeLabel, protocolLabel } from '../format'
import { Empty, Icon, InlineError, Spinner, StatusPill } from './ui'

export function HistoryPage({ onOpen }: { onOpen: (id: string, running: boolean) => void }) {
  const [tests, setTests] = useState<TestSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await listTests()
      setTests(res.tests || [])
    } catch (e: any) {
      setError(e?.message || '加载历史报告失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="history-page">
      <div className="page-head">
        <div>
          <h1>历史报告</h1>
          <p className="page-sub">测试结果保存在本机内存中，服务重启后清空。</p>
        </div>
        <button className="btn secondary" onClick={load} disabled={loading}>
          {loading ? <Spinner size={15} /> : <Icon name="refresh" size={15} />}
          刷新
        </button>
      </div>

      {error && <InlineError>{error}</InlineError>}

      {!loading && tests.length === 0 && !error && (
        <div className="card">
          <Empty title="还没有压测记录" desc="完成一次压测后，报告会出现在这里。" />
          <div className="center">
            <a className="btn primary" href="#/">开始第一次压测</a>
          </div>
        </div>
      )}

      <div className="history-list">
        {tests.map((t) => {
          const running = t.status === 'running'
          return (
            <button
              key={t.id}
              className="card history-card"
              onClick={() => onOpen(t.id, running)}
            >
              <div className="history-main">
                <div className="history-top">
                  <StatusPill status={t.status} />
                  <span className="run-id">#{t.id}</span>
                  <span className="muted small">{fmtTime(t.createdAt)}</span>
                </div>
                <div className="history-models">
                  {t.models.slice(0, 3).map((m) => (
                    <span key={m} className="chip mono">{m}</span>
                  ))}
                  {t.models.length > 3 && <span className="chip">+{t.models.length - 3}</span>}
                  {t.models.length === 0 && <span className="muted">尚未开始</span>}
                </div>
                <div className="history-meta">
                  <span>{protocolLabel(t.protocol)}</span>
                  <span>{modeLabel(t.mode)}</span>
                  <span>{fmtDuration(t.elapsedMs || t.durationMs)}</span>
                </div>
              </div>

              <div className="history-stats">
                <div><span>请求</span><b>{fmtInt(t.total)}</b></div>
                <div><span>成功率</span><b className={t.failed ? 'danger-text' : 'ok-text'}>{t.total ? fmtPct(t.successRate) : '—'}</b></div>
                <div><span>QPS</span><b>{fmtNum(t.qps, 2)}</b></div>
                <div><span>平均延迟</span><b>{fmtMs(t.avgLatency)}</b></div>
                <div><span>P95</span><b>{fmtMs(t.p95)}</b></div>
              </div>

              <div className="history-action">
                <Icon name="arrow" size={18} />
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
