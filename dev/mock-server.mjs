// Minimal mock of a New API / OpenAI / Claude / Gemini compatible relay.
// Usage: node dev/mock-server.mjs [port]   (default 9099)
import http from 'node:http'

const PORT = Number(process.argv[2] || 9099)
const KEY = 'sk-test'

const MODELS = [
  { id: 'gpt-4o-mini', owned_by: 'openai' },
  { id: 'gpt-4.1', owned_by: 'openai' },
  { id: 'claude-sonnet-4-20250514', owned_by: 'anthropic' },
  { id: 'gemini-2.5-flash', owned_by: 'google' },
  { id: 'text-embedding-3-small', owned_by: 'openai' },
  { id: 'whisper-1', owned_by: 'openai' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rid = () => `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function sendJSON(res, status, body, requestId = rid()) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'x-oneapi-request-id': requestId,
  })
  res.end(JSON.stringify(body))
}

function authorized(req, url) {
  const auth = req.headers.authorization || ''
  const xKey = req.headers['x-api-key'] || req.headers['x-goog-api-key'] || ''
  const qKey = url.searchParams.get('key') || ''
  const token = auth.replace(/^Bearer\s+/i, '') || xKey || qKey
  return token === KEY
}

function errorPayload(message) {
  return { error: { message, type: 'new_api_error', code: 'mock_error' } }
}

function collect(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })
}

const WORDS = '压测平台正在返回一段模拟的模型输出，用于验证并发与统计逻辑。'.split('')

function sse(res, headers = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'x-oneapi-request-id': rid(),
    ...headers,
  })
}

async function openaiStream(res, model, promptTokens) {
  sse(res)
  const total = 8
  for (let i = 0; i < total; i++) {
    await sleep(i === 0 ? 120 : 45)
    const delta = { content: WORDS[i % WORDS.length] }
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`,
    )
  }
  res.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: promptTokens, completion_tokens: total, total_tokens: promptTokens + total },
    })}\n\n`,
  )
  res.write('data: [DONE]\n\n')
  res.end()
}

async function claudeStream(res, promptTokens) {
  sse(res)
  res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: promptTokens, output_tokens: 1 } } })}\n\n`)
  const total = 8
  for (let i = 0; i < total; i++) {
    await sleep(i === 0 ? 110 : 42)
    res.write(
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: WORDS[i % WORDS.length] },
      })}\n\n`,
    )
  }
  res.write(
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: total } })}\n\n`,
  )
  res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
  res.end()
}

async function geminiStream(res, promptTokens) {
  sse(res)
  const total = 8
  for (let i = 0; i < total; i++) {
    await sleep(i === 0 ? 115 : 44)
    res.write(
      `data: ${JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: WORDS[i % WORDS.length] }], role: 'model' },
            finishReason: i === total - 1 ? 'STOP' : undefined,
          },
        ],
        usageMetadata: {
          promptTokenCount: promptTokens,
          candidatesTokenCount: i + 1,
          totalTokenCount: promptTokens + i + 1,
        },
      })}\n\n`,
    )
  }
  res.end()
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname

  if (path === '/v1/models' && req.method === 'GET') {
    if (!authorized(req, url)) {
      return sendJSON(res, 401, errorPayload('无效的令牌 (request id: mock)'))
    }
    return sendJSON(res, 200, { object: 'list', data: MODELS })
  }

  if (path === '/v1beta/models' && req.method === 'GET') {
    if (!authorized(req, url)) {
      return sendJSON(res, 401, errorPayload('API key not valid'))
    }
    return sendJSON(res, 200, {
      models: MODELS.filter((m) => m.owned_by === 'google').map((m) => ({
        name: `models/${m.id}`,
        displayName: m.id,
      })),
    })
  }

  if (path === '/v1/chat/completions' && req.method === 'POST') {
    const body = await collect(req)
    if (!authorized(req, url)) {
      return sendJSON(res, 401, errorPayload('无效的令牌：请求未携带有效的 API Key'))
    }
    if (String(body.model).includes('broken')) {
      return sendJSON(res, 500, errorPayload('模型服务暂时不可用：上游连接超时'))
    }
    if (Math.random() < 0.08) {
      return sendJSON(res, 429, errorPayload('当前分组上游负载已饱和，请稍后重试'))
    }
    const promptTokens = 18 + Math.floor(Math.random() * 6)
    await sleep(60 + Math.random() * 120)
    if (body.stream) return openaiStream(res, body.model, promptTokens)
    return sendJSON(res, 200, {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: WORDS.slice(0, 8).join('') },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: promptTokens, completion_tokens: 8, total_tokens: promptTokens + 8 },
    })
  }

  if (path === '/v1/messages' && req.method === 'POST') {
    const body = await collect(req)
    if (!authorized(req, url)) {
      return sendJSON(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
    }
    const promptTokens = 20 + Math.floor(Math.random() * 6)
    await sleep(60 + Math.random() * 100)
    if (body.stream) return claudeStream(res, promptTokens)
    return sendJSON(res, 200, {
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text: WORDS.slice(0, 8).join('') }],
      stop_reason: 'end_turn',
      usage: { input_tokens: promptTokens, output_tokens: 8 },
    })
  }

  if (path.startsWith('/v1beta/models/') && req.method === 'POST') {
    const stream = path.endsWith(':streamGenerateContent')
    const m = path.match(/\/v1beta\/models\/([^:]+):/)
    const model = decodeURIComponent(m ? m[1] : 'gemini-2.5-flash')
    if (!authorized(req, url)) {
      return sendJSON(res, 400, { error: { code: 400, message: 'API key not valid', status: 'INVALID_ARGUMENT' } })
    }
    const promptTokens = 22 + Math.floor(Math.random() * 5)
    await sleep(60 + Math.random() * 100)
    if (stream) return geminiStream(res, promptTokens)
    return sendJSON(res, 200, {
      candidates: [
        {
          content: { parts: [{ text: WORDS.slice(0, 8).join('') }], role: 'model' },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: 8, totalTokenCount: promptTokens + 8 },
    })
  }

  sendJSON(res, 404, errorPayload(`Invalid URL (${req.method} ${path})`))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock relay listening on http://127.0.0.1:${PORT} (key: ${KEY})`)
})
