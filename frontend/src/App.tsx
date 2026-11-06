import { useCallback, useEffect, useState } from 'react'
import { ConfigPage } from './components/ConfigPage'
import { HistoryPage } from './components/HistoryPage'
import { ReportPage } from './components/ReportPage'
import { RunPage } from './components/RunPage'
import { Icon } from './components/ui'

type Route =
  | { view: 'config' }
  | { view: 'history' }
  | { view: 'run'; id: string }
  | { view: 'report'; id: string }

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const parts = raw.split('/').filter(Boolean)
  if (parts[0] === 'run' && parts[1]) return { view: 'run', id: decodeURIComponent(parts[1]) }
  if (parts[0] === 'report' && parts[1]) return { view: 'report', id: decodeURIComponent(parts[1]) }
  if (parts[0] === 'history') return { view: 'history' }
  return { view: 'config' }
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash)

  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash())
      window.scrollTo({ top: 0, behavior: 'auto' })
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const goRun = useCallback((id: string) => {
    window.location.hash = `#/run/${encodeURIComponent(id)}`
  }, [])

  const goReport = useCallback((id: string) => {
    window.location.hash = `#/report/${encodeURIComponent(id)}`
  }, [])

  const navActive = (target: 'config' | 'history') => {
    if (target === 'history') return route.view === 'history'
    return route.view === 'config'
  }

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          <span className="brand-mark">
            <Icon name="zap" size={19} />
          </span>
          <span className="brand-text">
            <span className="brand-name">LLM Stress Lab</span>
            <span className="brand-sub">大模型 API 压测台</span>
          </span>
        </a>

        <nav className="nav">
          <a href="#/" className={navActive('config') ? 'active' : ''}>新建压测</a>
          <a href="#/history" className={navActive('history') ? 'active' : ''}>历史报告</a>
        </nav>

        <div className="topbar-meta">
          <span className="live-dot" />
          本地运行 · 数据不出本机
        </div>
      </header>

      <main className="page">
        {route.view === 'config' && <ConfigPage onStart={goRun} />}
        {route.view === 'run' && <RunPage key={route.id} id={route.id} onReport={goReport} />}
        {route.view === 'report' && <ReportPage key={route.id} id={route.id} onOpenRun={goRun} />}
        {route.view === 'history' && (
          <HistoryPage onOpen={(id, running) => (running ? goRun(id) : goReport(id))} />
        )}
      </main>

      <footer className="footer">
        <span>LLM Stress Lab · Go + React</span>
        <span>请仅对已获授权的接口进行压测</span>
      </footer>
    </div>
  )
}
