import type {
  LiveUpdate,
  ModelsResponse,
  Protocol,
  TestConfig,
  TestResponse,
  TestSummary,
} from './types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const text = await res.text()
  let data: any = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }
  if (!res.ok) {
    const message = data?.error || `请求失败（HTTP ${res.status}）`
    throw new Error(message)
  }
  return data as T
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export function fetchModels(baseUrl: string, apiKey: string, protocol: Protocol) {
  return request<ModelsResponse>('/api/models', jsonInit('POST', { baseUrl, apiKey, protocol }))
}

export function startTest(config: TestConfig) {
  return request<{ id: string; status: string }>('/api/tests', jsonInit('POST', config))
}

export function getTest(id: string) {
  return request<TestResponse>(`/api/tests/${encodeURIComponent(id)}`)
}

export function listTests() {
  return request<{ tests: TestSummary[] }>('/api/tests')
}

export function stopTest(id: string) {
  return request<{ ok: boolean; id: string }>(
    `/api/tests/${encodeURIComponent(id)}/stop`,
    jsonInit('POST', {}),
  )
}

export interface LiveHandlers {
  onSnapshot?: (live: LiveUpdate) => void
  onUpdate?: (live: LiveUpdate) => void
  onDone?: (payload: { testId: string; status: string; error?: string }) => void
  onError?: (message: string) => void
}

export function subscribeTest(id: string, handlers: LiveHandlers): EventSource {
  const es = new EventSource(`/api/tests/${encodeURIComponent(id)}/events`)

  const parse = (raw: string): LiveUpdate | null => {
    try {
      return JSON.parse(raw) as LiveUpdate
    } catch {
      return null
    }
  }

  es.addEventListener('snapshot', (e) => {
    const live = parse((e as MessageEvent).data)
    if (live) handlers.onSnapshot?.(live)
  })
  es.addEventListener('update', (e) => {
    const live = parse((e as MessageEvent).data)
    if (live) handlers.onUpdate?.(live)
  })
  es.addEventListener('done', (e) => {
    try {
      const payload = JSON.parse((e as MessageEvent).data)
      handlers.onDone?.(payload)
    } catch {
      handlers.onDone?.({ testId: id, status: 'completed' })
    }
    es.close()
  })
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      handlers.onError?.('实时连接已断开')
    }
  }
  return es
}
