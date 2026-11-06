// Headless Chrome screenshot via CDP (works with long-lived SSE pages).
// Usage: node --experimental-websocket dev/screenshot.mjs <url> <out.png> [width] [maxHeight]
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2]
const out = process.argv[3]
const width = Number(process.argv[4] || 1440)
const maxHeight = Number(process.argv[5] || 8000)
if (!url || !out) {
  console.error('usage: node --experimental-websocket dev/screenshot.mjs <url> <out.png> [width] [maxHeight]')
  process.exit(1)
}

const chrome =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = join(tmpdir(), `llm-stress-shot-${Date.now()}`)
const port = 9322 + Math.floor(Math.random() * 200)

const child = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-extensions',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},1700`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitDevtools() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
    } catch {
      /* retry */
    }
    await sleep(150)
  }
  throw new Error('devtools not ready')
}

let ws
let seq = 0
const pending = new Map()

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function main() {
  await waitDevtools()
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  })
  const target = await res.json()

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = (e) => reject(new Error('ws error: ' + e.message))
  })
  ws.onmessage = (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    }
  }

  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 1700,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await send('Page.navigate', { url })
  await sleep(4500)

  const metrics = await send('Page.getLayoutMetrics')
  const content = metrics.cssContentSize || metrics.contentSize
  const height = Math.min(Math.max(content.height, 600), maxHeight)

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  })
  mkdirSync(join(out, '..'), { recursive: true })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(`saved ${out} (${width}x${Math.round(height)})`)
}

main()
  .catch((e) => {
    console.error(e.message)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
    child.kill()
    await sleep(300)
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })
