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
  /^(谢谢|谢了|多谢|thx|thanks)[。！？.!?]*$/i,
  /^(你厉害|厉害|你牛|牛啊|行行行|好好好|随便|不知道|没事|算了)[。！？.!?]*$/i,
  // 纯客套：谢了 / 行，缺啥喊我 / 好嘞 / 知道了 —— 有社交词但没有任何具体内容
  /^[嗯哦啊行好对是][，,]?\s*(谢了|谢谢|多谢|缺啥喊我|有事喊我|有事叫我|你说|知道了|明白|收到|好嘞|行吧|那我去了)[。！？.!?]*$/i,
  /^(谢了|多谢|缺啥喊我|有事喊我|有事叫我|好嘞|那我去了|我这就去|马上)[。！？.!?]*$/i
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

// 寒暄 / 邀请 / 打气：只有社交词，没有任何"谁做了什么、哪里有啥、答应了什么"
const SMALLTALK = [
  /^(兄弟|哥们|老哥|兄弟别|别气|别急|别慌|没事吧|加油|慢慢来)/,
  /(一起|一块)(?:上去|下去|来|去|玩|干|搞|盖|建|挖|弄|整)/,
  /(?:你|您)(?:想|要|会|能|要不要)(?:和|跟)/,
  /(?:一起|一块)[^，。！？]{0,8}(?:吧|呗|啊|吗)[。！？]?$/
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
  // 承诺 / 约定。
  // 方向很重要：「我答应给你」是他的承诺；「你回头给我」是别人的事（记成人，不是他的承诺）。
  promise: /(答应|说好|约好|保证|欠你|欠我|说定了|回头给你|明天给你|下次给你|一会给你|待会给你|等会给你|等我.{0,8}给你)/,
  // 危险 / 生死
  // 「差点」必须跟真的危险连用 —— 「还差点石头」是缺材料，不是命悬一线
  danger: /(苦力怕|爬行者|僵尸|骷髅|蜘蛛|末影人|女巫|溺尸|岩浆|熔岩|摔死|淹死|危险|爆炸|炸飞|砍死|弄死|打死了|挂了|没命|差点(?:死|被|没命|炸|掉|摔|淹))/,
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
  '庇护所', '出生点', '家里', '基地'
]

// 资源词。注意：不能只写「矿」—— 那样「矿洞」「矿脉」「矿道」全会被当成"这里有矿"。
const RESOURCE = /(煤矿|铁矿|金矿|钻石|红石|青金石|绿宝石|石英|铜矿|铁矿|煤炭|铁锭|金锭|宝箱|箱子|水源|熔岩|煤|铁|金)/

// 「某地方有某物」的结构。地点知识必须是这个形状，不能只是"提到了某个地方"。
const HAS_STRUCT = /(?:有|藏着|发现|全是|都是|住着|能挖到|底下是|下面是|深处是|埋着)/

// 他说出来的死法：「草，被僵尸挠死了」「又栽水里了 溺尸这玩意真烦」
const DEATH_LINE = new RegExp(
  '(?:被|让|给)[\\u4e00-\\u9fa5A-Za-z_]{2,8}(?:弄死|挠死|咬死|砍死|射死|炸死|打死|拖下水|淹死|烧死|摔死)' +
  '|(?:又|刚|差点)死(?:了|掉|一回)' +
  // 「死了」得是句末，而且前面不能是「烦/累/笑/气/吓」这种情绪词，
  // 也不能是「打死/砍死/弄死」这种他动词（那是别人死，不是他死）
  '|(?<![\\u4e00-\\u9fa5])死了(?=[，。！？…\\s]|$)'
)

// 单独的「死了」还要再过一道：
// 「烦死了」「笑死了」是心情；「张三打死了僵尸」是别人的事。
function isSelfDeath (t) {
  if (!DEATH_LINE.test(t)) return false
  // 「烦死了/笑死了/累死了」——说的是心情，不是死
  if (/[烦累笑气吓馋想忙急饿困冷热疼爽]死了/.test(t)) return false
  // 「张三打死了僵尸」——死的是别人，不是我。
  // 但有「被/让/给」就是被动："被僵尸挠死了" 死的是我。
  const passive = /(?:被|让|给)[\u4e00-\u9fa5A-Za-z_]{2,8}(?:弄死|挠死|咬死|砍死|射死|炸死|打死|淹死|烧死|摔死|拖下水)/.test(t)
  if (!passive && /[打杀砍射炸弄咬挠踢推骂扔砸]死[了掉]/.test(t)) return false
  return true
}

// 怪物 / 生物名 —— 绝不是人
const MOB_WORD = '僵尸|溺尸|尸壳|骷髅|流浪者|蜘蛛|洞穴蜘蛛|苦力怕|爬行者|末影人|女巫|史莱姆|岩浆怪|烈焰人|恶魂|凋灵|凋灵骷髅|掠夺者|卫道士|劫掠兽|幻翼|守卫者|潜影贝|蠹虫|恼鬼|傀儡|村民|猪灵|疣猪兽|监守者'
const MOB_NAMES = new RegExp(`^(${MOB_WORD})$`)

// 代词 / 泛指 —— 绝不是具体的人
const PRONOUN = /^(我|你|他|她|它|我们|你们|他们|她们|咱们|大家|自己|别人|有人|某人|谁|人家|对方)$/

// ============================================================
// 测试小号过滤（UNHUMAN-SCAN #13）
//
// 实测 data/runtime/memory.json 的"认识的人"里 5 个有 4 个是测试号：
//   XJJHOME6 / XJJINTG / XJJHOME87 / XJJVER6
// 它们 importance 0.6、衰减很慢，会长期占着 peopleDigest 的位置 ——
// 玩家问"你还记得谁"，他会报出一串不存在的名字。
//
// 判据只在**强特征**上：XJJ + 4 位以上大写字母/数字（带用途后缀）。
// 主账号（cfg.bot.username，默认 XJJ）本身不匹配，但仍显式放行一次，
// 免得以后主账号改名成 XJJMAIN 之类被自己滤掉。
// ============================================================
const TEST_ACCOUNT_RE = /^XJJ[_-]?[A-Z0-9]{4,}$/i

/**
 * 这个用户名是不是测试小号。
 * @param {string} name
 * @param {string} [mainAccount] 主账号名（永不算测试号）
 */
function isTestAccount (name, mainAccount) {
  const n = String(name || '').trim()
  if (!n) return false
  if (mainAccount && n.toLowerCase() === String(mainAccount).trim().toLowerCase()) return false
  return TEST_ACCOUNT_RE.test(n)
}

// ============================================================
// 地名不是人（UNHUMAN-SCAN #13 的尾巴）
//
// 实测 memory.json 里 `people` 混进了 "标记起点"：
//   notes: ["起点 (100.48,59,14.3) 开始做路标"]
// 它是 coder 写的 `memory.note('标记起点', ...)` 造出来的 —— 于是
// peopleDigest 会把他自己的路标当成"认识的人"念进提示词：
//   - 标记起点（一般）：起点 (100.48,59,14.3) 开始做路标
//
// 判据分两层，名字特征词只是**辅助**，主判据在 index.js：
//   名字带地点词 + 从没说过话/没有互动 -> 不记成"人"
// 真人玩家 ID 里也可能带"标记"，所以只看名字会误杀 —— 说过话的一律放行。
// ============================================================
const PLACE_WORD_RE = /(起点|终点|标记|路标|基地|矿洞|矿口|营地|集合点|传送点|路口|门口|入口|出口)/

/** 名字看起来像地名（只是辅助判据，单靠它会误杀真人） */
function looksLikePlaceName (name) {
  const n = String(name || '').trim()
  if (!n) return false
  return PLACE_WORD_RE.test(n)
}

/** 不是人名的词 */
const NAME_STOP = new Set([
  '我们', '他们', '你们', '咱们', '大家', '自己', '别人', '有人', '某人',
  '什么', '那个', '这个', '一下', '一起', '要是', '如果', '时候', '东西',
  '那边', '这边', '今天', '昨天', '明天', '现在', '刚才', '后来', '然后',
  '我说', '他说', '你说', '这货', '那货', '老弟', '哥们',
  '和别人', '和人家', '跟别人', '跟人家', '别人一', '跟我说', '和我说',
  '木头', '石头', '铁矿', '圆石', '面包', '箱子', '工作台', '蜗牛',
  '手边', '脚边', '头顶', '地下', '河沟', '圈里', '旁边'
])

/**
 * 判断一个候选是不是像人名的样子。
 *
 * 规则：**只允许"干净"的词**。宁可漏，不可错 ——
 * 记错人比不记更糟（用户明确要求：要分清谁是谁）。
 *
 * 做法是字符白名单的否定：中文候选里只要出现一个虚词/动词/量词/代词，
 * 就整个否掉。这比"看起来像人名"的黑名单可靠得多 ——
 * 「僵尸挠了」「想和别人」「李四三块」都会被否掉，「张三」「老王」会留下。
 */
// 虚词 / 代词 / 介词：出现在候选里就否掉。
// 注意这里**只放绝不会出现在人名里的字** ——
// 「三」「老」「一」不在此列，因为「张三」「老王」是真人名。
const NAME_BAD = new Set('的了是在有就也都很不个这那什么怎么吗呢吧啊想要点弄去来做个一下能会可以把他她它们你我跟给对让'
  .split(''))

// 动作字：名字里不会有
const NAME_BAD_VERB = new Set('帮打偷抢骗杀救送挖砍跑走看听拿丢整炸推害骂怼捅挠咬拖射弄趁已经总是才就又再刚正很太挺更最'.split(''))

// 泛指前缀：「别人一」「人家一起」「大家走」这种整体是残句
const GENERIC_PREFIX = /^(别人|人家|大家|自己|有人|某人|谁|对方|那个人|这个人|那些人|这些人)/

/**
 * 判断一个候选是不是像人名的样子。
 *
 * 宁可漏，不可错 —— 记错人比不记更糟（用户明确要求：要分清谁是谁）。
 *
 * 判据只放**强特征**：「张三」「老王」这种真人名绝不能因为某个字被误伤。
 * 漏抽一个人名，顶多是没记在名下（还能从 who 参数补）；
 * 抽错人，就会把他的事记到别人头上 —— 那比不记更糟。
 */
function looksLikeName (n) {
  if (!n) return false
  n = String(n).trim()
  if (n.length < 2 || n.length > 16) return false
  if (NAME_STOP.has(n)) return false
  if (PRONOUN.test(n)) return false
  if (MOB_NAMES.test(n)) return false
  if (GENERIC_PREFIX.test(n)) return false
  if (new RegExp(`^(${MOB_WORD})`).test(n)) return false
  if (new RegExp(`^(${MOB_WORD}|挠|咬|砍|射|炸|打|弄|拖)$`).test(n)) return false

  // 纯英文/数字用户名（MC 用户名）：只要不是全数字就收
  if (/^[A-Za-z0-9_]+$/.test(n)) return !/^\d+$/.test(n)

  for (const c of n) {
    if (NAME_BAD.has(c)) return false
    if (NAME_BAD_VERB.has(c)) return false
  }

  // 末尾是**纯量词**才算粘到下一句（「李四三块」的「块」）。
  // 数字不能禁 —— 「张三」「李四」「王五」全是人名。
  if (/[个块根条件颗次些两]$/.test(n)) return false

  return true
}

/**
 * 把一个贪心抓到的候选裁成"最像人名"的前缀。
 *
 * 关键认知：**中文名字里可以有数字**（张三、李四、王五都是真人名），
 * 所以纯靠字符表永远分不清「李四三块」和「李四三」。
 * 这里只做"见到明显短语边界就剁"的最低限度收尾，
 * 真正可靠的名字来源是调用方传进来的 known（服务器在线玩家名）。
 */
function bestNamePrefix (cand, known) {
  if (!cand) return null
  const s = String(cand).trim()

  // 1. 已知玩家名优先 —— 这是唯一不会错的办法
  if (Array.isArray(known) && known.length) {
    for (const k of known) {
      if (k && s.startsWith(k)) return k
    }
  }

  // 2. 末尾是量词（不是数字）就剁掉： 「李四块」-> 不行，得试「李四」
  const QTY_TAIL = /[个块根条件颗次些把]$/
  if (QTY_TAIL.test(s) && s.length > 2) {
    for (let len = s.length - 1; len >= 2; len--) {
      const sub = s.slice(0, len)
      if (looksLikeName(sub)) return sub
    }
  }

  // 3. 常规：从长到短
  for (let len = Math.min(s.length, 4); len >= 2; len--) {
    const sub = s.slice(0, len)
    if (looksLikeName(sub)) return sub
  }
  return null
}

/**
 * 抽人名。
 * 优先用调用方给的 who（那是可靠的用户名），没有再猜。
 */
function extractPeople (text, known) {
  const t = String(text || '')
  const out = []

  const push = (n) => {
    if (!n) return
    n = String(n).trim()
    if (!looksLikeName(n)) return
    if (!out.includes(n)) out.push(n)
  }

  // 候选词：2~4 个汉字 或 3~16 位账号名
  const CAND = '([\\u4e00-\\u9fa5]{2,4}|[A-Za-z0-9_]{3,16})'

  // 1. 「张三帮我…」「老王给我…」「李四偷我…」—— 名字后面直接跟动作
  const re1 = new RegExp(CAND + '(?=帮我|给我|带我|打我|偷我|抢我|骗我|杀我|救了我|夸我|骂我)', 'g')
  for (const m of t.matchAll(re1)) push(m[1])

  // 2. 「跟老王…」「答应给李四…」「让王五…」「见到果哥…」
  //    引介词后面可能垫一个介词（给/帮/对/找）。
  //    候选先贪心取 2~4 字，从长到短试，第一个通过 looksLikeName 的就是它。
  //    （不能靠前瞻钉死后面跟什么 —— 「李四三块铁」后面是「三」，不是虚词）
  const lead = new RegExp(
    '(?:答应|说好|跟|和|叫|让|谢谢|感谢|见到|遇到|认识|给了|送给|帮|对|找)' +
    '\\s*(?:给|帮|对|跟|和|找)?\\s*([\\u4e00-\\u9fa5]{2,4}|[A-Za-z0-9_]{3,16})', 'g')
  for (const m of t.matchAll(lead)) {
    const n = bestNamePrefix(m[1], known)
    if (n) push(n)
  }

  // 3. 「李四趁我不注意…」「老王又来了」—— 句首或逗号后的人名
  const head = new RegExp('(?:^|[，。！？；\\s])([\\u4e00-\\u9fa5]{2,4})(?=趁|把|又|还|就|才|已经|老是|总是)', 'g')
  for (const m of t.matchAll(head)) push(m[1])

  return out.slice(0, 4)
}

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

function normalizeWho (given, text, known, mainAccount) {
  const arr = Array.isArray(given) ? given.filter(Boolean) : (given ? [given] : [])
  const src = arr.length ? arr : extractPeople(text, known)
  // 测试小号不挂在谁头上（UNHUMAN-SCAN #13）：
  // 混在真人里的测试号也摘掉，免得「XJJHOME6 和 老王」变成两条人际关系。
  return src.filter(n => !isTestAccount(n, mainAccount)).slice(0, 6)
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

// 只放**材料**。镐/斧/剑/锹 是目标本身，不能当"缺的东西"
// （否则会说出「缺斧这事就卡住了」这种鬼话）
const ITEM_RE = /(木棍|木板|原木|木头|圆石|石头|煤炭?|铁锭|铁|工作台|熔炉|食物|面包|羊毛|皮革|线)/
const TOOL_RE = /(石镐|木镐|铁镐|石斧|木斧|铁斧|石剑|木剑|铁剑|石锹|木锹|工作台|熔炉|箱子|床|火把)/
const BLOCKED_RE = /(不够|只有|缺|没有|差|做不了|做不成|没做成|没法)/

function lessonFrom (goal, err) {
  const g = String(goal || '')
  const e = String(err || '')

  // 模型/网络/HTML 报错 —— 这不是他的教训，是运维事故
  if (/模型调用失败|HTTP\s*\d{3}|<!DOCTYPE|<html/i.test(e)) return null

  if (!ITEM_RE.test(e) || !BLOCKED_RE.test(e)) return null

  // 「可能缺工作台」「可能材料不够」是猜的，不是事实。
  // 猜出来的教训会教坏他 —— 宁可这条不记。
  if (/(?:可能|也许|大概|好像|说不定|估计)[^。；]{0,10}(?:缺|差|少|不够|没做成|做不了)/.test(e)) return null

  // 缺的东西：必须有明确的"缺/不够/只有/没有"标记，
  // 然后取**离这个标记最近**的已知物品名。
  // 不能只看"只有"后面那几个字 ——「木棍只有 1 根做不了新的」里后面是"1 根做不了新"。
  const marks = []
  const markRe = /(?:缺|不够|不足|只有|没有|差|做不了|做不成|没做成)/g
  let mm
  while ((mm = markRe.exec(e))) marks.push(mm.index)
  if (!marks.length) return null

  // 工具名先定下来：取「做/合/造 + 量词 + 工具」里第一个。
  // 这比"goal 里出现的第一个工具"准。
  const tm = g.match(new RegExp('(?:做|合|造|合成|craft)\\s*(?:一把|一个|把|个|成|出)?\\s*(' + TOOL_RE.source + ')'))
  const tool = tm ? tm[1] : null
  const toolBase = tool ? tool.replace(/^(石|木|铁|金|钻)/, '') : null

  const itemRe = new RegExp(ITEM_RE.source, 'g')
  let best = null
  let bestD = Infinity
  let im
  while ((im = itemRe.exec(e))) {
    const w = im[0]
    // 跳过"他自己"：工具名本身、以及它的裸名（石斧 -> 斧）
    if (tool && (w.includes(tool) || tool.includes(w))) continue
    if (toolBase && w.includes(toolBase)) continue
    // 跳过"其实已经有了"的：报错说"工作台已就绪"，就不能写「做木镐得先备够工作台」
    const after = e.slice(im.index + w.length, im.index + w.length + 10)
    const before = e.slice(Math.max(0, im.index - 6), im.index)
    if (/(?:已|已经|都)?(?:就绪|有了|备好|弄到|拿到|做好)/.test(after) &&
        !/(?:缺|没有|不够|不足|差)/.test(before)) continue
    for (const mi of marks) {
      const d = Math.abs(im.index - mi)
      if (d < bestD) { bestD = d; best = w }
    }
  }
  if (!best) return null

  if (tool) return `做${tool}得先备够${best}`
  return `缺${best}这事就卡住了`
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
  const who = normalizeWho(ctx.who, t, null, ctx.mainAccount)
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

  // 关键设计：**情绪本身不是内容**。
  // 「烦死了」「笑死」只是心情，心情归 mood.js 管。
  // 情绪只能放大一个已经存在的信号（有人、有地方、有后果），不能凭空造出一条记忆。
  // 同理，光是"提到了某个地方"也不算 ——「在河边走了走」是位移，不是知识。
  const any =
    social || grievance || promise || danger || lesson || discovery || placeKnowledge
  const strong = social || grievance || promise || danger || lesson || placeKnowledge

  return {
    social, grievance, promise, danger, placeWord, placeKnowledge, resource,
    lesson, discovery, gain, emotion, any, strong, who, where
  }
}

/** 分种类：承诺 > 恩怨 > 地点 > 教训 > 关于人 > 事件 */
function pickKind (sig, given, isSelf, who, t) {
  // 承诺的方向很重要，记反了就是记错事。
  //   「我答应张三给他铁」「我答应给你铁」 -> 他的承诺（promise，永不衰减）
  //   「张三说他一会给我铁」             -> 张三答应给他（person，别人的话要转述）
  //
  // 判据是主语，不是前缀 —— talk.js 传别人的话时没有「我说：」，
  // 但他自己写记忆时也可能不带前缀，光看前缀会判反。
  if (sig.promise) {
    const selfSubject = /^(?:我|咱)\s*(?:答应|说好|约好|保证|欠|回头|明天|下次|一会|待会|等会)/.test(t) ||
      /我\s*(?:答应|保证|说好)/.test(t)
    // 「镐子给我，我一会给你更多镐子」—— 这是**对方**在要东西并许诺，
    // 不是他给别人承诺。有索取语（给我/借我/分我）就不是他的承诺。
    const asking = /(?:给|借|送|分|拿|还)\s*我/.test(t) || /^[^，。]{1,10}给我/.test(t)
    const otherSubject = /(?:他|她|你|[A-Za-z0-9_\u4e00-\u9fa5]{2,8})\s*(?:说|答应|保证)[^。]{0,12}(?:给|送)/.test(t) &&
      !selfSubject
    if (selfSubject || isSelf) return KINDS.PROMISE
    if (asking) return KINDS.PERSON
    if (!otherSubject) return KINDS.PROMISE
  }
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

  // ---- A00. 测试小号不进记忆（UNHUMAN-SCAN #13） ----
  // 「第一次见到 XJJHOME6」这类条目只有测试号一个 who，直接丢掉，
  // 不进 entries、也不进"认识的人"。
  const givenWho = Array.isArray(input.who) ? input.who.filter(Boolean)
    : (input.who ? [input.who] : [])
  const guessWho = givenWho.length ? givenWho : extractPeople(t)
  if (guessWho.length && guessWho.every(n => isTestAccount(n, input.mainAccount))) {
    return drop('test account')
  }

  for (const re of CHITCHAT) if (re.test(t)) return drop('chitchat')

  // ---- A0. 死亡：机器写的死法翻成人话，这是真记忆 ----
  const death = normalizeDeath(t)
  if (death) {
    const who = normalizeWho(input.who, t, null, input.mainAccount)
    const where = input.where || firstPlace(t)
    return keep(
      where ? `${where}那儿${death.text}` : death.text,
      KINDS.GRIEVANCE,
      {
        who,
        where: where || null,
        emotion: Math.max(death.emotion, Number(input.emotion) || 0),
        importance: Math.max(death.importance, Number(input.importance) || 0),
        reason: 'death'
      }
    )
  }

  // ---- A1. 别种写法的死：'草，被僵尸挠死了' ----
  if (isSelfDeath(t)) {
    const who = normalizeWho(input.who, t, null, input.mainAccount)
    const where = input.where || firstPlace(t)
    return keep(
      condense(t).slice(0, 60),
      who.length ? KINDS.GRIEVANCE : KINDS.EVENT,
      {
        who,
        where: where || null,
        // 取两者较大值：调用方说"这次特别惨"（0.95）不能被压回 0.65，
        // 否则"情感≥0.7 永不衰减"这条设计就进不来了。
        emotion: Math.max(0.65, Number(input.emotion) || 0),
        importance: Math.max(0.5, Number(input.importance) || 0),
        reason: 'death'
      }
    )
  }

  // ---- A. 「教训：X 没成（Y）」：能提炼成规则就留，否则滚 ----
  const lf = t.match(LESSON_FAIL)
  if (lf) {
    const rule = lessonFrom(lf[1], lf[2])
    if (!rule) return drop('task result')
    const who = normalizeWho(input.who, t, null, input.mainAccount)
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

  // ---- B1. 寒暄 / 邀请：光有社交词，没有具体内容 ----
  // 「兄弟别气，我们一起上去盖家」「你想和别人一起玩吗」
  // 这是场面话，不是"谁对我做了什么"。真发生了事会另有一条记忆。
  if (SMALLTALK.some(re => re.test(t)) && !sig.promise && !sig.grievance) {
    // 但如果是「一起」+ 明确地点/成果，那是真事，要留
    const concrete = /(?:挖到|找到|建成|盖好|做好|给|送|捡到|拿到)/.test(t)
    if (!concrete) return drop('smalltalk')
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
  const kind = pickKind(sig, input.kind, isSelf, sig.who, t)
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
  isTestAccount,
  looksLikePlaceName,
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
