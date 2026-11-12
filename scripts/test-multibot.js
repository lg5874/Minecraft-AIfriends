'use strict'
// 防 bot 无限对答的自测
const Talk = require('../src/talk')

let pass = 0, fail = 0
function ok (cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name) }
}

// 造一个最小的 talk 实例
function makeTalk (botNames = []) {
  const t = Object.create(Talk.prototype)
  t.history = []
  t.lastSpokeAt = 0
  t.recentSaid = []
  t.botChain = []
  t.ctx = {
    log: () => {},
    cfg: { behavior: { ignoreChanceWhenBusy: 0.15 } },
    botNames,
    busy: () => false,
    memory: {},
    actions: { status: () => ({ pos:{x:0,y:0,z:0}, health:20, food:20, time:'白天', held:null }) }
  }
  t.mem = {
    people: {},
    person: (n) => ({ callMe: null }),
    maybeRemember: () => null
  }
  t.bot = { username: 'XJJ' }
  return t
}

console.log('\n[bot 识别]')
{
  const t = makeTalk(['XJJ1', 'XJJ2'])
  ok(t.looksLikeBot('XJJ1') === true, '白名单里的认得出')
  ok(t.looksLikeBot('bot_abc') === true, '名字带 bot 的认得出')
  ok(t.looksLikeBot('XJJ3') === true, 'XJJ+数字 认得出')
  ok(t.looksLikeBot('Xylitol6983') === false, '真人名字认不出（正确）')
  ok(t.looksLikeBot('果哥') === false, '中文昵称认不出')
}

console.log('\n[对话链限制]')
{
  const t = makeTalk(['XJJ1'])
  // 模拟：XJJ1 连续说话 10 次
  let replied = 0
  t.reply = async () => { replied++ }
  t.say = async () => true

  for (let i = 0; i < 10; i++) {
    t.ctx.busy = () => false
    // 每次都明确叫我
    t.onChat('XJJ1', 'XJJ 你在干嘛？').catch(() => {})
  }

  // 等异步
  setTimeout(() => {
    ok(t.botChain.length <= 5, `对话链被限制了（记录 ${t.botChain.length} 次，不是 10 次）`)

    console.log(`\n结果：${pass} 通过，${fail} 失败`)
    process.exit(fail ? 1 : 0)
  }, 500)
}
