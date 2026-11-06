import type { Aggregate, ModelReport, Report, RequestResult } from './types'
import {
  errorTypeLabel,
  fmtDuration,
  fmtInt,
  fmtMs,
  fmtNum,
  fmtPct,
  fmtTime,
  modeLabel,
  protocolLabel,
  statusLabel,
} from './format'

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function statsTable(agg: Aggregate): string {
  const rows: [string, string][] = [
    ['总请求数', fmtInt(agg.total)],
    ['成功 / 失败', `${fmtInt(agg.success)} / ${fmtInt(agg.failed)}`],
    ['成功率', fmtPct(agg.successRate)],
    ['吞吐 QPS', fmtNum(agg.qps, 2)],
    ['执行耗时', fmtDuration(agg.elapsedMs)],
    ['延迟 平均 / P50', `${fmtMs(agg.latency.avg)} / ${fmtMs(agg.latency.p50)}`],
    ['延迟 P90 / P95 / P99', `${fmtMs(agg.latency.p90)} / ${fmtMs(agg.latency.p95)} / ${fmtMs(agg.latency.p99)}`],
    ['延迟 最小 / 最大', `${fmtMs(agg.latency.min)} / ${fmtMs(agg.latency.max)}`],
    ['TTFT 平均 / P95', `${fmtMs(agg.ttft.avg)} / ${fmtMs(agg.ttft.p95)}`],
    ['平均输出 token/s', fmtNum(agg.tokens.avgTokensPerSec, 1)],
    ['输入 / 输出 token', `${fmtInt(agg.tokens.prompt)} / ${fmtInt(agg.tokens.completion)}`],
    ['估算 token 请求数', fmtInt(agg.tokens.estimated)],
  ]
  return `<table class="kv">${rows
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
    .join('')}</table>`
}

function failureTable(results: RequestResult[]): string {
  const failures = results.filter((r) => !r.ok)
  if (!failures.length) {
    return `<p class="ok-note">本模型全部请求均返回 200，未发现失败请求。</p>`
  }
  const shown = failures.slice(0, 1000)
  const rows = shown
    .map(
      (r) => `<tr>
        <td>#${r.index + 1}</td>
        <td>${esc(fmtOffset(r.startOffsetMs))}</td>
        <td class="err">${esc(r.status || 'ERR')}</td>
        <td>${esc(fmtMs(r.latencyMs))}</td>
        <td class="mono">${esc(r.requestId || '—')}</td>
        <td class="mono wrap">${esc(r.errorMessage || '—')}</td>
      </tr>`,
    )
    .join('')
  return `<table class="grid">
    <thead><tr><th>#</th><th>开始偏移</th><th>状态码</th><th>延迟</th><th>Request ID</th><th>错误信息</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${failures.length > shown.length ? `<p class="note">仅展示前 ${shown.length} 条失败请求，共 ${failures.length} 条。</p>` : ''}`
}

function fmtOffset(ms: number): string {
  return `${fmtNum(ms / 1000, 2)}s`
}

function seriesTable(agg: Aggregate): string {
  if (!agg.series?.length) return `<p class="note">无过程数据。</p>`
  const shown = agg.series.slice(0, 600)
  const rows = shown
    .map(
      (p) => `<tr>
        <td>${p.sec}s</td>
        <td>${fmtInt(p.started)}</td>
        <td>${fmtInt(p.completed)}</td>
        <td class="ok">${fmtInt(p.success)}</td>
        <td class="err">${fmtInt(p.failed)}</td>
        <td>${esc(fmtMs(p.avgLatency))}</td>
        <td>${fmtInt(p.concurrency)}</td>
      </tr>`,
    )
    .join('')
  return `<table class="grid">
    <thead><tr><th>时间</th><th>发起</th><th>完成</th><th>成功</th><th>失败</th><th>平均延迟</th><th>并发</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${agg.series.length > shown.length ? `<p class="note">仅展示前 ${shown.length} 秒，共 ${agg.series.length} 秒。</p>` : ''}`
}

function histogramBars(agg: Aggregate): string {
  if (!agg.histogram?.length) return `<p class="note">无延迟分布数据。</p>`
  const max = Math.max(1, ...agg.histogram.map((b) => b.count))
  return `<div class="hist">${agg.histogram
    .map(
      (b) => `<div class="hist-row">
        <span class="hist-label">${esc(fmtMs(b.from))} – ${esc(fmtMs(b.to))}</span>
        <span class="hist-track"><span class="hist-fill" style="width:${(b.count / max) * 100}%"></span></span>
        <span class="hist-count">${fmtInt(b.count)}</span>
      </div>`,
    )
    .join('')}</div>`
}

function errorsSection(agg: Aggregate): string {
  if (!agg.errors?.length) {
    return `<p class="ok-note">未记录到错误响应。</p>`
  }
  return agg.errors
    .map(
      (g) => `<div class="err-box">
        <div class="err-head">
          <strong>${esc(errorTypeLabel(g.type))}</strong>
          <span>出现 ${fmtInt(g.count)} 次</span>
          ${g.statuses.map((s) => `<span class="tag">HTTP ${esc(s)}</span>`).join('')}
          ${g.models.length ? `<span class="tag">${esc(g.models.join(', '))}</span>` : ''}
        </div>
        <pre>${esc(g.message)}</pre>
      </div>`,
    )
    .join('')
}

function modelSection(m: ModelReport): string {
  const agg = m.aggregate
  return `<section>
    <div class="model-head">
      <h2>${esc(m.model)}</h2>
      <span class="tag">${esc(protocolLabel(m.protocol))}</span>
    </div>
    <p class="endpoint-inline">${esc(m.endpoint)}</p>
    <div class="two-col">
      <div>
        <h3>指标汇总</h3>
        ${statsTable(agg)}
      </div>
      <div>
        <h3>延迟分布</h3>
        ${histogramBars(agg)}
        <h3 style="margin-top:26px">状态码分布</h3>
        <div class="tags">${
          agg.statusCodes.length
            ? agg.statusCodes.map((s) => `<span class="tag ${s.code === 200 ? 'tag-ok' : 'tag-err'}">${esc(s.code)} × ${fmtInt(s.count)}</span>`).join('')
            : '<span class="note">无数据</span>'
        }</div>
      </div>
    </div>

    <h3>错误详情</h3>
    ${errorsSection(agg)}

    <h3>失败请求明细</h3>
    ${failureTable(m.results)}
    ${m.resultsTruncated ? `<p class="note">请求明细已截断，仅保存前 20000 条；统计指标基于全部请求计算。</p>` : ''}

    <h3>测试过程数据（按秒）</h3>
    ${seriesTable(agg)}
  </section>`
}

const HTML_CSS = `
*{box-sizing:border-box}
body{margin:0;background:#f4f6f8;color:#1b2938;font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:1080px;margin:0 auto;padding:38px 24px 72px}
h1{font-size:29px;margin:6px 0 8px;letter-spacing:-.02em}
h2{font-size:20px;margin:0}
h3{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#64748b;margin:22px 0 10px}
.lead{color:#516477;margin:0 0 18px}
.meta-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}
.meta-cell{background:#fff;border:1px solid #e4e9ee;border-radius:10px;padding:12px 14px}
.meta-cell span{display:block;font-size:11px;color:#718190;text-transform:uppercase;letter-spacing:.06em}
.meta-cell b{font-size:14px;overflow-wrap:anywhere}
.endpoint{background:#e9eef2;border-radius:9px;padding:15px 17px;overflow-wrap:anywhere;font:12.5px/1.75 ui-monospace,SFMono-Regular,Consolas,monospace;color:#334155}
section{background:#fff;border:1px solid #dce4e9;border-radius:12px;padding:24px 26px;margin-top:16px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.stat{border:1px solid #e8edf1;border-radius:9px;padding:13px 15px;background:#fbfcfd}
.stat span{display:block;font-size:11px;color:#718190;letter-spacing:.05em;text-transform:uppercase}
.stat b{display:block;font-size:21px;margin-top:4px;font-variant-numeric:tabular-nums;color:#132436}
.stat small{color:#8194a3;font-size:11.5px}
table{width:100%;border-collapse:collapse;font-size:13px}
.kv th,.kv td{text-align:left;padding:7px 4px;border-bottom:1px solid #eef2f5}
.kv th{color:#66788a;font-weight:500;width:44%}
.kv td{font-variant-numeric:tabular-nums;font-weight:600;color:#1e3a52}
.grid th,.grid td{text-align:left;padding:8px 7px;border-bottom:1px solid #edf1f4;vertical-align:top}
.grid th{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#718190;background:#f8fafb}
.grid tr:last-child td{border-bottom:none}
.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px}
.wrap{white-space:pre-wrap;overflow-wrap:anywhere;max-width:420px}
.err{color:#c2410c;font-weight:600}
.ok{color:#0f766e;font-weight:600}
.model-head{display:flex;align-items:center;gap:10px}
.endpoint-inline{font:12px ui-monospace,monospace;color:#64748b;margin:6px 0 0;overflow-wrap:anywhere}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-top:8px}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{display:inline-block;background:#eef2f6;color:#455a6b;border-radius:5px;padding:2px 8px;font-size:11.5px}
.tag-ok{background:#e7f6f1;color:#0f766e}
.tag-err{background:#fdeceb;color:#b91c1c}
.err-box{border:1px solid #f3d3d0;background:#fdf6f5;border-radius:9px;padding:12px 14px;margin-bottom:10px}
.err-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px;color:#7c5a55;margin-bottom:8px}
.err-head strong{color:#b23c30;font-size:13px}
pre{margin:0;background:#1b2733;color:#e4edf4;padding:12px 14px;border-radius:7px;white-space:pre-wrap;overflow-wrap:anywhere;font:11.5px/1.6 ui-monospace,Consolas,monospace;max-height:260px;overflow:auto}
.hist{display:flex;flex-direction:column;gap:5px}
.hist-row{display:grid;grid-template-columns:96px 1fr 44px;align-items:center;gap:8px;font-size:11px;color:#64748b}
.hist-track{background:#eef2f6;border-radius:4px;height:9px;overflow:hidden}
.hist-fill{display:block;height:100%;background:linear-gradient(90deg,#0b8f66,#34d399);border-radius:4px}
.hist-count{text-align:right;font-variant-numeric:tabular-nums}
.ok-note{background:#eef8f4;color:#0f766e;border-radius:7px;padding:11px 14px;font-size:12.5px;margin:0}
.note{color:#7a8b99;font-size:11.5px;margin-top:10px}
.footer{margin-top:26px;color:#7a8b99;font-size:11.5px;line-height:1.8}
@media(max-width:820px){.meta-grid,.stats{grid-template-columns:1fr 1fr}.two-col{grid-template-columns:1fr}main{padding:24px 14px 50px}}
@media print{body{background:#fff}main{max-width:none;padding:0}section{break-inside:avoid;border-color:#d7dde3}}
`

export function buildReportHtml(report: Report): string {
  const cfg = report.config
  const endpoints = [...new Set(report.models.map((m) => m.endpoint).filter(Boolean))]
  const protocolsUsed =
    [...new Set(report.models.map((m) => protocolLabel(m.protocol)))].join(' / ') ||
    protocolLabel(cfg.protocol)
  const modelNames = report.models.map((m) => m.model).join(', ')
  const comparisonRows = report.models
    .map((m) => {
      const a = m.aggregate
      return `<tr>
        <td class="mono">${esc(m.model)}</td>
        <td>${esc(protocolLabel(m.protocol))}</td>
        <td>${fmtInt(a.total)}</td>
        <td class="${a.successRate >= 99 ? 'ok' : 'err'}">${fmtPct(a.successRate)}</td>
        <td>${fmtNum(a.qps, 2)}</td>
        <td>${esc(fmtMs(a.latency.avg))}</td>
        <td>${esc(fmtMs(a.latency.p95))}</td>
        <td>${esc(fmtMs(a.ttft.avg))}</td>
        <td>${fmtNum(a.tokens.avgTokensPerSec, 1)}</td>
        <td>${fmtNum(a.tokens.avgCompletion, 0)}</td>
      </tr>`
    })
    .join('')

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LLM API 压测报告 ${esc(report.id)}</title>
<style>${HTML_CSS}</style>
</head><body><main>
<h1>LLM API 压测报告</h1>
<p class="lead">报告编号 ${esc(report.id)} · 状态 ${esc(statusLabel(report.status))} · 生成于 ${esc(fmtTime(new Date().toISOString()))}</p>

<div class="meta-grid">
  <div class="meta-cell"><span>目标地址</span><b>${esc(cfg.baseUrl)}</b></div>
  <div class="meta-cell"><span>接口协议</span><b>${esc(protocolsUsed)}</b></div>
  <div class="meta-cell"><span>负载模式</span><b>${esc(modeLabel(cfg.mode))}</b></div>
  <div class="meta-cell"><span>执行耗时</span><b>${esc(fmtDuration(report.durationMs))}</b></div>
  <div class="meta-cell"><span>开始时间</span><b>${esc(fmtTime(report.startedAt))}</b></div>
  <div class="meta-cell"><span>结束时间</span><b>${esc(fmtTime(report.finishedAt))}</b></div>
  <div class="meta-cell"><span>响应模式</span><b>${cfg.stream ? '流式' : '非流式'}</b></div>
  <div class="meta-cell"><span>密钥</span><b>${esc(cfg.apiKey)}</b></div>
</div>

<div class="endpoint">模型：${esc(modelNames)}<br>接口：${endpoints.map((e) => `POST ${esc(e)}`).join('<br>') || esc(cfg.baseUrl)}<br>Authorization: Bearer ${esc(cfg.apiKey)}${cfg.systemPrompt ? `<br>System Prompt：${esc(cfg.systemPrompt)}` : ''}<br>User Prompt：${esc(cfg.prompt)}</div>

${report.error ? `<section><h3>执行异常</h3><pre>${esc(report.error)}</pre></section>` : ''}

<section>
  <h3>总体指标</h3>
  <div class="stats">
    <div class="stat"><span>总请求</span><b>${fmtInt(report.totals.total)}</b><small>成功 ${fmtInt(report.totals.success)} · 失败 ${fmtInt(report.totals.failed)}${report.totals.canceled ? ` · 未执行 ${fmtInt(report.totals.canceled)}` : ''}</small></div>
    <div class="stat"><span>成功率</span><b>${fmtPct(report.totals.successRate)}</b><small>错误率 ${fmtPct(report.totals.errorRate)}</small></div>
    <div class="stat"><span>吞吐 QPS</span><b>${fmtNum(report.totals.qps, 2)}</b><small>成功请求 / 秒</small></div>
    <div class="stat"><span>平均延迟</span><b>${esc(fmtMs(report.totals.latency.avg))}</b><small>P95 ${esc(fmtMs(report.totals.latency.p95))} · P99 ${esc(fmtMs(report.totals.latency.p99))}</small></div>
    <div class="stat"><span>平均 TTFT</span><b>${esc(fmtMs(report.totals.ttft.avg))}</b><small>P95 ${esc(fmtMs(report.totals.ttft.p95))}</small></div>
    <div class="stat"><span>输出速度</span><b>${fmtNum(report.totals.tokens.avgTokensPerSec, 1)}</b><small>token / 秒</small></div>
    <div class="stat"><span>输出 Token</span><b>${fmtInt(report.totals.tokens.completion)}</b><small>输入 ${fmtInt(report.totals.tokens.prompt)}</small></div>
    <div class="stat"><span>状态码种类</span><b>${fmtInt(report.totals.statusCodes.length)}</b><small>${report.totals.statusCodes.map((s) => `${s.code}×${s.count}`).join(' / ') || '—'}</small></div>
  </div>
</section>

${report.totals.errors.length
    ? `<section><h3>错误汇总（全部模型）</h3>${errorsSection(report.totals)}</section>`
    : ''}

<section>
  <h3>模型对比</h3>
  <table class="grid">
    <thead><tr><th>模型</th><th>协议</th><th>请求数</th><th>成功率</th><th>QPS</th><th>平均延迟</th><th>P95</th><th>平均 TTFT</th><th>tok/s</th><th>平均输出</th></tr></thead>
    <tbody>${comparisonRows || '<tr><td colspan="10">无数据</td></tr>'}</tbody>
  </table>
</section>

${report.models.map(modelSection).join('')}

<p class="footer">
  说明：TTFT 为流式响应首 token 到达时间；非流式请求的 TTFT 等于总延迟。Token 数优先采用接口返回的 usage，
  缺失时按文本长度估算（标记为估算）。QPS 为成功请求数除以执行耗时。本报告由 LLM Stress Lab 生成，
  所有数据来自本次实际请求，未执行或中断的请求不计入统计。
</p>
</main></body></html>`
}

export function downloadFile(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function exportReportHtml(report: Report) {
  downloadFile(`llm-stress-report-${report.id}.html`, buildReportHtml(report), 'text/html;charset=utf-8')
}

export function exportReportJson(report: Report) {
  downloadFile(`llm-stress-report-${report.id}.json`, JSON.stringify(report, null, 2), 'application/json')
}
