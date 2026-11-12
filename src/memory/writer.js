'use strict'
/**
 * 记忆准入 —— 决定"这值不值得记住"。
 *
 * 最容易犯的错：把工作日志当记忆。
 *   ✗ 「把脚边那块andesite挖了看看下面是什么颜色。 -> 啥也没挖」
 *   ✗ 「用石斧砍了0棵树，原木从0个变成0个」
 *   ✓ 「张三这人挺够意思」
 *   ✓ 「那个山洞里有铁矿」
 *   ✓ 「上次在这儿差点被苦力怕炸死」
 *
 * 所以这里做三件事，顺序不能反：
 *   1. 先毙掉"不是记忆的东西"（任务日志 / 计划 / 廉价劳作 / 自言自语）
 *   2. 再抽出"值得记的信号"（关于人、关于地方、承诺、教训、危险）
 *   3. 最后压缩成一句人话 —— 只留大概，不留细节（记忆本来就是模糊的）
 *
 * 注意：这里**只管"记不记"，不管"忘不忘"**。
 * 忘不忘是 decay.js 的事（6h / 40h / 永不），那边的参数是设计，不是 bug。
 */

const { KINDS } = require('./entry')
const { cnChars } = require('./text')

const STOP = new Set('的了是我你他她它在有和就都也很不个这那什么怎么吗呢吧啊想要点弄去来做个一下能会可以要'.split(''))

// ============================================================
// 0. 一张表：什么不算话
// ============================================================

const CHITCHAT = [
  /^(嗯+[啊哦恩]?|哦+|啊+|哈+|好吧|行吧|可以|知道了|收到|ok|okay|草|6+|牛|牛逼|对|是|行|好)[。！？.!?]*$/i,
  /^(你好|hi|hello|在吗|在不在|在不在啊)[。！？.!?]*$/i,
  /^(谢谢|谢了|多谢|thx|thanks)[。！？.!?]*$/i
]

// 有情绪的词。情绪是"这件事进得去脑子"的最强理由。
const EMOTION_WORDS = [
  '卧槽', '我操', '艹', '妈的', '靠', '操', '嘶', '好家伙', '牛逼', '厉害', '服了',
  '气死', '无语', '离谱', '太爽', '好爽', '爽', '烦', '累死', '崩了', '完了', '绝望',
  '谢谢', '谢了', '感动', '够意思', '好兄弟', '对不起', '抱歉', '算了', '心疼', '舍不得',
  '吓死', '后怕', '紧张', '高兴', '开心', '难受', '丢人', '丢脸', '意外', '惊喜',
  '笑死', '好笑', '搞笑', '服气', '看不起', '小气', '大方'
]

// 「我说：…」—— 他自言自语的内容，默认不是记忆
const SELF_PREFIX = /^我说\s*[:：]\s*/
const SELF_PREFIX_2 = /^我自言自语\s*[:：]\s*/

// ============================================================
// 1. 一票否决：这是日志，不是记忆
// ============================================================

const LOG_MARKS = [
  /\s(?:->|→|=>)\s/,                              // 任务 -> 结果
  /返回\s*-?\d/,                                   // mine返回0
  /[a-z]{3,}_?[a-z]*\s*:\s*-?\d/,                  // granite:457 / crafting_table:1
  /从\s*\d+\s*(?:个|块|根|颗|件)?\s*变(?:成|为)\s*\d/,   // 原木从0个变成0个
  /(?:剩|还剩|剩下)\s*\d+\s*(?:块|个|根|颗|件)/,       // 圆石剩 203 块
  /[\u4e00-\u9fa5]{1,4}\s*[+\-]\s*\d/,             // 煤+0，生铁+0
  /[x×]\s*0\b/,                                    // 木镐x0
  /模型调用失败|HTTP\s*[45]\d\d|<!DOCTYPE/i,        // 模型/网络错误原文
  /背包\s*(?:共|还剩|空间|剩\s*\d)/,
  /(?:合成|合出|做出)了?\s*\d+\s*个/,               // 做了22个木板
  /\d+\s*个[^，。]{0,12}(?:没合出来|没做出来|做不出|没做成|没能)/,  // 22个木板工作台没合出来
  /^[^，。]{0,10}\d+\s*个[^，。]{0,14}(?:没合出来|没做出来|做不出|没做成)/
]

/** 计划句：只说要干什么，没说发生了什么 */
const PLAN_MARKS = [
  /^把[^。！？]{0,24}(?:放进|放到|放好|摆|铺|整理|清|丢|存|腾|补|留)/,
  /^(?:去|先|再|然后|接着|顺便|准备)[^。！？]{2,30}$/,
  /(?:看看下面|看看能|试试看|瞧瞧|摸一下)/,
  /(?:留着|备着|补充|腾出空间|省得|免得)/
]

// 「廉价劳作」：挖/砍/摆弄最便宜的方块，还没别的信号 —— 这不是记忆
const CHEAP_OBJ = '(?:石头|圆石|安山岩|花岗岩|闪长岩|泥土|沙子|砾石|草方块|草|树叶|原木|木板|木棍|树苗|雪|冰块|腐肉|蘑菇|煤炭|煤|碎石)'
const WORK_VERB = '(?:挖|刨|砍|捡|采|敲|合|放|摆|铺|整理|丢|存|塞|做|烧)'
const TRIVIAL = new RegExp(
  `${WORK_VERB}[^，。！？]{0,8}${CHEAP_OBJ}|${CHEAP_OBJ}[^，。！？]{0,8}${WORK_VERB}`
)

/** 「教训：X 没成（Y）」——默认是任务失败报告，只有能提炼成规则时才留 */
const LESSON_FAIL = /^教训\s*[:：]\s*([\s\S]+?)\s*没成[（(]([\s\S]+)[）)]\s*$/

// ============================================================
// 2. 值得记的信号
// ============================================================

const SIG = {
  // 关于人
  social: /(帮我|给我|带我|救我|救了我|借我|送我|陪我|一起|合伙|联手|谢谢|谢了|感谢|够意思|好兄弟|讲义气|信任|夸我|教我|让我|给了我|送了|说他|说我|笑我|喊我)/,
  // 恩怨
  grievance: /(打我|杀我|砍我|偷|抢|骗|坑我|炸我|推我|害我|骂我|怼我|放我鸽子|背后捅|坑了)/,
  // 承诺 / 约定
  promise: /(答应|说好|约好|保证|欠你|欠我|回头给|明天给|下次给|等我.{0,8}给|说定了|一会.{0,6}给|待会.{0,6}给|等会.{0,6}给)/,
  // 危险 / 生死
  danger: /(苦力怕|爬行者|僵尸|骷髅|蜘蛛|末影人|女巫|溺尸|岩浆|熔岩|摔死|淹死|差点|危险|爆炸|炸飞|砍死|弄死|打死了|死了|挂了|没命)/,
  // 教训
  lesson: /(教训|记住|别再|下次别|千万别|小心|以后不|不能碰)/,
  // 第一次 / 发现
  discovery: /(第一次|头一回|头一次|从来没|从没|终于|居然|竟然|发现|原来)/,
  // 拿到手
  gain: /(挖到|捡到|拿到|得到|砍到|做成|做好了|攒够|找到|给了我|送了)/
}

// 地点词。只要出现就算"跟地方有关"，但不等于"地点知识"。
const PLACE_WORDS = [
  '山洞', '矿洞', '洞里', '洞穴', '坑里', '地下', '深处', '峡谷', '矿脉',
  '河边', '湖边', '海边', '海上', '山上', '山顶', '山坡', '山脚', '树林', '森林',
  '沙漠', '雪原', '沼泽', '平原', '村子', '村庄', '遗迹', '要塞', '神庙',
  '庇护所', '出生点', '家里', '基地', '那片', '那边'
]

// 资源词。注意：不能只写「矿」—— 那样「矿洞」「矿脉」「矿道」全会被当成"这里有矿"。
const RESOURCE = /(煤矿|铁矿|金矿|钻石|红石|青金石|绿宝石|石英|铜矿|铁矿|煤炭|铁锭|金锭|宝箱|箱子|水源|熔岩|煤|铁|金)/

// 「某地方有某物」的结构。地点知识必须是这个形状，不能只是"提到了某个地方"。
const HAS_STRUCT = /(?:有|藏着|发现|全是|都是|住着|能挖到|底下是|下面是|深处是|埋着)/

// 他说出来的死法：「草，被僵尸挠死了」「又栽水里了 溺尸这玩意真烦」
const DEATH_LINE = /(?:被|让|给)[\u4e00-\u9fa5A-Za-z_]{2,8}(?:弄死|挠死|咬死|砍死|射死|炸死|打死|拖下水|淹死|烧死|摔死|弄死)|(?:又|刚|差点)?死(?:了|掉|一回)|没命了/

// 不是人名的词
const NAME_STOP = new Set([
  '我们', '他们', '你们', '咱们', '大家', '自己', '别人', '有人', '某人',
  '什么', '那个', '这个', '一下', '一起', '要是', '如果', '时候', '东西',
  '那边', '这边', '今天', '昨天', '明天', '现在', '刚才', '后来', '然后',
  '我说', '他说', '你说', '这货', '那货', '老弟', '哥们'
])

// ============================================================
// 3. 小工具
// ============================================================

// Minecraft 的死亡提示是英文机器话。真人记的是"被僵尸弄死了"。
const MOB_CN = {
  zombie: '僵尸', husk: '尸壳', drowned: '溺尸', skeleton: '骷髅', stray: '流浪者',
  creeper: '苦力怕', spider: '蜘蛛', cave_spider: '洞穴蜘蛛', enderman: '末影人',
  witch: '女巫', slime: '史莱姆', magma_cube: '岩浆怪', blaze: '烈焰人',
  ghast: '恶魂', wither_skeleton: '凋灵骷髅', pillager: '掠夺者', vindicator: '卫道士',
  ravager: '劫掠兽', phantom: '幻翼', wolf: '狼', iron_golem: '铁傀儡', bee: '蜜蜂',
  piglin: '猪灵', hoglin: '疣猪兽', zoglin: '僵尸疣猪兽', guardian: '守卫者',
  elder_guardian: '远古守卫者', shulker: '潜影贝', silverfish: '蠹虫', vex: '恼鬼'
}

/**
 * 把机器写的死法翻成人话。
 * 「死了：XJJ was slain by Zombie」-> 「被僵尸弄死了」
 */
function normalizeDeath (t) {
  const m = t.match(/^死了\s*[:：]\s*([\s\S]*)$/)
  if (!m) return null
  const body = m[1]

  const mob = body.match(/slain by (?:a |an )?([A-Za-z_ ]+?)\s*$/) ||
    body.match(/blown up by ([A-Za-z_ ]+?)\s*$/) ||
    body.match(/shot by ([A-Za-z_ ]+?)(?: using .*)?$/) ||
    body.match(/burned to death while fighting ([A-Za-z_ ]+?)\s*$/) ||
    body.match(/killed by (?:a |an )?([A-Za-z_ ]+?)\s*$/)
  if (mob) {
    const key = String(mob[1]).trim().toLowerCase().replace(/\s+/g, '_')
    const cn = MOB_CN[key]
    if (cn) {
      const how = /blown up/.test(body) ? '被' + cn + '炸死了'
        : /shot by/.test(body) ? '被' + cn + '射死了'
          : '被' + cn + '弄死了'
      return { text: how, emotion: 0.65, importance: 0.5, danger: true }
    }
  }

  if (/fell (?:from|off|too high|out of the world)/i.test(body)) {
    return { text: '从高处摔下来摔死了', emotion: 0.6, importance: 0.5, danger: true }
  }
  if (/lava/i.test(body)) return { text: '掉进岩浆里烧死了', emotion: 0.75, importance: 0.6, danger: true }
  if (/drown/i.test(body)) return { text: '在水里淹死了', emotion: 0.6, importance: 0.5, danger: true }
  if (/starve|hunger/i.test(body)) return { text: '饿死了', emotion: 0.6, importance: 0.5, danger: true }
  if (/suffocat/i.test(body)) return { text: '被闷在方块里憋死了', emotion: 0.55, importance: 0.5, danger: true }
  if (/explosion|TNT/i.test(body)) return { text: '被炸死了', emotion: 0.7, importance: 0.55, danger: true }
  if (/^不知道怎么回事$|^$/.test(body.trim())) {
    return { text: '莫名其妙死了一回，没搞清怎么死的', emotion: 0.55, importance: 0.45, danger: true }
  }

  // 认不出的死法：保留原文，但至少是"死了"这件事
  const cleaned = body.replace(/\b[A-Za-z0-9_]{3,16}\b/g, '').replace(/\s+/g, ' ').trim()
  return {
    text: cleaned ? '死了一回（' + cleaned.slice(0, 30) + '）' : '死了一回，没搞清怎么死的',
    emotion: 0.6,
    importance: 0.5,
    danger: true
  }
}

function isTaskLog (text) {
  const t = String(text || '')
  for (const re of LOG_MARKS) if (re.test(t)) return true
  return false
}

function isPlan (text) {
  const t = String(text || '')
  for (const re of PLAN_MARKS) if (re.test(t)) return true
  return false
}

function isTrivial (text) {
  return TRIVIAL.test(String(text || ''))
}

function stripSelf (text) {
  return String(text || '').replace(SELF_PREFIX, '').replace(SELF_PREFIX_2, '')
}

/** 第一个地点词 */
function firstPlace (text) {
  const t = String(text || '')
  let best = null
  for (const w of PLACE_WORDS) {
    const i = t.indexOf(w)
    if (i < 0) continue
    if (!best || i < best.i) best = { w, i }
  }
  return best ? best.w : null
}

/**
 * 抽人名。宁可漏，不可错 —— 记错人比不记更糟。
 * 优先用调用方给的 who（那是可靠的），没有再猜。
 */
function extractPeople (text) {
  const t = String(text || '')
  const out = []

  const push = (n) => {
    if (!n) return
    n = String(n).trim()
    if (n.length < 2 || n.length > 16) return
    if (NAME_STOP.has(n)) return
    if (/^[我你他她它]/.test(n)) return
    if (!out.includes(n)) out.push(n)
  }

  // 「张三帮我…」「张三打我…」
  const before = new RegExp(`([\\u4e00-\\u9fa5]{2,3}|[A-Za-z0-9_]{3,16})(?=${'帮我|给我|带我|打我|救了我|跟我|和我|一起|说|夸我'})`, 'g')
  let m
  while ((m = before.exec(t))) push(m[1])

  // 「答应张三…」「跟李四…」「让王五…」「见到果哥」
  const after = new RegExp(`(?:答应|跟|和|叫|让|谢谢|感谢|见到|遇到|认识|给了|送给)\\s*([\\u4e00-\\u9fa5]{2,3}|[A-Za-z0-9_]{3,16})(?=[给说帮打一起来的了，。！？\\s]|$)`, 'g')
  while ((m = after.exec(t))) push(m[1])

  return out.slice(0, 4)
}

function normalizeWho (given, text) {
  const arr = Array.isArray(given) ? given.filter(Boolean) : (given ? [given] : [])
  if (arr.length) return arr.slice(0, 6)
  return extractPeople(text)
}

/** 情绪强度 */
function emotionOf (t) {
  let e = 0
  for (const w of EMOTION_WORDS) if (t.includes(w)) { e = 0.6; break }
  if (/[!！]/.test(t)) e = Math.max(e, 0.45)
  if (/[?？]{2,}|[.。]{3,}/.test(t)) e = Math.max(e, 0.35)
  if (SIG.danger.test(t)) e = Math.max(e, 0.55)
  if (SIG.grievance.test(t)) e = Math.max(e, 0.7)
  return e
}

// ============================================================
// 4. 从「教训：X 没成（Y）」里提炼规则
// ============================================================

const ITEM_RE = /(木棍|木板|原木|木头|圆石|石头|煤炭?|铁|工作台|熔炉|食物|面包|床|镐|斧|剑|锹)/
const TOOL_RE = /(石镐|木镐|铁镐|石斧|木斧|铁斧|石剑|木剑|铁剑|石锹|木锹|工作台|熔炉|箱子|床|火把)/
const BLOCKED_RE = /(不够|只有|缺|没有|差|做不了|做不成|没做成|没法)/

function lessonFrom (goal, err) {
  const g = String(goal || '')
  const e = String(err || '')

  // 模型/网络/HTML 报错 —— 这不是他的教训，是运维事故
  if (/模型调用失败|HTTP\s*\d{3}|<!DOCTYPE|<html/i.test(e)) return null

  const lack = ITEM_RE.test(e) && BLOCKED_RE.test(e)
  if (!lack) return null

  const item = (e.match(new RegExp(`(?:缺|没有|差|只有|不够)\\s*([\\u4e00-\\u9fa5]{1,4})`)) || [])[1] ||
    (e.match(ITEM_RE) || [])[1]
  if (!item) return null
  if (!ITEM_RE.test(item)) return null

  const tool = (g.match(TOOL_RE) || [])[1]
  if (tool) return `做${tool}得先备够${item}`
  return `缺${item}这事就卡住了`
}

// ============================================================
// 5. 从一条日志里抢救出"真记忆"
// ============================================================

const ENEMY_RE = /(苦力怕|爬行者|僵尸|骷髅|蜘蛛|末影人|女巫|溺尸|史莱姆)/
const ORE_RE = /(钻石|绿宝石|青金石|红石|铁矿|煤矿|金矿|铁|煤|金)/
const SUCCESS_RE = /(挖到|捡到|得到|砍到|拿到|做成|做好了|攒够|找到)/
const ZERO_RE = /(?:挖了|得到|砍了|捡到|拿到)\s*0|从\s*0\s*个?变|\+\s*0\b|[x×]\s*0\b/

/**
 * 一条任务日志里，如果真出了事（撞上怪、挖到矿），压成一句印象。
 * 其余情况返回 null —— 什么都没发生，就什么都别记。
 */
function fromLog (t, where) {
  const enemy = (t.match(ENEMY_RE) || [])[1]
  if (enemy) {
    return {
      text: `${where ? '在' + where + '那儿' : '在那边'}撞上${enemy}了，差点没命`,
      kind: KINDS.GRIEVANCE,
      emotion: 0.55,
      importance: 0.6,
      where: where || null
    }
  }
  const ore = (t.match(ORE_RE) || [])[1]
  const ok = SUCCESS_RE.test(t) && !ZERO_RE.test(t)
  if (ore && ok) {
    return {
      text: `${where ? where + '那边' : '那一带'}有${ore}`,
      kind: KINDS.PLACE,
      emotion: 0.3,
      importance: 0.6,
      where: where || null
    }
  }
  return null
}

// ============================================================
// 6. 压缩：只留大概
// ============================================================

/** 去掉执行结果尾巴、技术括注，留一句话 */
function condense (text) {
  let t = String(text || '')
  t = t.replace(/\s*(?:->|→|=>)\s*[\s\S]*$/, '')
  t = t.replace(/\s*[（(][^（）()]{0,12}(?:\d|返回|块|个|根|件)[^（）()]{0,40}[）)]\s*$/, '')
  t = t.replace(/\s+/g, ' ').trim()
  if (t.length > 120) t = t.slice(0, 120) + '…'
  return t
}

// ============================================================
// 7. 判定
// ============================================================

/**
 * 扫描信号。
 * @returns {{social,grievance,promise,danger,placeWord,placeKnowledge,resource,lesson,discovery,gain,emotion,any,strong,who,where}}
 */
function scan (t, ctx = {}) {
  const who = normalizeWho(ctx.who, t)
  const where = ctx.where || firstPlace(t)

  const social = SIG.social.test(t)
  const grievance = SIG.grievance.test(t)
  const promise = SIG.promise.test(t)
  const danger = SIG.danger.test(t)
  const placeWord = !!firstPlace(t)
  const resource = RESOURCE.test(t)
  const lesson = SIG.lesson.test(t)
  const discovery = SIG.discovery.test(t)
  const gain = SIG.gain.test(t)
  const emotion = emotionOf(t)

  // 地点"知识"：得是「X 地方有 Y」这种，不是「在 X 走了走」，
  // 也不是「跟张三一起下了个矿洞」—— 后者是关于人，不是地点。
  const placeKnowledge = placeWord && HAS_STRUCT.test(t) && resource && !social

  // 光是"提到了某个地方"不算记忆。
  // 「在河边走了走」「在洞里转两圈」—— 这是位移，不是知识。
  const any =
    social || grievance || promise || danger || lesson || discovery ||
    placeKnowledge || emotion >= 0.35
  const strong = social || grievance || promise || danger || lesson || emotion >= 0.5

  return {
    social, grievance, promise, danger, placeWord, placeKnowledge, resource,
    lesson, discovery, gain, emotion, any, strong, who, where
  }
}

/** 分种类：承诺 > 恩怨 > 地点 > 教训 > 关于人 > 事件 */
function pickKind (sig, given) {
  if (sig.promise) return KINDS.PROMISE
  if (sig.grievance) return KINDS.GRIEVANCE
  if (sig.placeKnowledge) return KINDS.PLACE
  if (sig.lesson) return KINDS.SKILL
  if (sig.social) return KINDS.PERSON
  if (given && given !== KINDS.EVENT) return given
  return KINDS.EVENT
}

function defaultImportance (kind, sig) {
  switch (kind) {
    case KINDS.PROMISE: return 0.7
    case KINDS.GRIEVANCE: return 0.75
    case KINDS.PLACE: return 0.6
    case KINDS.SKILL: return 0.7
    case KINDS.PERSON: return 0.6
    default: return sig.danger ? 0.6 : 0.4
  }
}

function keep (text, kind, o = {}) {
  return {
    keep: true,
    text,
    kind,
    who: o.who || [],
    where: o.where || null,
    emotion: o.emotion == null ? 0 : o.emotion,
    importance: o.importance == null ? 0.5 : o.importance,
    reason: o.reason || kind
  }
}

function drop (why) {
  return { keep: false, text: '', kind: null, who: [], where: null, emotion: 0, importance: 0, reason: why }
}

/**
 * 统一准入判定。所有写记忆的路径最后都走这里。
 *
 * @param {object} input { text, kind?, who?, where?, emotion?, importance?, hasNewInfo? }
 * @returns {{keep:boolean, text:string, kind:string, who:string[], where:string|null, emotion:number, importance:number, reason:string}}
 */
function admit (input = {}) {
  const raw = String(input.text == null ? '' : input.text).replace(/\s+/g, ' ').trim()
  if (!raw) return drop('empty')

  const stripped = stripSelf(raw)
  const isSelf = stripped !== raw
  const t = stripped.trim()

  if (t.length < 2) return drop('too short')
  for (const re of CHITCHAT) if (re.test(t)) return drop('chitchat')

  // ---- A0. 死亡：机器写的死法翻成人话，这是真记忆 ----
  const death = normalizeDeath(t)
  if (death) {
    const who = normalizeWho(input.who, t)
    const where = input.where || firstPlace(t)
    return keep(
      where ? `${where}那儿${death.text}` : death.text,
      KINDS.GRIEVANCE,
      {
        who,
        where: where || null,
        emotion: death.emotion,
        importance: death.importance,
        reason: 'death'
      }
    )
  }

  // ---- A1. 别种写法的死：'草，被僵尸挠死了' ----
  const death2 = t.match(DEATH_LINE)
  if (death2) {
    const who = normalizeWho(input.who, t)
    const where = input.where || firstPlace(t)
    return keep(
      condense(t).slice(0, 60),
      who.length ? KINDS.GRIEVANCE : KINDS.EVENT,
      { who, where: where || null, emotion: 0.65, importance: 0.5, reason: 'death' }
    )
  }

  // ---- A. 「教训：X 没成（Y）」：能提炼成规则就留，否则滚 ----
  const lf = t.match(LESSON_FAIL)
  if (lf) {
    const rule = lessonFrom(lf[1], lf[2])
    if (!rule) return drop('task result')
    const who = normalizeWho(input.who, t)
    return keep(rule, KINDS.SKILL, {
      who, importance: 0.7, emotion: 0, reason: 'lesson'
    })
  }

  const sig = scan(t, input)

  // ---- B. 任务日志：先看能不能抢救出真记忆 ----
  if (isTaskLog(t)) {
    if (!sig.strong) return drop('task log')
    const g = fromLog(t, sig.where)
    if (g) return keep(g.text, g.kind, { ...g, who: sig.who, reason: 'from-task-log' })
    return drop('task log')
  }

  // ---- C. 计划句 / 廉价劳作：没有强信号就别记 ----
  if (isPlan(t) && !sig.strong) return drop('plan')
  if (isTrivial(t) && !sig.strong) return drop('trivial')

  // ---- D. 自言自语 ----
  if (isSelf && !sig.strong) return drop('self narration')

  // ---- E. 什么信号都没有 ----
  if (!sig.any) {
    // 例外：调用方显式给了情绪和重要性 —— 那是他/上游已经判断过的
    // （老接口 add({text, kind, emotion, importance}) 的契约）。
    // 这种可以进，但压成"弱记忆"，importance 封顶 0.4，几小时就淡掉。
    if (input.vouched) {
      return keep(condense(t), input.kind && input.kind !== KINDS.EVENT ? input.kind : KINDS.EVENT, {
        who: sig.who,
        where: sig.where,
        emotion: Math.min(0.4, Number(input.emotion) || 0),
        importance: Math.min(0.4, Number(input.importance) || 0.3),
        reason: 'weak'
      })
    }
    return drop('no signal')
  }

  // ---- F. 组装 ----
  const kind = pickKind(sig, input.kind)
  const who = sig.who
  const where = sig.where

  // 地点知识必须能说清"哪儿有啥"，否则退回普通事件
  let text = condense(t)
  if (!text) return drop('empty after condense')

  const emotion = input.emotion == null ? sig.emotion : input.emotion
  const importance = input.importance == null ? defaultImportance(kind, sig) : input.importance

  return keep(text, kind, {
    who,
    where: kind === KINDS.PLACE ? where : (where || null),
    emotion,
    importance,
    reason: kind
  })
}

/**
 * 对话判定（兼容老接口）。
 * @param {string} text
 * @param {object} [ctx] { speaker, who, hasNewInfo }
 */
function judge (text, ctx = {}) {
  const v = admit({ text, who: ctx.who, where: ctx.where, hasNewInfo: ctx.hasNewInfo })
  if (v.keep) return v
  return { keep: false, kind: null, emotion: 0, importance: 0, reason: v.reason, who: [], where: null, text: '' }
}

module.exports = {
  admit,
  judge,
  scan,
  condense,
  isTaskLog,
  isPlan,
  isTrivial,
  extractPeople,
  firstPlace,
  stripSelf,
  lessonFrom,
  fromLog,
  EMOTION_WORDS,
  STOP,
  PLACE_WORDS
}
