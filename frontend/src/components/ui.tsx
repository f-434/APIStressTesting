import type { ReactNode } from 'react'
import { protocolLabel, statusLabel } from '../format'

export function Icon({
  name,
  size = 16,
}: {
  name: 'play' | 'stop' | 'refresh' | 'download' | 'check' | 'alert' | 'clock' | 'zap' | 'layers' | 'link' | 'key' | 'search' | 'chevron' | 'trash' | 'plus' | 'arrow' | 'file'
  size?: number
}) {
  const paths: Record<string, ReactNode> = {
    play: <path d="M6 4.5v15l13-7.5-13-7.5Z" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    refresh: (
      <>
        <path d="M20 11a8 8 0 1 0-2.34 5.66" />
        <path d="M20 4v7h-7" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M4 20h16" />
      </>
    ),
    check: <path d="m4 12 5 5L20 6" />,
    alert: (
      <>
        <path d="M12 3 2 20h20L12 3Z" />
        <path d="M12 9v5" />
        <path d="M12 17.5v.5" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </>
    ),
    zap: <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />,
    layers: (
      <>
        <path d="m12 3 9 5-9 5-9-5 9-5Z" />
        <path d="m3 13 9 5 9-5" />
      </>
    ),
    link: (
      <>
        <path d="M10 14a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L11 5.93" />
        <path d="M14 10a5 5 0 0 0-7.07 0L4.8 12.12a5 5 0 0 0 7.07 7.07L13 18.07" />
      </>
    ),
    key: (
      <>
        <circle cx="8" cy="14" r="4" />
        <path d="m11 11 8-8" />
        <path d="m16 6 2 2" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4 4" />
      </>
    ),
    chevron: <path d="m9 6 6 6-6 6" />,
    trash: (
      <>
        <path d="M4 7h16" />
        <path d="M9 7V5h6v2" />
        <path d="M6 7l1 13h10l1-13" />
      </>
    ),
    plus: (
      <>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h14" />
        <path d="m13 6 6 6-6 6" />
      </>
    ),
    file: (
      <>
        <path d="M6 3h8l4 4v14H6V3Z" />
        <path d="M14 3v4h4" />
        <path d="M9 12h6M9 16h6" />
      </>
    ),
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths[name]}
    </svg>
  )
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'ok' | 'danger' | 'warn' | 'claude' | 'gemini' | 'openai'
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function ProtocolBadge({ protocol }: { protocol: string }) {
  const tone =
    protocol === 'claude' ? 'claude' : protocol === 'gemini' ? 'gemini' : protocol === 'openai' ? 'openai' : 'neutral'
  return <Badge tone={tone as any}>{protocolLabel(protocol)}</Badge>
}

export function StatusPill({ status }: { status: string }) {
  const tone = status === 'completed' ? 'ok' : status === 'running' ? 'accent' : status === 'stopped' ? 'warn' : 'danger'
  return (
    <span className={`status-pill tone-${tone}`}>
      <i className={status === 'running' ? 'dot pulse' : 'dot'} />
      {statusLabel(status)}
    </span>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
  hint?: string
}) {
  return (
    <label className="switch-row">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`switch ${checked ? 'on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
      {(label || hint) && (
        <span className="switch-text">
          {label && <span className="switch-label">{label}</span>}
          {hint && <span className="switch-hint">{hint}</span>}
        </span>
      )}
    </label>
  )
}

export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string
  hint?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`field ${className}`}>
      <div className="field-head">
        <span className="field-label">{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

export function Stat({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'default' | 'ok' | 'danger' | 'accent'
}) {
  return (
    <div className={`stat stat-${tone}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub != null && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />
}

export function Empty({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="empty">
      <div className="empty-mark">
        <Icon name="layers" size={22} />
      </div>
      <div className="empty-title">{title}</div>
      {desc && <div className="empty-desc">{desc}</div>}
    </div>
  )
}

export function InlineError({ children }: { children: ReactNode }) {
  return (
    <div className="inline-error">
      <Icon name="alert" size={15} />
      <span>{children}</span>
    </div>
  )
}
