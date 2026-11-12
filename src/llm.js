'use strict'
// LLM 客户端。这个中转的模型带思维链，正文和 reasoning 是分开返回的。

const https = require('https')
const http = require('http')
const { URL } = require('url')

class LLM {
  constructor (cfg) {
    this.cfg = cfg
    this.stats = { calls: 0, promptTokens: 0, completionTokens: 0, fails: 0 }
  }

  // 单次调用，带重试
  async chat (messages, opts = {}) {
    const tries = opts.tries || 3
    let lastErr = null
    for (let i = 0; i < tries; i++) {
      try {
        return await this._once(messages, opts)
      } catch (e) {
        lastErr = e
        this.stats.fails++
        const wait = 1200 * (i + 1)
        await new Promise(r => setTimeout(r, wait))
      }
    }
    throw lastErr
  }

  _once (messages, opts) {
    const cfg = this.cfg
    const body = {
      model: cfg.model,
      messages,
      temperature: opts.temperature != null ? opts.temperature : cfg.temperature,
      max_tokens: opts.maxTokens || cfg.chatMaxTokens,
      stream: false
    }
    if (opts.json) body.response_format = { type: 'json_object' }
    if (opts.stop) body.stop = opts.stop

    const payload = JSON.stringify(body)
    const u = new URL(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions')
    const mod = u.protocol === 'https:' ? https : http

    return new Promise((resolve, reject) => {
      const req = mod.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + cfg.apiKey,
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

  // 要 JSON 的调用，容忍模型带 ``` 包裹
  async json (messages, opts = {}) {
    const r = await this.chat(messages, Object.assign({}, opts, { json: true }))
    return parseJsonLoose(r.text)
  }
}

function parseJsonLoose (text) {
  if (!text) throw new Error('empty json reply')
  let s = text.trim()
  // 去掉 ```json ... ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) s = fence[1].trim()
  // 截取第一个 { 到最后一个 }
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a >= 0 && b > a) s = s.slice(a, b + 1)
  try {
    return JSON.parse(s)
  } catch (e) {
    // 常见问题：尾逗号、中文引号
    let t = s.replace(/，/g, ',').replace(/：/g, ':').replace(/,\s*([}\]])/g, '$1')
    try { return JSON.parse(t) } catch (e2) {
      throw new Error('bad json: ' + text.slice(0, 300))
    }
  }
}

module.exports = { LLM, parseJsonLoose }
