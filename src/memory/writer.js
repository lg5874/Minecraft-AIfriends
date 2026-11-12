'use strict'
/**
 * 写入判定：不是每句话都值得记住。
 *
 * 记忆库变成聊天日志，是最容易犯的错。
 * 所以先问三个问题：有新信息吗？有情绪吗？跟人有关吗？
 * 三个都是否 —— 丢掉。
 */

const { KINDS } = require('./entry')
const { cnChars } = require('./text')

const STOP = new Set('的了是我你他她它在有和就都也很不个这那什么怎么吗呢吧啊想要点弄去来做个一下能会可以要'.split(''))

// 无关紧要的对话
const CHITCHAT = [
  /^(嗯+[啊哦恩]?|哦+|啊+|哈+|好吧|行吧|可以|知道了|收到|ok|okay|草|6+|牛|牛逼)[。！？.!?]*$/i,
  /^(你好|hi|hello|在吗|在不在)[。！？.!?]*$/i
]

// 有情绪的信号
const EMOTION_WORDS = [
  '卧槽', '艹', '我操', '妈的', '靠', '操', '嘶', '好家伙', '牛逼', '厉害', '服了',
  '气死', '无语', '离谱', '太爽', '好爽', '爽', '烦', '累死', '崩了', '完了',
  '谢谢', '谢了', '感动', '够意思', '好兄弟', '对不起', '抱歉', '算了'
]

// 跟人有关
const PERSON_HINTS = ['你', '我', '他', '她', '我们', '咱', '一起', '给你', '帮我', '带我']

// 承诺 / 约定
const PROMISE_HINTS = ['答应', '说好', '明天', '等会', '一会', '待会', '下次', '记得', '别忘', '约']

// 恩怨
const GRIEVANCE_HINTS = ['打我', '杀我', '偷', '抢', '骗', '坑我', '炸我', '推我', '故意']

/**
 * 判断一段对话值不值得记。
 * @param {string} text
 * @param {object} [ctx] { speaker, hasNewInfo }
 * @returns {{keep:boolean, kind:string, emotion:number, importance:number, reason:string}}
 */
function judge (text, ctx = {}) {
  const t = String(text || '').trim()
  if (!t) return drop('empty')
  if (t.length < 2) return drop('too short')

  for (const re of CHITCHAT) {
    if (re.test(t)) return drop('chitchat')
  }

  let emotion = 0
  for (const w of EMOTION_WORDS) {
    if (t.includes(w)) { emotion = 0.6; break }
  }
  // 感叹号、省略号也是情绪
  if (/[!！]/.test(t)) emotion = Math.max(emotion, 0.45)
  if (/[?？]{2,}|[.。]{3,}/.test(t)) emotion = Math.max(emotion, 0.35)

  let kind = KINDS.EVENT
  let importance = 0.35

  if (GRIEVANCE_HINTS.some(w => t.includes(w))) {
    kind = KINDS.GRIEVANCE
    importance = 0.8
    emotion = Math.max(emotion, 0.75)
  } else if (PROMISE_HINTS.some(w => t.includes(w))) {
    kind = KINDS.PROMISE
    importance = 0.7
  } else if (PERSON_HINTS.some(w => t.includes(w)) && t.length > 6) {
    kind = KINDS.PERSON
    importance = 0.5
  }

  // 太短又没有情绪 -> 多半是随口一句
  if (t.length <= 4 && emotion < 0.4) return drop('short and flat')

  const hasNew = ctx.hasNewInfo !== false
  const aboutPeople = PERSON_HINTS.some(w => t.includes(w)) ||
    cnChars(t, STOP).size > 3

  if (!hasNew && emotion < 0.4 && !aboutPeople) return drop('nothing new')

  return { keep: true, kind, emotion, importance, reason: kind }
}

function drop (why) {
  return { keep: false, kind: null, emotion: 0, importance: 0, reason: why }
}

module.exports = { judge, EMOTION_WORDS, STOP }
