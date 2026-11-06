import { useId } from 'react'
import type { HistBucket, RequestResult, SeriesPoint } from '../types'
import { fmtMs, fmtNum, fmtOffset } from '../format'

const PAD = { l: 54, r: 16, t: 16, b: 32 }
const W = 760
const H = 250

function plotBox() {
  return {
    x: PAD.l,
    y: PAD.t,
    w: W - PAD.l - PAD.r,
    h: H - PAD.t - PAD.b,
  }
}

function yTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0]
  const out: number[] = []
  for (let i = 0; i <= count; i++) out.push((max / count) * i)
  return out
}

function niceMax(v: number): number {
  if (v <= 0) return 1
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  const norm = v / exp
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return nice * exp
}

function ChartEmpty({ text = '暂无数据' }: { text?: string }) {
  return (
    <div className="chart-empty">
      <span>{text}</span>
    </div>
  )
}

function Axis({
  max,
  format,
  box,
}: {
  max: number
  format: (v: number) => string
  box: { x: number; y: number; w: number; h: number }
}) {
  return (
    <>
      {yTicks(max).map((t, i) => {
        const y = box.y + box.h - (t / max) * box.h
        return (
          <g key={i}>
            <line x1={box.x} x2={box.x + box.w} y1={y} y2={y} stroke="#eef1f5" strokeWidth="1" />
            <text x={box.x - 8} y={y + 3.5} textAnchor="end" fontSize="10" fill="#94a3b8">
              {format(t)}
            </text>
          </g>
        )
      })}
    </>
  )
}

export function Histogram({ buckets }: { buckets: HistBucket[] }) {
  const gid = useId().replace(/:/g, '')
  buckets = buckets ?? []
  if (!buckets.length) return <ChartEmpty />
  const box = plotBox()
  const max = niceMax(Math.max(...buckets.map((b) => b.count)))
  const bw = box.w / buckets.length
  const step = Math.ceil(buckets.length / 7)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label="延迟分布直方图">
      <defs>
        <linearGradient id={`hg-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#10b981" />
          <stop offset="100%" stopColor="#6ee7b7" />
        </linearGradient>
      </defs>
      <Axis max={max} format={(v) => (v === 0 ? '0' : fmtNum(v, 0))} box={box} />
      {buckets.map((b, i) => {
        const h = (b.count / max) * box.h
        const x = box.x + i * bw
        return (
          <g key={i}>
            <rect
              x={x + Math.min(2, bw * 0.15)}
              y={box.y + box.h - h}
              width={Math.max(1, bw - Math.min(4, bw * 0.3))}
              height={Math.max(0, h)}
              rx={Math.min(3, bw / 4)}
              fill={`url(#hg-${gid})`}
            >
              <title>{`${fmtMs(b.from)} – ${fmtMs(b.to)}：${b.count} 次`}</title>
            </rect>
            {i % step === 0 && (
              <text
                x={x + bw / 2}
                y={box.y + box.h + 18}
                textAnchor="middle"
                fontSize="10"
                fill="#94a3b8"
              >
                {fmtMs(b.from)}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

export function LatencyScatter({ results }: { results: RequestResult[] }) {
  results = results ?? []
  if (!results.length) return <ChartEmpty />
  const box = plotBox()
  const sample =
    results.length > 1600 ? results.filter((_, i) => i % Math.ceil(results.length / 1600) === 0) : results
  const xMax = Math.max(1, ...sample.map((r) => r.startOffsetMs / 1000))
  const yMax = niceMax(Math.max(1, ...sample.map((r) => r.latencyMs)))

  return (
    <div className="chart-block">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label="请求延迟散点图">
        <Axis max={yMax} format={(v) => (v === 0 ? '0' : fmtMs(v))} box={box} />
        {[0, 0.25, 0.5, 0.75, 1].map((p, i) => {
          const x = box.x + p * box.w
          return (
            <g key={i}>
              <line x1={x} x2={x} y1={box.y} y2={box.y + box.h} stroke="#f3f5f8" strokeWidth="1" />
              <text x={x} y={box.y + box.h + 18} textAnchor="middle" fontSize="10" fill="#94a3b8">
                {fmtOffset(p * xMax * 1000)}
              </text>
            </g>
          )
        })}
        {sample.map((r, i) => {
          const x = box.x + Math.min(1, r.startOffsetMs / 1000 / xMax) * box.w
          const y = box.y + box.h - Math.min(1, r.latencyMs / yMax) * box.h
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={r.ok ? 2.4 : 3}
              fill={r.ok ? '#10b981' : '#ef4444'}
              fillOpacity={r.ok ? 0.55 : 0.85}
            >
              <title>{`#${r.index + 1} · ${fmtMs(r.latencyMs)} · ${r.ok ? '成功' : `失败 ${r.status}`}`}</title>
            </circle>
          )
        })}
      </svg>
      <div className="legend">
        <span><i className="swatch" style={{ background: '#10b981' }} />成功请求</span>
        <span><i className="swatch" style={{ background: '#ef4444' }} />失败请求</span>
        <span className="legend-note">横轴：相对开始时间　纵轴：总延迟</span>
      </div>
    </div>
  )
}

function reduceSeries(series: SeriesPoint[]): SeriesPoint[] {
  if (series.length <= 120) return series
  const group = Math.ceil(series.length / 110)
  const out: SeriesPoint[] = []
  for (let i = 0; i < series.length; i += group) {
    const chunk = series.slice(i, i + group)
    const last = chunk[chunk.length - 1]
    out.push({
      sec: last.sec,
      started: chunk.reduce((a, b) => a + b.started, 0),
      completed: chunk.reduce((a, b) => a + b.completed, 0),
      success: chunk.reduce((a, b) => a + b.success, 0),
      failed: chunk.reduce((a, b) => a + b.failed, 0),
      avgLatency: last.avgLatency,
      concurrency: last.concurrency,
    })
  }
  return out
}

export function ThroughputChart({ series }: { series: SeriesPoint[] }) {
  series = series ?? []
  if (!series.length) return <ChartEmpty />
  const data = reduceSeries(series)
  const box = plotBox()
  const max = niceMax(Math.max(1, ...data.map((p) => p.success + p.failed)))
  const bw = box.w / data.length
  const barW = Math.max(1, Math.min(bw * 0.82, 56))
  const step = Math.max(1, Math.ceil(data.length / 8))

  return (
    <div className="chart-block">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label="每秒完成请求数">
        <Axis max={max} format={(v) => fmtNum(v, 0)} box={box} />
        {data.map((p, i) => {
          const x = box.x + i * bw + (bw - barW) / 2
          const sh = (p.success / max) * box.h
          const fh = (p.failed / max) * box.h
          return (
            <g key={i}>
              <rect
                x={x}
                y={box.y + box.h - sh - fh}
                width={barW}
                height={fh}
                fill="#f87171"
                fillOpacity={0.85}
                rx={barW > 8 ? 2 : 0}
              >
                <title>{`第 ${p.sec}s：失败 ${p.failed}`}</title>
              </rect>
              <rect
                x={x}
                y={box.y + box.h - sh}
                width={barW}
                height={sh}
                fill="#34d399"
                fillOpacity={0.9}
                rx={barW > 8 ? 2 : 0}
              >
                <title>{`第 ${p.sec}s：成功 ${p.success}，平均延迟 ${fmtMs(p.avgLatency)}`}</title>
              </rect>
              {i % step === 0 && (
                <text
                  x={box.x + i * bw + bw / 2}
                  y={box.y + box.h + 18}
                  textAnchor="middle"
                  fontSize="10"
                  fill="#94a3b8"
                >
                  {p.sec}s
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div className="legend">
        <span><i className="swatch" style={{ background: '#34d399' }} />成功</span>
        <span><i className="swatch" style={{ background: '#f87171' }} />失败</span>
        <span className="legend-note">完成时间按秒聚合</span>
      </div>
    </div>
  )
}

export function ConcurrencyChart({ series }: { series: SeriesPoint[] }) {
  const gid = useId().replace(/:/g, '')
  series = series ?? []
  if (!series.length) return <ChartEmpty />
  const data = reduceSeries(series)
  const box = plotBox()
  const max = niceMax(Math.max(1, ...data.map((p) => p.concurrency)))
  const points = data
    .map((p, i) => {
      const x = box.x + (data.length === 1 ? box.w / 2 : (i / (data.length - 1)) * box.w)
      const y = box.y + box.h - (p.concurrency / max) * box.h
      return `${x},${y}`
    })
    .join(' ')
  const area = `${box.x},${box.y + box.h} ${points} ${box.x + box.w},${box.y + box.h}`
  const step = Math.max(1, Math.ceil(data.length / 8))

  return (
    <div className="chart-block">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label="并发数随时间变化">
        <defs>
          <linearGradient id={`cg-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#34d399" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <Axis max={max} format={(v) => fmtNum(v, 0)} box={box} />
        <polygon points={area} fill={`url(#cg-${gid})`} />
        <polyline points={points} fill="none" stroke="#0ea77a" strokeWidth="2" strokeLinejoin="round" />
        {data.map((p, i) => {
          const x = box.x + (data.length === 1 ? box.w / 2 : (i / (data.length - 1)) * box.w)
          const y = box.y + box.h - (p.concurrency / max) * box.h
          return (
            <circle
              key={`p-${i}`}
              cx={x}
              cy={y}
              r={data.length < 8 ? 3 : 1.8}
              fill="#0ea77a"
              stroke="#fff"
              strokeWidth={data.length < 8 ? 1.5 : 0}
            />
          )
        })}
        {data.map((p, i) => {
          if (i % step !== 0) return null
          const x = box.x + (data.length === 1 ? box.w / 2 : (i / (data.length - 1)) * box.w)
          return (
            <text key={i} x={x} y={box.y + box.h + 18} textAnchor="middle" fontSize="10" fill="#94a3b8">
              {p.sec}s
            </text>
          )
        })}
      </svg>
      <div className="legend">
        <span><i className="swatch" style={{ background: '#0ea77a' }} />活跃请求数</span>
      </div>
    </div>
  )
}

export function StatusBars({ items }: { items: { label: string; value: number; tone: string }[] }) {
  items = items ?? []
  const total = items.reduce((a, b) => a + b.value, 0)
  if (!total) return <ChartEmpty />
  return (
    <div className="status-bars">
      <div className="status-track">
        {items.map((it, i) => (
          <div
            key={i}
            className={`status-seg tone-${it.tone}`}
            style={{ width: `${(it.value / total) * 100}%` }}
            title={`${it.label}：${it.value}`}
          />
        ))}
      </div>
      <div className="status-legend">
        {items.map((it, i) => (
          <span key={i}>
            <i className={`swatch tone-${it.tone}`} />
            {it.label}
            <b>{fmtNum(it.value, 0)}</b>
          </span>
        ))}
      </div>
    </div>
  )
}
