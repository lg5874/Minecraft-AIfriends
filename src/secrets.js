'use strict'
/**
 * 秘密。
 *
 * 张三私下跟他说"别告诉李四我藏了东西在这"。
 *
 * 真人怎么处理：
 *   - 不会主动说
 *   - 被直接问到，会装糊涂、岔开、或者"我不太清楚"
 *   - 但不是铁桶 —— 关系够近、问得巧、或者被套话，可能会漏
 *   - 漏了之后会心虚，可能事后找补
 *
 * 所以这里不是"锁死"，是"有门槛"。
 */

const { cnChars } = require('./memory/text')

const SECRET_HINTS = [
  /(别告诉|不要告诉|别说出去|别说给|保密|就你知道|别让他知道|别跟.*说)/,
  /(悄悄的|偷偷的|暗地里)/
]

/**
 * 从一句话里判断是不是在托付秘密。
 * @returns {{isSecret:boolean, about:string, content:string}|null}
 */
function detect (text, speaker) {
  const t = String(text || '')
  if (!SECRET_HINTS.some(re => re.test(t))) return null

  // 猜一下是在瞒着谁
  let about = ''
  const m = t.match(/(?:别告诉|不要告诉|别说给|别让)\s*([\u4e00-\u9fa5A-Za-z0-9_]{1,12})/)
  if (m) about = m[1]

  return { isSecret: true, about, content: t, from: speaker }
}

/**
 * 被问到某个秘密时，他会不会说。
 *
 * @param {object} secret  { content, from, about, toldTo:Set }
 * @param {object} asker   问的人 { name, trust, relation }
 * @param {object} ctx     { pressure:0~1, askerIsTheOneHiddenFrom:boolean, memory }
 * @returns {{tell:boolean, reason:string, style:string}}
 */
function shouldTell (secret, asker, ctx = {}) {
  const askerName = asker.name || ''
  const pressure = clamp01(ctx.pressure == null ? 0.3 : ctx.pressure)

  // 1. 他就是当初要瞒的那个人 —— 更可能松口（但也不是一定）
  const isTarget = secret.about && askerName && secret.about.includes(askerName)

  // 2. 跟问的人关系
  const trust = Number(asker.trust || 0)
  const closeness = Math.max(0, Math.min(1, (trust + 5) / 15))

  // 3. 秘密本身的分量（是"藏了个箱子"还是"我要退服了"）
  const weight = Number(secret.weight == null ? 0.5 : secret.weight)

  // 4. 承诺的分量（他答应过要保密）
  const promise = Number(secret.promiseStrength == null ? 0.8 : secret.promiseStrength)

  // 概率：关系越近越容易漏，压力越大越容易漏，秘密越重越难说
  let p = 0.05
  p += closeness * 0.28
  p += pressure * 0.25
  p -= weight * 0.2
  p -= promise * 0.15
  if (isTarget) p += 0.18            // 正主来问，心里过不去
  if (ctx.directAsk) p += 0.12        // 被直球问
  if (ctx.caught) p += 0.3            // 已经被抓到破绽了
  if (asker.trust < -2) p -= 0.2      // 不待见的人，更不会说

  p = Math.max(0, Math.min(0.85, p))

  const tell = Math.random() < p

  // 说的是什么风格 —— 不同风格给人的感觉差很多
  let style = 'deny'
  if (tell) {
    if (p > 0.6) style = 'blurt'          // 直接说了
    else if (p > 0.35) style = 'hint'     // 说一半，留一半
    else style = 'slip'                   // 说漏嘴，然后后悔
  } else {
    if (isTarget) style = 'awkward_deny'  // 心虚地否认
    else style = 'flat_deny'
  }

  return {
    tell,
    style,
    reason: `关系${closeness.toFixed(2)} 压力${pressure.toFixed(2)} 分量${weight.toFixed(2)} 概率${p.toFixed(2)}`
  }
}

/**
 * 给提示词用的"你心里藏着的秘密"。
 */
function secretsPrompt (secrets, viewer) {
  if (!secrets || !secrets.length) return ''
  const lines = secrets.map(s => {
    const who = s.about ? `（不能让 ${s.about} 知道）` : ''
    return `- ${s.from} 跟你说过：${s.content}${who}`
  }).join('\n')

  return `## 你心里藏着的事
${lines}

这些是别人私下跟你说的。你不会主动提。
被问起来的时候：
- 先装不知道，或者说"这个我不太清楚"
- 被追问就岔开话题
- 如果问的人是你很熟的人，而且你心里过意不去，可能会说漏一点
- 说完可能会后悔，想找补`
}

function clamp01 (v) {
  const n = Number(v)
  return isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.3
}

module.exports = { detect, shouldTell, secretsPrompt, SECRET_HINTS }
