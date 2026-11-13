'use strict'
/**
 * LLM 客户端（支持多 provider + 自动故障转移 + 自动切回主模型）。
 *
 * 设计目标：
 *   主模型失效时自动切到备用，主模型恢复后自动切回。
 *
 * 关键设计（用户问的"怎么切回主"）：
 *   **指数退避探测** —— 主模型失败后，隔 30s 探一次，没通就 1min、2min、5min、
 *   10min、30min（之后固定 30min 一次）。探测请求只有 max_tokens=1，成本几乎为零。
 *   探测成功就立刻切回，退避重置。
 *
 *   对比固定间隔：主模型挂 2 小时，固定 30s 轮询要打 240 次，
 *   指数退避只打约 10 次，省 96% 的无效请求。
 *
 * 错误分类（决定切多快、探多勤）：
 *   401/403 (key 失效/额度用完) -> 立即切，探测间隔从 30s 起
 *   429 (限流)                  -> 先等 30s 重试，还不行再切
 *   超时 / 5xx (服务挂了)        -> 重试 2 次，还不行切
 */

const https = require('https')
const http = require('http')
const { URL } = require('url')

// 探测退避序列（毫秒）
const PROBE_BACKOFF = [30e3, 60e3, 120e3, 300e3, 600e3, 1800e3]

// 错误分类
function classifyError (err) {
  const msg = String(err && err.message || err || '')
  const m = msg.match(/HTTP (\d{3})/)
  const code = m ? parseInt(m[1], 10) : 0
  if (code === 401 || code === 403) return 'auth'      // key/额度问题，切了立刻探
  if (code === 429) return 'ratelimit'                 // 限流
  if (code >= 500) return 'server'                     // 服务端挂了
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN/.test(msg)) return 'network'
  if (/no choices|parse:/.test(msg)) return 'badresponse'
  return 'unknown'
}

class LLM {
  /**
   * @param {object} cfg  兼容两种格式：
   *   旧: { baseUrl, apiKey, model }
   *   新: { providers: [{ name, baseUrl, apiKey, model }] }
   */
  constructor (cfg) {
    this.cfg = cfg || {}

    // 归一化 provider 列表
    if (Array.isArray(this.cfg.providers) && this.cfg.providers.length) {
      this.providers = this.cfg.providers.map((p, i) => ({
        name: p.name || ('provider' + (i + 1)),
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: p.model || this.cfg.model,
        temperature: p.temperature != null ? p.temperature : this.cfg.temperature,
        chatMaxTokens: p.chatMaxTokens || this.cfg.chatMaxTokens
      }))
    } else if (this.cfg.baseUrl && this.cfg.apiKey) {
      this.providers = [{
        name: 'default',
        baseUrl: this.cfg.baseUrl,
        apiKey: this.cfg.apiKey,
        model: this.cfg.model,
        temperature: this.cfg.temperature,
        chatMaxTokens: this.cfg.chatMaxTokens
      }]
    } else {
      this.providers = []
    }

    this.activeIndex = 0                 // 当前用第几个
    this.stats = { calls: 0, promptTokens: 0, completionTokens: 0, fails: 0 }
    this.health = this.providers.map(() => ({
      ok: true,
      lastFailAt: 0,
      consecutiveFails: 0,
      lastError: null,
      probeLevel: 0,        // 退避档位
      nextProbeAt: 0,       // 下次允许探测的时间
      probeInFlight: false
    }))
    this.switchLog = []                  // 切换历史（最多 20 条）
    this.log = this.cfg.log || (() => {})
    this._probeTimer = null
  }

  /** 当前在用的 provider */
  get current () {
    const p = this.providers[this.activeIndex]
    return p ? { ...p, index: this.activeIndex } : null
  }

  /** 是否在主模型上 */
  get onPrimary () { return this.activeIndex === 0 }

  /** 状态摘要（给 /xj 面板或日志用） */
  status () {
    const cur = this.current
    return {
      active: cur ? cur.name : '(none)',
      model: cur ? cur.model : null,
      onPrimary: this.onPrimary,
      total: this.providers.length,
      health: this.providers.map((p, i) => ({
        name: p.name,
        ok: this.health[i].ok,
        fails: this.health[i].consecutiveFails,
        lastError: this.health[i].lastError
      })),
      switches: this.switchLog.slice(-5)
    }
  }

  // ============ 主流程 ============

  async chat (messages, opts = {}) {
    if (!this.providers.length) throw new Error('没有配置任何 LLM provider')

    // 启动时顺便检查一次要不要探测（不阻塞本次调用）
    this._scheduleProbe()

    const tries = opts.tries || 3
    const total = this.providers.length
    let lastErr = null

    // 依次试：当前 -> 下一个 -> ... 绕一圈
    for (let hop = 0; hop < total; hop++) {
      const idx = (this.activeIndex + hop) % total
      const p = this.providers[idx]
      const h = this.health[idx]

      // 跳过"已知 auth 失败且还没到探测时间"的 provider
      // auth 错误（401/403）不会自己好，重试纯浪费
      if (hop > 0 && !h.ok && h.nextProbeAt > Date.now() &&
          h.lastError && /HTTP 40[13]/.test(h.lastError)) {
        continue
      }

      for (let t = 0; t < tries; t++) {
        try {
          const r = await this._once(p, messages, opts)
          // 成功
          this._markOk(idx)
          if (idx !== this.activeIndex) {
            // 这一跳是备用救回来的，切过去
            this._switchTo(idx, 'fallback succeeded')
          }
          return r
        } catch (e) {
          lastErr = e
          this.stats.fails++
          const kind = classifyError(e)
          this._markFail(idx, e, kind)

          // 429 限流：只等一次（10s），还不行就换 provider
          // 原来等 30s 且重试 3 次 = 90 秒，全耗在一个 provider 上
          if (kind === 'ratelimit' && t === 0) {
            await sleep(10000)
            continue
          }
          // auth 错误重试没意义，直接下一跳
          if (kind === 'auth') break
          // 其他错误短暂等待后重试
          if (t < tries - 1) {
            await sleep(1200 * (t + 1))
            continue
          }
          break
        }
      }

      // 这一跳彻底失败，试下一个
      // 关键：优先切到"健康"的 provider，别切回刚失效的那个
      if (idx === this.activeIndex && total > 1) {
        const next = this._pickHealthy(idx)
        if (next >= 0) {
          this._switchTo(next, `failover: ${classifyError(lastErr)}`)
        } else {
          // 全都标记不健康：挑连续失败次数最少的那个（相对最好）
          let best = (idx + 1) % total
          let bestFails = Infinity
          for (let k = 0; k < total; k++) {
            if (k === idx) continue
            const f = this.health[k].consecutiveFails
            if (f < bestFails) { bestFails = f; best = k }
          }
          this._switchTo(best, `failover(no healthy): ${classifyError(lastErr)}`)
        }
      }
    }

    throw lastErr || new Error('所有 provider 都失败了')
  }

  async json (messages, opts = {}) {
    const r = await this.chat(messages, Object.assign({}, opts, { json: true }))
    return parseJsonLoose(r.text)
  }

  // ============ 健康管理 ============

  _markOk (idx) {
    const h = this.health[idx]
    h.ok = true
    h.consecutiveFails = 0
    h.lastError = null
    h.probeLevel = 0
    h.nextProbeAt = 0
  }

  _markFail (idx, err, kind) {
    const h = this.health[idx]
    const now = Date.now()
    h.ok = false
    h.lastFailAt = now
    h.consecutiveFails++
    h.lastError = String(err && err.message || err).slice(0, 120)

    // 安排探测：指数退避
    const level = Math.min(h.probeLevel, PROBE_BACKOFF.length - 1)
    const wait = kind === 'auth'
      ? Math.max(30e3, PROBE_BACKOFF[Math.min(level, 2)])   // key 问题探得勤一点
      : PROBE_BACKOFF[level]
    h.nextProbeAt = now + wait
    this.log(`[llm] ${this.providers[idx].name} 失败（${kind}），${Math.round(wait / 1000)}s 后再试`)
  }

  /** 找一个"健康"的 provider（排除 current） */
  _pickHealthy (excludeIdx) {
    const total = this.providers.length
    for (let hop = 1; hop < total; hop++) {
      const idx = (excludeIdx + hop) % total
      const h = this.health[idx]
      // 健康 且 不是刚才 auth 失败的（auth 错误短期内不会自己好）
      if (h.ok && h.consecutiveFails === 0) return idx
    }
    return -1
  }

  _switchTo (idx, reason) {
    if (idx === this.activeIndex) return
    const from = this.providers[this.activeIndex]
    const to = this.providers[idx]
    this.activeIndex = idx
    const rec = {
      at: Date.now(),
      from: from ? from.name : '?',
      to: to ? to.name : '?',
      reason
    }
    this.switchLog.push(rec)
    if (this.switchLog.length > 20) this.switchLog.shift()
    this.log(`[llm] 切换 ${rec.from} -> ${rec.to}（${reason}）`)
  }

  /**
   * 探测主模型：到点了就用极小请求试一次，通了就切回。
   * 这是"主模型恢复后自动切回"的核心。
   */
  _scheduleProbe () {
    if (this._probeTimer) return
    this._probeTimer = setInterval(() => { this._probePrimary().catch(() => {}) }, 15000)
    if (this._probeTimer.unref) this._probeTimer.unref()
  }

  async _probePrimary () {
    // 已经在主模型上，不用探
    if (this.activeIndex === 0) return
    if (this.providers.length < 2) return

    const h = this.health[0]
    if (h.probeInFlight) return
    if (Date.now() < h.nextProbeAt) return

    h.probeInFlight = true
    try {
      this.log(`[llm] 探测主模型 ${this.providers[0].name}...`)
      const r = await this._once(this.providers[0], [
        { role: 'user', content: 'hi' }
      ], { maxTokens: 1, timeout: 15000 })

      // 通了
      this._markOk(0)
      this._switchTo(0, '主模型恢复了')
      this.log(`[llm] ✅ 主模型恢复，已切回（回复: ${JSON.stringify((r.text || '').slice(0, 10))}）`)
    } catch (e) {
      const kind = classifyError(e)
      const hh = this.health[0]
      hh.probeLevel = Math.min(hh.probeLevel + 1, PROBE_BACKOFF.length - 1)
      const wait = PROBE_BACKOFF[hh.probeLevel]
      hh.nextProbeAt = Date.now() + wait
      this.log(`[llm] 主模型还没好（${kind}），${Math.round(wait / 1000)}s 后再探`)
    } finally {
      h.probeInFlight = false
    }
  }

  /** 手动指定用哪个（调试用） */
  use (nameOrIndex) {
    const idx = typeof nameOrIndex === 'number'
      ? nameOrIndex
      : this.providers.findIndex(p => p.name === nameOrIndex)
    if (idx >= 0 && idx < this.providers.length) {
      this._switchTo(idx, 'manual')
      return true
    }
    return false
  }

  destroy () {
    if (this._probeTimer) { clearInterval(this._probeTimer); this._probeTimer = null }
  }

  // ============ 单次 HTTP ============

  _once (p, messages, opts = {}) {
    const body = {
      model: p.model,
      messages,
      temperature: opts.temperature != null ? opts.temperature : p.temperature,
      max_tokens: opts.maxTokens || p.chatMaxTokens,
      stream: false
    }
    if (opts.json) body.response_format = { type: 'json_object' }
    if (opts.stop) body.stop = opts.stop

    const payload = JSON.stringify(body)
    const u = new URL(String(p.baseUrl).replace(/\/$/, '') + '/chat/completions')
    const mod = u.protocol === 'https:' ? https : http

    return new Promise((resolve, reject) => {
      const req = mod.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + p.apiKey,
          'content-length': Buffer.byteLength(payload)
        },
        timeout: opts.timeout || 120000
      }, res => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', d => { data += d })
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error('HTTP ' + res.statusCode + ' ' + data.slice(0, 200)))
          }
          try {
            const j = JSON.parse(data)
            const ch = j.choices && j.choices[0]
            if (!ch) return reject(new Error('no choices: ' + data.slice(0, 200)))
            const msg = ch.message || {}
            this.stats.calls++
            if (j.usage) {
              this.stats.promptTokens += j.usage.prompt_tokens || 0
              this.stats.completionTokens += j.usage.completion_tokens || 0
            }
            resolve({
              text: (msg.content || '').trim(),
              reasoning: (msg.reasoning_content || msg.reasoning || '').trim(),
              finish: ch.finish_reason,
              provider: p.name,
              model: p.model,
              raw: j
            })
          } catch (e) {
            reject(new Error('parse: ' + e.message + ' body=' + data.slice(0, 200)))
          }
        })
      })
      req.on('timeout', () => { req.destroy(new Error('timeout')) })
      req.on('error', reject)
      req.write(payload)
      req.end()
    })
  }
}

function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

function parseJsonLoose (text) {
  if (!text) throw new Error('empty json reply')
  let s = text.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) s = fence[1].trim()
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a >= 0 && b > a) s = s.slice(a, b + 1)
  try {
    return JSON.parse(s)
  } catch (e) {
    let t = s.replace(/，/g, ',').replace(/：/g, ':').replace(/,\s*([}\]])/g, '$1')
    try { return JSON.parse(t) } catch (e2) {
      throw new Error('bad json: ' + text.slice(0, 300))
    }
  }
}

module.exports = { LLM, parseJsonLoose, classifyError, PROBE_BACKOFF }
