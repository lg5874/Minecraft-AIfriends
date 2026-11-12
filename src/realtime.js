'use strict'
/**
 * 现实时间感。
 *
 * 他知道现在几点、今天周几。
 * 真人会说"这么晚了还不睡""明天有课先下了"——不知道时间的人一眼假。
 *
 * 但注意：知道时间 ≠ 一直报时。正常人不会每隔五分钟说一次现在几点。
 */

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * @param {Date} [now]
 * @returns {object}
 */
function realTime (now) {
  const d = now || new Date()
  const hour = d.getHours()
  const minute = d.getMinutes()
  return {
    date: d,
    hour,
    minute,
    weekday: d.getDay(),
    weekdayName: WEEK[d.getDay()],
    clock: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    part: partOfDay(hour),
    isLate: hour >= 23 || hour < 5,
    isVeryLate: hour >= 1 && hour < 5,
    isEarlyMorning: hour >= 5 && hour < 8,
    isSchoolTime: d.getDay() >= 1 && d.getDay() <= 5 && hour >= 8 && hour < 18,
    text: describe(d)
  }
}

function partOfDay (h) {
  if (h < 5) return '凌晨'
  if (h < 8) return '早上'
  if (h < 11) return '上午'
  if (h < 13) return '中午'
  if (h < 17) return '下午'
  if (h < 19) return '傍晚'
  if (h < 23) return '晚上'
  return '深夜'
}

function describe (d) {
  const h = d.getHours()
  return `${WEEK[d.getDay()]} ${partOfDay(h)} ${String(h).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 生成提示词里的时间感。
 * 只给事实，不给他规定"该说什么"。
 */
function timePrompt (t) {
  const bits = [`现在是 ${t.text}。`]

  if (t.isVeryLate) {
    bits.push('这个点还在打游戏，一般人早睡了。')
  } else if (t.isLate) {
    bits.push('挺晚了。')
  } else if (t.isSchoolTime) {
    bits.push('这是上课时间。')
  }

  bits.push(`（你记得这个时间，但不用挂在嘴上，别人不提你就别主动报时。）`)
  return bits.join('')
}

/**
 * 什么时候适合拿"时间"当话题。
 * 频率要低 —— 真人不会老提。
 */
function timeRemarkChance (t) {
  if (t.isVeryLate) return 0.35
  if (t.isLate) return 0.2
  if (t.isEarlyMorning) return 0.25
  return 0.05
}

module.exports = { realTime, timePrompt, timeRemarkChance }
