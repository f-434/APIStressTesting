const intFmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 })
const numFmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })

export function fmtInt(v: number | undefined | null): string {
  if (v == null || !isFinite(v)) return '—'
  return intFmt.format(Math.round(v))
}

export function fmtNum(v: number | undefined | null, digits = 2): string {
  if (v == null || !isFinite(v)) return '—'
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(v)
}

export function fmtPct(v: number | undefined | null): string {
  if (v == null || !isFinite(v)) return '—'
  return `${numFmt.format(v)}%`
}

export function fmtMs(v: number | undefined | null): string {
  if (v == null || !isFinite(v)) return '—'
  if (v < 1) return '<1 ms'
  if (v < 1000) return `${Math.round(v)} ms`
  return `${numFmt.format(v / 1000)} s`
}

export function fmtMsShort(v: number | undefined | null): string {
  if (v == null || !isFinite(v)) return '—'
  if (v < 1000) return `${Math.round(v)}`
  return `${numFmt.format(v / 1000)}s`
}

export function fmtDuration(ms: number | undefined | null): string {
  if (ms == null || !isFinite(ms)) return '—'
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function fmtTime(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function fmtClock(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function fmtBytes(v: number | undefined | null): string {
  if (v == null || !isFinite(v)) return '—'
  if (v < 1024) return `${Math.round(v)} B`
  if (v < 1024 * 1024) return `${numFmt.format(v / 1024)} KB`
  return `${numFmt.format(v / 1024 / 1024)} MB`
}

export function fmtOffset(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${numFmt.format(s)}s`
  const m = Math.floor(s / 60)
  const rest = Math.round(s % 60)
  return `${m}m${String(rest).padStart(2, '0')}s`
}

export function protocolLabel(p: string): string {
  switch (p) {
    case 'claude':
      return 'Claude 原生'
    case 'gemini':
      return 'Gemini 原生'
    case 'openai':
      return 'OpenAI 兼容'
    default:
      return '自动识别'
  }
}

export function modeLabel(m: string): string {
  switch (m) {
    case 'duration':
      return '按时长'
    case 'ramp':
      return '阶梯并发'
    default:
      return '固定请求数'
  }
}

export function statusLabel(s: string): string {
  switch (s) {
    case 'completed':
      return '已完成'
    case 'stopped':
      return '已停止'
    case 'failed':
      return '执行失败'
    case 'running':
      return '运行中'
    default:
      return s
  }
}

export function errorTypeLabel(t: string): string {
  switch (t) {
    case 'http':
      return 'HTTP 错误'
    case 'network':
      return '网络错误'
    case 'timeout':
      return '请求超时'
    case 'api':
      return '接口错误'
    case 'stream':
      return '流式中断'
    case 'parse':
      return '解析失败'
    case 'protocol':
      return '协议不匹配'
    case 'request':
      return '请求构造失败'
    default:
      return t || '未知错误'
  }
}
