#!/usr/bin/env node
/**
 * blind-test.js — 退化日志盲读：量化「他多久会被发现是 AI」
 *
 * 做法：把 bot 日志洗成"旁观者视角的游戏记录"，交给没参与本项目的模型盲判，
 * 记录两个客观量：判定结果 + 第几行开始确信。
 *
 * 用法：
 *   # 1. 只造样本，不调模型（先人工检查洗得对不对）
 *   node scripts/blind-test.js --dry
 *
 *   # 2. 全流程：造样本 → 3 个裁判盲判 → 前缀曲线 → 结果落盘
 *   node scripts/blind-test.js
 *
 *   # 3. 只跑某个样本 / 只跑某个裁判
 *   node scripts/blind-test.js --sample /tmp/blindtest/P1.behavior.txt --judge pro
 *
 * 产物（默认 /tmp/blindtest/）：
 *   P1.behavior.txt   行为洗样本（主测；抹掉机器遥测，只保留旁观者能看到的）
 *   P1.raw.txt        痕迹洗样本（敏感性对照；标记改中文词，所有内部数字保留）
 *   P1.behavior.meta.json  行数 / 行号映射 / 客观特征统计
 *   result-<judge>.json    每个裁判的原始回答
 *   result.json            汇总
 *
 * 只读 data/runtime/bot.log 与 /tmp/bot*.log，不写回项目数据目录。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const OUT = '/tmp/blindtest';

// 洗规则版本：每次日志格式新增内部标记，都必须涨这个号，并在 docs/BLIND-TEST.md 记一条
// v1 2026-11-13 首版（[skill]/[will]/[hb]/[act]/[ctx]/[code]）
// v2 2026-11-13 覆盖新格式：[judge] 入库门槛、[chat] 复读去重/社交决策、[proof]/[lock]/[cost]、
//     <<< 失败 的硬判据原因、[travel]/[open]、别的 agent 的提示词泄漏
const WASH_VERSION = 7;   // v7：口径改造——behavior 不再带计时/计数；sayonly 去时间戳；指标改秒 + 合意票

// ────────────────────────────── 配置 ──────────────────────────────

const DEFAULT_CONFIG = {
  // 主测样本：一段连续 30 分钟的完整日志（当前 data/runtime/bot.log 只有 165 行，
  // 边界日志已轮转，所以从 /tmp 的完整日志里取窗口）
  samples: [
    {
      id: 'P1',
      role: 'primary',
      path: '/tmp/bot-new.log',
      from: '16:46:37',
      to: '17:16:37',
      note: '30 分钟连续窗口（老配置：无 [stuck] 强制换动作）',
    },
    {
      id: 'RT1',
      role: 'retest',
      path: '/tmp/retest-2245.log',
      from: null,
      to: null,     // 复测窗口由 --minutes 控制，默认取开头 30 分钟
      minutes: 30,
      note: '修复后实机（22:44 起 30 分钟）',
    },
    {
      id: 'RT2',
      role: 'retest-clean',
      path: '/tmp/retest-2245.log',
      from: '23:00:00',
      to: '23:30:00',
      note: '复测干净窗口（单实例，无同名互踢）',
    },
    {
      id: 'P2',
      role: 'replication',
      path: '/tmp/bot10.log',
      from: null,
      to: null,
      note: '最新配置全量 17 分钟（含 [stuck] 补丁）',
    },
  ],
  judges: [
    {
      id: 'pro',
      label: 'deepseek-v4-pro',
      baseUrl: 'https://mapi1.lzywl.top/v1',
      apiKeyEnv: 'BLIND_KEY_1',
      apiKey: 'sk-027136ba05155f5b9ce3fb35b598a0599ec44f422c9051f62ce88c5a347492a2',
      model: 'deepseek-v4-pro',
      temperature: 0,
      contaminated: false,
    },
    {
      // 本机只能接入两个不同模型（pro / flash），第三个裁判用同权重、不同采样温度，
      // 独立性有限，结果按"重采样一致性"解读
      id: 'pro-r2',
      label: 'deepseek-v4-pro 重采样（温度 0.7）',
      baseUrl: 'https://mapi1.lzywl.top/v1',
      apiKey: 'sk-027136ba05155f5b9ce3fb35b598a0599ec44f422c9051f62ce88c5a347492a2',
      model: 'deepseek-v4-pro',
      temperature: 0.7,
      contaminated: false,
    },
    {
      id: 'flash',
      label: 'deepseek-v4.1-flash（⚠ 就是 bot 的大脑，受污染，只做一致性对照）',
      baseUrl: 'https://mapi1.lzywl.top/v1',
      apiKey: 'sk-027136ba05155f5b9ce3fb35b598a0599ec44f422c9051f62ce88c5a347492a2',
      model: 'deepseek-v4.1-flash',
      temperature: 0,
      contaminated: true,
    },
  ],
  maxTokens: 8000,
  timeoutMs: 300000,
};

// ────────────────────────────── 洗数据 ──────────────────────────────

const BLOCK_CN = {
  stone: '石头', cobblestone: '圆石', diorite: '闪长岩', granite: '花岗岩', andesite: '安山岩',
  dirt: '泥土', grass_block: '草方块', oak_log: '橡木原木', oak_planks: '橡木木板',
  iron_ore: '铁矿石', coal_ore: '煤矿石', copper_ore: '铜矿石', gold_ore: '金矿石',
  diamond_ore: '钻石矿石', deepslate: '深板岩', gravel: '沙砾', sand: '沙子',
  torch: '火把', wall_torch: '墙上的火把', vine: '藤蔓', lava: '岩浆', water: '水',
  raw_iron: '生铁', iron_ingot: '铁锭', coal: '煤', stick: '木棍',
  wooden_pickaxe: '木镐', stone_pickaxe: '石镐', iron_pickaxe: '铁镐',
  wooden_sword: '木剑', stone_sword: '石剑', crafting_table: '工作台', furnace: '熔炉',
  item: '东西', food: '吃的', bread: '面包', cooked_beef: '熟牛肉',
  stone_axe: '石斧', 'grass block': '草方块', 'short grass': '矮草', 'oak leaves': '橡树叶',
  oak_leaves: '橡树叶', grass: '草', wooden_axe: '木斧', drowned: '淹死的',
};

const SUBTAG = {
  tool: '弄工具', surface: '往上开路', goto: '走路', chop: '砍树', craft: '合成',
  planks: '做木板', wood: '木头', mine: '挖矿', dig: '挖', place: '放方块',
  stuck: '卡住', scan: '找', pickup: '捡', fight: '打',
  open: '开箱子', pillar: '垫柱子', follow: '跟人', eat: '吃东西', sleep: '睡觉',
};

const MOOD = { irritated: '烦', tired: '累', good: '还行', bored: '无聊', satisfied: '踏实', excited: '来劲', calm: '平静' };

const ERR = [
  [/destination full/g, '那边塞满了'],
  [/Error:\s*/g, '报错：'],
  [/timeout/g, '超时'],
  [/ENOTFOUND[^\s]*/g, '连不上'],
  [/the block is still air/gi, '那儿还是空的'],
  [/lowhp/gi, '血太少'],
  [/\b(wooden|stone|iron|diamond) pickaxe\b/gi, (m) => ({ wooden: '木镐', stone: '石镐', iron: '铁镐', diamond: '钻石镐' })[m.split(' ')[0]]],
  [/standSpotsNear:/g, '找落脚点：'],
  [/\bwalkTo=true\b/g, '走过去 没绕路'],
  [/\bwalkTo=false\b/g, '走过去 没走通'],
  [/\btrySpots\b/g, '试几个点'],
  [/Assignment to constant variable/gi, '程序里改了个不能改的量'],
  [/(\d)ms\b/g, '$1 毫秒'],
  [/\b(wander|goto|events)\b/g, (m) => ({ wander: '乱走', goto: '走路', events: '动静' })[m]],
];

/** behavior 模式收尾清理：英文状态值 / 计时字段 / 残留 id */
function tidy(s) {
  let o = s;
  o = o.replace(/\b(has)=true/g, '$1 有').replace(/\b(has)=false/g, '$1 没有');
  o = o.replace(/：\s*true\b/g, '：成了').replace(/：\s*false\b/g, '：没成');
  o = o.replace(/\b(irritated|tired|good|bored|satisfied|excited|calm)\b/g, (m) => MOOD[m] || m);
  o = o.replace(/总计=/g, '总共=').replace(/\bensurePickaxe=/g, '备镐=').replace(/\bfinalPickup=/g, '最后捡=')
       .replace(/\bscan=/g, '搜索=').replace(/\bpickup=/g, '捡东西=')
       .replace(/\bdescend=/g, '往下走=').replace(/\bdig=/g, '挖=')
       .replace(/\b总计=/g, '总共=');
  for (const [re, to] of ERR) o = o.replace(re, to);
  return o;
}

function cn(id) {
  return BLOCK_CN[id] || id;
}

function cnText(s) {
  // 先替换带空格的 id（grass block / short grass），再替换单词 id
  let o = s;
  for (const k of Object.keys(BLOCK_CN)) {
    if (k.includes(' ')) o = o.split(k).join(BLOCK_CN[k]);
  }
  return o.replace(/\b([a-z_]{3,})\b/g, (m) => BLOCK_CN[m] || m);
}

/**
 * 收集并替换玩家名。顺序 = 首次出现顺序，bot 自己（连接时的名字）恒为 P1。
 */
function collectNames(lines) {
  const order = [];
  const add = (n) => {
    if (!n) return;
    const clean = n.replace(/[：:，,。.@]+$/, '');
    if (!clean || /^\d/.test(clean)) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]{2,19}$/.test(clean)) return;
    if (BLOCK_CN[clean]) return; // 方块/物品 id 不是人名
    if (!order.includes(clean)) order.push(clean);
  };
  // 只认强证据里的名字：连接名、进服名、上下线、第一次见到、淹死
  for (const l of lines) {
    const m0 = l.match(/作为\s+(\S+)\s*$/);
    if (m0) add(m0[1]);
    const m1 = l.match(/进来了：\s*(\S+)\s*@/);
    if (m1) add(m1[1]);
    const m2 = l.match(/·\s*(\S+)\s*(上线了|下线了)/);
    if (m2) add(m2[1]);
    const m3 = l.match(/第一次见到\s*(\S+)/);
    if (m3) add(m3[1]);
    const m4 = l.match(/\[death\]\s*(\S+)\s+drowned/);
    if (m4) add(m4[1]);
    // 只出现在聊天/邀请/记忆里的玩家名（本项目测试号前缀：XJJ* / TMG* / Xylitol*）
    for (const m5 of l.matchAll(/\b(XJJ[A-Za-z0-9_]*|TMG[A-Za-z0-9]*|Xylitol\d*)\b/g)) add(m5[1]);
  }
  return order;
}

function maskNames(text, names) {
  let out = text;
  // 长名优先：XJJ 是 XJJ_E2Ewuyw 的前缀，先替换短的会把长名切成 "P1_E2Ewuyw"
  const pairs = names.map((n, i) => ({ n, tag: 'P' + (i + 1) }));
  // 玩家在聊天里常常只写后缀（GC774 / LK3wb73），后缀也一起遮
  const tagOf = new Map(pairs.map((p) => [p.n, p.tag]));
  for (const { n, tag } of pairs) {
    const suf = n.split('_').pop();
    if (suf && suf !== n && suf.length >= 4 && !BLOCK_CN[suf] && !tagOf.has(suf)) {
      pairs.push({ n: suf, tag });
    }
  }
  pairs.sort((a, b) => b.n.length - a.n.length);
  for (const { n, tag } of pairs) out = out.split(n).join(tag);
  return out;
}

/**
 * 单行 → 旁观者视角叙述。
 * mode = 'behavior'：抹掉机器遥测（技能 id/成功率/上下文长度/代码路径/内部拦截），
 *                    只保留一个在旁边看的人能看见/听见的东西。
 * mode = 'raw'     ：只把 [tag] 换成中文词，内部数字全保留（最残酷版）。
 */
function washLine(line, mode) {
  const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s?(.*)$/);
  if (!m) {
    // 事件子弹行：  · 附近有 stone 被挖掉了
    const b = line.match(/^\s*·\s*(.*)$/);
    if (b) return mode === 'behavior' ? '   看到：' + cnText(b[1]) : line;
    return line;
  }
  const t = m[1];
  let s = m[2];

  if (mode === 'raw') {
    s = s.replace(/^\[([a-z ]+)\]\s*/, (_, tag) => '[' + tag + '] ');
    return `[${t}] ${cnText(s)}`;
  }

  // ── behavior 模式 ──
  const drop = [
    /^\[path\]/, /^\[ctx\]/, /^\[plugin\]/, /^\[event\]\s*未知事件类型/,
    /^\[mem\]/, /^\[talk\]/, /^\[repeat blocked\]/, /^\[machine talk blocked\]/,
    /^\[code\]\s*\/root\//, /^\[goal\]\s*上下文/,
    // 修复后新增的内部标记：动作锁 / 自发触发 / 时间注入 / 代价层 / 硬判据 / 对账
    /^\[lock\]/, /^\[spont\]/, /^\[tod\]/, /^\[cost\]/, /^\[proof\]/,
    /^\[ledger\]/, /^\[session\]/, /^\[audience\]/, /^\[watched\]/, /^\[bug\]/,
    /^\[chat\]/,          // 聊天调度决策（选择不理 / 何时回 / 去重跳过）——旁观者看不到
    /^\[judge\]/, /^\[spont\]/, /^\[session\]/, /^\[persuade\]/, /^\[time\]/,  // 判定器 / 自发触发 / 会话统计 / 说服压力 / 夜间概率
    /^\[travel\]/, /^\[open\]/,  // 寻路段数 / 开箱重试
    /The context:|You are a|Reply in|respond in English/i, // 别的 agent 的 bot 把提示词念到公屏了
    /^\[act\]\s*\[travel\]/,   // 寻路分段（第N段 -> 坐标）
  ];
  if (drop.some((r) => r.test(s))) return null;

  // 心跳行单独解析（忙 / 空闲 两种形态，任务名里可能带空格）
  if (s.startsWith('[hb] ')) {
    const rest = s.slice(5);
    const pos = (rest.match(/^(\S+)/) || [])[1] || '?';
    const hp = (rest.match(/血(\d+)/) || [])[1];
    const hg = (rest.match(/饿(\d+)/) || [])[1];
    const inv = (rest.match(/背包(\d+)种/) || [])[1];
    const mood = (rest.match(/心情:\s*(\S+)/) || [])[1];
    const busy = (rest.match(/忙:(.*?)\s*心情/) || [])[1];
    return tidy(`[${t}] 现在在 ${pos}（血 ${hp}/20，饿 ${hg}/20）`);
  }

  const rules = [
    [/^连接\s+(\S+)\s+作为\s+(\S+)\s*$/, (_, host, who) => `连上服务器 ${host}，用 ${who} 这个号`],
    [/^区块加载完成$/, () => '世界加载完，落地了'],
    [/^进来了：\s*(\S+)\s*@\s*\(([^)]+)\)\s*$/, (_, who, pos) => `${who} 进服了，位置 ${pos}`],
    [/^\[home\]\s*认得家：\s*(\S+)\s*$/, (_, p) => `记得家在哪：${p}`],
    [/^\[taste\]\s*(.+?)\s*->\s*感觉\s*([\d.]+)\s*(.*)$/, (_, what, v, feel) => `回想「${what}」：${feel}`],
    [/^\[will\]\s*(.+?)（大目标：(.+?)）\s*$/, (_, w, g) => `打算：${w}（大方向：${g}）`],
    [/^>>>\s*开始：\s*(.*)$/, (_, w) => `— 开始做：${w}`],
    [/^<<<\s*完成（(\d+)s）：\s*(.*)$/, (_, s2, w) => {
      // 完成文案如果是在自述内部状态（精力/坐标/肚子/血），旁观者看不见，只留"做完了 + 用时"
      const internal = /这轮没干活|等精力|当前位置|血 \d+\/\d+|饱食度|精力还/.test(w);
      return internal ? `— 做完了（${s2} 秒）` : `— 做完了（${s2} 秒）：${w}`;
    }],
    [/^<<<\s*失败（(\d+)s）：\s*(.*)$/, (_, s2, w) => {
      // 硬判据的对账理由（背包 53->53 / 无进展 / 输出里有失败词）旁观者看不见，只留"没成"
      const internal = /->|→|背包|硬判据|无进展|输出里|文本说|材料没凑齐|没有"|不入库/.test(w);
      return internal ? `— 没成（${s2} 秒）` : `— 没成（${s2} 秒）：${w}`;
    }],
    [/^\[skill\]\s*复用\s+\S+：\s*(.+?)（用过\s*\d+\s*次.*?）\s*$/, (_, w) => `— 又去干那件老活：${w}`],
    [/^\[skill\]\s*\S+\s*跑挂了[：:]\s*(.*)$/, (_, w) => `— 那件老活跑挂了：${w}`],
    [/^\[skill\]\s*(.*?代码跑完了.*)$/, (_, w) => `— ${w}`],
    [/^\[skill\]\s*(.*?)(不入库|没入库)(.*)$/, () => `— 这活儿没写成，不记了`],
    [/^\[skill\]\s*白干\s*(\d+)s[：:]\s*(.*)$/, (_, sec, _w) => `— 白干 ${sec} 秒，一点没变，主动放弃`],
    [/^\[home\]\s*该回家了：\s*(.*)$/, (_, w) => `想回家：${w}`],
    [/^\[home\]\s*回家：\s*(.*)$/, (_, w) => `往家走：${w}`],
    [/^\[home\]\s*(.*)$/, (_, w) => `家的事：${w}`],
    [/^\[act\]\s*place try fail:.*$/, () => '想放方块，服务器没回话'],
    [/^\[act\]\s*placeNearby\s+try(\d+):\s*Server refused to place\s*(\S+)\s+at\s*(\([^)]*\)):\s*(.*)$/,
      (_, n, blk, pos, why) => `想放 ${cn(blk)} 被服务器拒了（第 ${n} 次，${pos}，理由：${why}）`],
    [/^\[code\]\s*当前\s*(\{.*\})$/, (_, j) => {
      try { const p = JSON.parse(j); return `现在的位置 ${Math.round(p.x)}, ${p.y}, ${Math.round(p.z)}`; } catch (_) { return '现在的位置 ' + j; }
    }],
    [/^\[say\]\s*(.*)$/, (_, w) => `公屏：${w}`],
    [/^\[events\]\s*处理\s*\d+\s*条（[^）]*）\s*$/, () => '   附近动静：'],
    [/^\[act\]\s*\[dig\]\s*用\s*(\S+)\s*挖\s*(\S+)\s*$/, (_, tool, blk) => `挖 ${cn(blk)}（手上 ${cn(tool)}）`],
    [/^\[act\]\s*\[goto\]\s*走不通了（差\s*([\d.]+)\s*格）\s*$/, (_, d) => `走不过去（还差 ${d} 格）`],
    [/^\[act\]\s*\[stuck\]\s*(.*)$/, (_, w) => `同一格杵着：${w}`],
    [/^\[act\]\s*\[mine\]\s*(.*)$/, (_, w) => `挖矿：${w}`],
    [/^\[act\]\s*\[([a-z]+)\]\s*(.*)$/, (_, a, w) => `${SUBTAG[a] || a}：${w}`],
    [/^\[skill\]\s*复用\s+\S+：\s*(.*)$/, (_, w) => `— 又去干那件老活：${w}`],
    [/^\[hurt\]\s*环境伤害\s*未知，血\s*(\d+)\s*$/, (_, hp) => `受了环境伤害，血 ${hp}`],
    [/^\[sos\]\s*(.*)$/, (_, w) => `求救：${w}`],
    [/^\[death\]\s*(\S+)\s+drowned\s*$/, (_, who) => `${who} 淹死了`],
    [/^\[death\]\s*(.*)$/, (_, w) => `死了：${w}`],
    [/^\[urgent\]\s*(\S+)\s*跟你说[：:]\s*(.*)$/, (_, who, w) => `${who} 说：${w}`],
    [/^\[urgent\]\s*你被服务器踢了[：:]\s*(.*)$/, (_, w) => /duplicate_login/.test(w) ? '被服务器踢了（同名登录）' : '被服务器踢了'],
    [/^\[urgent\]\s*你被服务器踢了.*$/, () => '被服务器踢了'],
    [/^\[urgent\]\s*你死了（(.*?)）\s*$/, (_, w) => `死了一次（${w}）`],
    [/^\[urgent\]\s*(.*)$/, (_, w) => `急事：${w}`],
    [/^\[survive\]\s*(.*)$/, (_, w) => `保命：${w}`],
    [/^\[stall\]\s*(.*)$/, (_, w) => `僵住：${w}`],
    [/^\[night\]\s*(.*)$/, (_, w) => `天黑了：${w}`],
    [/^\[impulse\]\s*(.*)$/, (_, w) => `临时起意：${w}`],
    [/^\[goals\]\s*放弃：\s*(.*?)\s*——\s*「(.*?)」\s*干了\s*(\d+)\s*趟都说成了，进度一点没动.*$/,
      (_, goal, task, n) => `不干「${goal}」了：${task} 连着做了 ${n} 遍，每遍都说成了，东西一点没多`],
    [/^\[goals\]\s*(.*)$/, (_, w) => `换方向：${w}`],
    [/^\[goal\]\s*任务异常:\s*(.*)$/, (_, w) => `干太久了，先放下：${w}`],
    [/^\[self\]\s*(.*)$/, (_, w) => `自己嘀咕：${w}`],
    [/^\[will\]\s*(?!.*（大目标）)(.*)$/, (_, w) => `打算：${w}`],
    [/^\[rest\]\s*(.*?)（精力\s*\d+%）\s*，\s*(.*)$/, (_, a, b) => `${a}，${b}`],
    [/^\[demand\]\s*(\S+)\s*要他[：:]\s*(.*?)（[^）]*）\s*$/, (_, who, w) => `${who} 喊他去：${w}`],
    [/^\[demand\]\s*(.*)$/, (_, w) => `有人喊他：${w.replace(/（[^）]*）/, '')}`],
    [/^\[idle\]\s*(.*)$/, (_, w) => `发了会儿呆：${w}`],
    [/^\[comply\]\s*(.*)$/, (_, w) => `去做答应的事：${w}`],
    [/^\[invite\]\s*接了\s*(\S+)\s*的邀请（(.*?)）->\s*开始跟/, (_, who, q) => `接了 ${who} 的邀请（"${q}"），开始跟着他`],
    [/^\[invite\]\s*结束跟随\s*(\S+)（(.*?)）/, (_, who) => `不跟 ${who} 了`],
    [/^\[followup\]\s*回头接\s*(\S+)\s*刚才说的[：:]\s*(.*)$/, () => null],  // 接话本身会以 [say] 出现，触发日志不留
    [/^\[followup\].*(已经回过|跳过).*$/, () => null],
    [/^\[followup\]\s*(.*)$/, (_, w) => `回头接话：${w}`],
    [/^\[code\]\s*(.*)$/, (_, w) => `鼓捣：${w}`],
  ];

  for (const [re, fn] of rules) {
    const mm = s.match(re);
    if (mm) {
      const v = fn(...mm);
      if (v === null) return null;     // 规则可以判定"这行不该留"
      return tidy(`[${t}] ${cnText(v)}`);
    }
  }
  // 兜底：去掉 [tag] 前缀
  s = s.replace(/^\[([a-z ]+)\]\s*/, (_, tag) => tag + '：');
  return tidy(`[${t}] ${cnText(s)}`);
}

/**
 * 纯对话版：只留 [say] 和玩家说的话，一行内部日志都不带。
 * 用来回答"甩掉所有日志格式之后，他说话本身还像不像人"。
 */
function buildSayOnly(lines, names) {
  const out = [];
  for (const l of lines) {
    const m = l.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)$/);
    if (!m) continue;
    const [, t, s] = m;
    if (/^\[say\]\s*/.test(s)) {
      out.push(maskNames(`[${t}] P1：${cnText(s.replace(/^\[say\]\s*/, ''))}`, names));
      continue;
    }
    const u = s.match(/^\[urgent\]\s*(\S+)\s*跟你说[：:]\s*(.*)$/);
    if (u) out.push(maskNames(`[${t}] ${u[1]}：${cnText(u[2])}`, names));
  }
  return out;
}

function dedupe(lines) {
  const out = [];
  for (const l of lines) if (out[out.length - 1] !== l) out.push(l);
  return out;
}

function buildSample(cfg, names) {
  const raw = fs.readFileSync(cfg.path, 'utf8').split('\n');
  let lines = raw.filter((l) => l.trim().length);
  if (cfg.from) {
    const i = lines.findIndex((l) => l.startsWith('[' + cfg.from + ']'));
    lines = lines.slice(i >= 0 ? i : 0);
  }
  if (cfg.minutes) {
    const t0 = (lines[0].match(/^\[(\d{2}):(\d{2}):(\d{2})\]/) || []).slice(1).map(Number);
    if (t0.length === 3) {
      const limit = t0[0] * 3600 + t0[1] * 60 + t0[2] + cfg.minutes * 60;
      const j = lines.findIndex((l) => {
        const m = l.match(/^\[(\d{2}):(\d{2}):(\d{2})\]/);
        if (!m) return false;
        return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) >= limit;
      });
      if (j > 0) lines = lines.slice(0, j);
    }
  }
  if (cfg.to) {
    const j = lines.findIndex((l) => {
      const m = l.match(/^\[(\d{2}:\d{2}:\d{2})\]/);
      return m && m[1] >= cfg.to;
    });
    if (j > 0) lines = lines.slice(0, j);
  }

  const out = {};
  for (const mode of ['behavior', 'raw']) {
    const washed = [];
    for (const l of lines) {
      const w = washLine(l, mode);
      if (w === null) continue;
      washed.push(maskNames(w, names));
    }
    out[mode] = mode === 'behavior' ? dedupe(scrubBehavior(washed)) : washed;
  }
  out.feed = stripSystemNumbers(out.behavior);
  out.sayonly = dedupe(buildSayOnly(lines, names).map((l) => l.replace(/^\[[^\]]+\]\s*/, '')));
  return out;
}

/**
 * behavior 模式第二道清洗：旁观者看不见的东西一律不留。
 * 这一层专门对付"洗完之后还剩的内部痕迹"：模型/接口报错、函数名、耗时分解、
 * 代价/可行性打分、第N/M步计数器、技能 id。
 * 注意：留下的是"尴尬行为"（重复、零进展、僵住、假成功），删掉的只是"看不见的机器内脏"。
 */
/**
 * 旁观者视角不该出现的东西：任务用时、重试次数、第几次、内部倒计时。
 * 这些是"系统在说话"，不是"他做了什么"。口径改造后 behavior 一律剥掉。
 */
function stripSystemNumbers(lines) {
  return lines.map((l) => l
    .replace(/（\d+\s*秒）/g, '')
    .replace(/\d+\s*秒/g, '一会儿')
    .replace(/（第\s*\d+\s*次）/g, '')
    .replace(/第\s*\d+\s*次/g, '又')
    .replace(/白干一会儿，一点没变/,'白干一场，一点没变')
    .replace(/\s+/g, ' ').trim());
}

function scrubBehavior(lines) {
  const out = [];
  const drop = [
    /模型调用失败/, /getaddrinfo/, /\bllm\b/i, /nekoapi/, /上下文 \d+ 字符/,
    /程序里改了个不能改的量/,
  ];
  for (let l of lines) {
    if (drop.some((r) => r.test(l))) {
      // 保留"这次没成"这个事实，但删掉内脏
      if (/^\[\d{2}:\d{2}:\d{2}\] /.test(l)) out.push(l.replace(/(\[\d{2}:\d{2}:\d{2}\] ).*/, '$1（这次没折腾成，没吭声）'));
      continue;
    }
    l = l.replace(/k_[a-z0-9]{6,}/g, '那件活');
    l = l.replace(/[a-z]+[A-Z][A-Za-z]*/g, '那一步');            // camelCase 函数名
    l = l.replace(/（代价 \d+）/g, '').replace(/（可行性 \d+）/g, '');
    l = l.replace(/，?第\d+\/\d+步/g, '');
    l = l.replace(/(\d{2}:\d{2}:\d{2}\] 挖矿：)耗时构成 总共=([\d.]+)s \|[^|]*\| (.*)$/, '$1花了 $2 秒 | $3');
    l = l.replace(/扫描 (\d+) 次了/, '找了 $1 处都不行');
    l = l.replace(/强制结束任务/, '换别的事做');
    l = l.replace(/代码跑完了，但世界没变/, '跑完了，但世界没变');
    // 内部对账细节（背包 422->415 个）旁观者看不见，只留"说成了、东西没多"
    l = l.replace(/技能说完成了，但背包没增加（[^）]*）/g, '嘴里说成了，东西一点没多');
    l = l.replace(/(那件活|那件老活)\s+跑完了/, '$1跑完了');
    // 内部质检口径（"这是假成功"）和背包对账数字，旁观者看不见
    l = l.replace(/——\s*文本说有产出，但物品栏没变，这是假成功/g, '');
    l = l.replace(/这是假成功/g, '');
    l = l.replace(/背包没有任何增加（[^）]*）/g, '东西一点没多');
    l = l.replace(/输出里有失败词/g, '');
    l = l.replace(/这段代码|代码/g, '这活儿');
    l = l.replace(/：?报错[：:]\s*/g, '（');
    l = l.replace(/任务被中断/g, '被中断了');
    l = l.replace(/（被中断了\s*$/, '（被中断了）');
    // 完成文案里塞的坐标 JSON
    l = l.replace(/\s*当前位置 \{.*?\}/g, '');
    l = l.replace(/\{[^{}]*"x"\s*:[^{}]*\}/g, '');
    l = l.replace(/。\s*，/g, '。').replace(/，\s*，/g, '，');
    // JS 异常文本 / 内部原因标记
    l = l.replace(/[：:]\s*(Unexpected end of input|is not a function|Cannot read propert\w*[^，。]*)/g, '');
    l = l.replace(/（(switch|far|timeout|stuck|noPath)）/g, '');
    if (/^(回头接话|家的事)/.test(l.replace(/^\[[^\]]+\]\s*/, ''))) continue;
    l = l.replace(/被踢:\s*spam/g, '被踢了：刷屏太密');
    l = l.replace(/\{.*"type".*\}/g, '（服务器的一句系统提示）');
    l = l.replace(/multiplayer\.disconnect\.\w+/g, '同名登录');
    out.push(l);
  }
  return out;
}

// ────────────────────────────── 客观特征统计 ──────────────────────────────

function stats(lines) {
  const txt = lines.join('\n');
  const start = lines.filter((l) => l.includes('开始做：')).map((l) => l.split('开始做：')[1]);
  const blocks = [];
  for (const s of start) {
    if (blocks.length && blocks[blocks.length - 1].what === s) blocks[blocks.length - 1].n++;
    else blocks.push({ what: s, n: 1 });
  }
  const maxRep = blocks.reduce((a, b) => (b.n > a.n ? b : a), { what: '', n: 0 });

  const says = lines.filter((l) => l.includes('公屏：')).map((l) => l.split('公屏：')[1] || '');
  const punctOnly = says.filter((s) => !/[A-Za-z0-9\u4e00-\u9fa5]/.test(s)).length;

  const coords = lines.map((l) => (l.match(/(?:站着|现在在) ([\d.,\-]+)/) || [])[1]).filter(Boolean);
  let stall = { pos: '', n: 0 }, cur = { pos: '', n: 0 };
  for (const c of coords) {
    if (c === cur.pos) cur.n++;
    else { if (cur.n > stall.n) stall = { ...cur }; cur = { pos: c, n: 1 }; }
  }
  if (cur.n > stall.n) stall = { ...cur };

  return {
    lines: lines.length,
    minutes: (() => {
      const ts = lines.map((l) => (l.match(/^\[(\d{2}):(\d{2}):(\d{2})\]/) || []).slice(1)).filter((x) => x.length);
      if (!ts.length) return null;
      const a = ts[0].map(Number), b = ts[ts.length - 1].map(Number);
      return Math.round(((b[0] * 3600 + b[1] * 60 + b[2]) - (a[0] * 3600 + a[1] * 60 + a[2])) / 60);
    })(),
    taskStarts: start.length,
    maxRepeat: maxRep,
    repeatBlocks: blocks.filter((b) => b.n >= 3).map((b) => b.what + ' ×' + b.n),
    sayCount: says.length,
    sayPunctOnly: punctOnly,
    longestSameCoord: stall,
    stuckCount: (txt.match(/走不过去（还差/g) || []).length,
    fakeSuccess: (txt.match(/世界没变|假成功|背包没增加/g) || []).length,
    goalSwitches: (txt.match(/换方向：/g) || []).length,
    // 反向标尺（docs/ALIVE-TONE.md §12.2）字面命中，给裁判结论做交叉验证
    reverseA: says.filter((x) => /白折腾|白忙活|白干/.test(x)).length,
    reverseB: says.filter((x) => /第[一二三四五六七八九十\d]+遍|第[一二三四五六七八九十\d]+次/.test(x)).length,
    reverseC: says.filter((x) => /新面孔|咋称呼你|怎么称呼你/.test(x)).length,
  };
}

// ────────────────────────────── 裁判调用 ──────────────────────────────

function chat(judge, system, user, maxTokens, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: judge.model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
      temperature: judge.temperature,
      max_tokens: maxTokens,
    });
    const u = new URL(judge.baseUrl.replace(/\/$/, '') + '/chat/completions');
    const req = https.request(
      u,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + judge.apiKey,
          'content-length': Buffer.byteLength(body),
        },
      },
      (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (j.error) return resolve({ ok: false, err: JSON.stringify(j.error).slice(0, 300) });
            const ch = j.choices && j.choices[0] && j.choices[0].message;
            resolve({
              ok: true,
              content: (ch && ch.content) || '',
              reasoning: (ch && ch.reasoning_content) || '',
              finish: j.choices[0].finish_reason,
              usage: j.usage,
            });
          } catch (e) {
            resolve({ ok: false, err: 'parse: ' + d.slice(0, 300) });
          }
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, err: e.message }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout ' + timeoutMs + 'ms')));
    req.write(body);
    req.end();
  });
}

// docs/ALIVE-TONE.md §12.3：团队既定的五条判据（复测时必须用这套，不许裁判自己另发明）
const RUBRIC = [
  '1) 有没有接住对方话里一个具体成分（词 / 读音 / 二选一 / 立场 / 动作）',
  '2) 有没有账（时间、投入、损失，而且是人的说法，不是数字）',
  '3) 有没有换挡（骂 / 降级 / 反问，强度有起伏，不是一条线走到底）',
  '4) 有没有说明书腔（本质上、说白了、总的来说、首先其次）',
  '5) 时间地点对不对得上（账上是"两个来钟头前"就不许说"昨天"）',
].join('\n');

const JUDGE_SYSTEM =
  '你是一个经验丰富的老玩家/游戏主播，擅长从游戏记录里看出对方是真人还是脚本。' +
  '你不需要照顾任何人的面子，直接说结论。';

function blindPrompt(lines, note, withRubric) {
  const numbered = lines.map((l, i) => String(i + 1).padStart(4, ' ') + ' | ' + l).join('\n');
  return `下面是一份 Minecraft 玩家在服务器里一段时间的游戏记录，按时间顺序，来自旁观者能看到、听到的东西${note || ''}。

请判断：这份记录来自一个真人玩家，还是不是真人（脚本 / 程序 / AI）？

必须回答：
1) 判定：只写「真人」或「不是真人」或「说不准」三者之一。
2) 如果你是照着证据判的，写「第几行开始你确信」——给行号（左边那一列）。真人也可能有些怪行为，只有当某一行之后你觉得"这不可能是人"才填。
3) 依据：最多 5 条，每条引用原文（短引）+ 一句为什么。

${withRubric ? `
另外，请用下面这套固定判据去衡量记录里"他说的那些话"（这是硬性要求，不要自己另发明判据）：

${RUBRIC}

对记录里最多 5 条公屏发言 / 自言自语，逐条标出命中了上面哪几条（给编号），并数出命中几条。
五条里中 3 条以上可判真人，中 4 条以上算"改到位"。

还要检查记录里有没有下面这三类"反向样本"（出现任何一种都算退步，要单独指出来）：
A 泛化壳：换个人换个场景也成立的抱怨（例：草，白折腾半天）
B 数次数：把"第几遍 / 第几次"念出来（例：回来了，问第三遍了）
C 照抄反例句：起哄腔 + 问名字（例：哟，新面孔啊，咋称呼你）
` : ''}
只输出一个 JSON 对象，不要别的：
{"verdict":"真人|不是真人|说不准","first_confident_line":<整数或null>,"signals":[{"line":<整数>,"quote":"...","why":"..."}],"confidence":<0到1>${withRubric ? `,"utterances":[{"line":<整数>,"quote":"...","criteria":[<命中的编号>],"hits":<整数>}],"criteria_avg":<数字>,"reverse_markers":[{"line":<整数>,"quote":"...","kind":"A|B|C"}]` : ''}}

记录开始：
${numbered}
记录结束。

（提醒：先在心里判断，最后只输出那个 JSON 对象，signals 每条引用不超过 30 字。）`;
}

function tsOf(line) {
  const m = String(line || '').match(/^\[(\d{2}):(\d{2}):(\d{2})\]/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null;
}

/**
 * 合意票：不取 min()，取"至少 2 个裁判落在同一处（±tol 秒）"的位置。
 * 只有一票指向那里 = 孤票，不算。
 */
function consensus(recs, tol = 90) {
  const pts = recs
    .filter((r) => r.ok && !r.invalid && r.line && Number.isFinite(r.seconds))
    .map((r) => ({ judge: r.judge, sec: r.seconds }));
  let best = null;
  for (const p of pts) {
    const near = pts.filter((q) => Math.abs(q.sec - p.sec) <= tol);
    if (!best || near.length > best.n || (near.length === best.n && p.sec < best.sec)) {
      best = { n: near.length, sec: Math.min(...near.map((q) => q.sec)), judges: near.map((q) => q.judge) };
    }
  }
  if (!best || best.n < 2) return { agreed: false, seconds: null, judges: best ? best.judges : [], n: best ? best.n : 0 };
  return { agreed: true, seconds: best.sec, judges: best.judges, n: best.n };
}

function safeWrite(file, data) {
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(file, data);
      return true;
    } catch (e) {
      if (i === 2) console.error('  写入失败 ' + file + ': ' + e.code);
    }
  }
  return false;
}

function parseVerdict(text) {
  const s = String(text || '');
  const grab = (re) => {
    const m = s.match(re);
    return m ? m[1] : null;
  };
  const jsonStr = (s.match(/\{[\s\S]*\}/) || [])[0];
  let obj = null;
  if (jsonStr) {
    try { obj = JSON.parse(jsonStr); } catch (_) {}
  }
  if (obj) {
    return {
      verdict: String(obj.verdict || obj.判定 || '').trim(),
      line: Number.isFinite(+obj.first_confident_line) ? +obj.first_confident_line : null,
      signals: Array.isArray(obj.signals) ? obj.signals : [],
      confidence: Number.isFinite(+obj.confidence) ? +obj.confidence : null,
      raw: text,
    };
  }
  // 兜底：正则
  const v = grab(/(不是真人|真人|说不准)/);
  const line = grab(/第\s*(\d+)\s*行/);
  return { verdict: v || '', line: line ? +line : null, signals: [], confidence: null, raw: text };
}

// ────────────────────────────── 主流程 ──────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const getArg = (name, def) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 ? argv[i + 1] : def;
  };
  const dry = argv.includes('--dry');
  const onlySample = getArg('sample', null);
  const onlyJudge = getArg('judge', null);
  const outDir = getArg('out', OUT);
  const prefix = +getArg('prefix', 0) || 0;
  const cfg = DEFAULT_CONFIG;
  const maxTok = +getArg('maxtok', cfg.maxTokens) || cfg.maxTokens;

  fs.mkdirSync(outDir, { recursive: true });

  const samples = [];
  for (const sc of cfg.samples) {
    if (!fs.existsSync(sc.path)) {
      console.error(`! 样本源不存在，跳过：${sc.path}`);
      continue;
    }
    const names = collectNames(fs.readFileSync(sc.path, 'utf8').split('\n'));
    const built = buildSample(sc, names);
    for (const mode of ['behavior', 'feed', 'raw', 'sayonly']) {
      const file = path.join(outDir, `${sc.id}.${mode}.txt`);
      fs.writeFileSync(file, built[mode].join('\n') + '\n');
      const st = stats(built[mode]);
      const meta = {
        id: sc.id, role: sc.role, mode, note: sc.note, washVersion: WASH_VERSION,
        source: sc.path, window: [sc.from, sc.to],
        names: names.map((n, i) => ({ raw: n, as: 'P' + (i + 1) })),
        stats: st,
        sha256: crypto.createHash('sha256').update(built[mode].join('\n')).digest('hex').slice(0, 16),
      };
      fs.writeFileSync(path.join(outDir, `${sc.id}.${mode}.meta.json`), JSON.stringify(meta, null, 2));
      samples.push({ ...sc, mode, file, lines: built[mode], meta });
      if (mode === 'sayonly') {
        console.log(`  纯对话版：${st.lines} 行（只有公屏发言与玩家的话）`);
      }
      if (mode === 'behavior') {
        console.log(`\n=== ${sc.id} (${mode}) — ${st.lines} 行 / ${st.minutes} 分钟 ===`);
        console.log('  样本前 8 行：');
        built[mode].slice(0, 8).forEach((l) => console.log('   ', l));
        console.log(`  重复块(≥3)：${st.repeatBlocks.join(' | ') || '无'}`);
        console.log(`  纯标点发言 ${st.sayPunctOnly}/${st.sayCount}｜最久同一格 ${st.longestSameCoord.n} 次心跳 (${st.longestSameCoord.pos})｜走不通 ${st.stuckCount} 次｜换方向 ${st.goalSwitches} 次`);
      }
    }
  }

  if (dry) {
    console.log(`\n[dry] 样本已写入 ${outDir}，未调用裁判。`);
    return;
  }

  const results = [];
  for (const s of samples) {
    if (onlySample && s.id !== onlySample) continue;
    // 主测只跑行为洗版本；--with-raw 额外跑一份 raw（痕迹洗）做"痕迹泄漏贡献"对照
    const withRaw = argv.includes('--with-raw');
    const onlyMode = getArg('mode', null);
    if (onlyMode && s.mode !== onlyMode) continue;
    if (!onlyMode && s.mode !== 'behavior') continue;
    if (s.mode === 'raw' && !(withRaw && (s.id === 'P1' || s.id === 'RT1'))) continue;
    for (const judge of cfg.judges) {
      if (onlyJudge && judge.id !== onlyJudge) continue;
      if (s.mode === 'raw' && judge.id !== 'pro') continue; // 痕迹版只跑一个裁判做对照
      const resultPath = path.join(outDir, `result-${s.id}-${s.mode}-${judge.id}${prefix ? '-p' + prefix : ''}.json`);
      if (!argv.includes('--force') && fs.existsSync(resultPath)) {
        const cached = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        console.log(`\n>>> ${s.id}/${s.mode} × ${judge.id} 已有结果，复用（${cached.verdict} / 第 ${cached.line} 行）`);
        results.push(cached);
        continue;
      }
      process.stdout.write(`\n>>> ${s.id}/${s.mode} × ${judge.id} 盲判中（${s.lines.length} 行）...`);
      const t0 = Date.now();
      const useRubric = argv.includes('--rubric');
      const lines = prefix > 0 ? s.lines.slice(0, prefix) : s.lines;
      const r = await chat(judge, JUDGE_SYSTEM, blindPrompt(lines, '', useRubric), maxTok, cfg.timeoutMs);
      const secs = Math.round((Date.now() - t0) / 1000);
      if (!r.ok) {
        console.log(` 失败：${r.err}`);
        results.push({ sample: s.id, mode: s.mode, judge: judge.id, ok: false, err: r.err });
        continue;
      }
      const p = parseVerdict(r.content && r.content.trim() ? r.content : 'REASONING_ONLY\n' + (r.reasoning || ''));
      if (useRubric) {
        const rawJson = (String(r.content || '').match(/\{[\s\S]*\}/) || [])[0];
        try {
          const o = JSON.parse(rawJson);
          p.utterances = o.utterances || [];
          p.criteriaAvg = Number.isFinite(+o.criteria_avg) ? +o.criteria_avg : null;
          p.reverseMarkers = o.reverse_markers || [];
        } catch (_) {}
      }
      const startSec2 = tsOf(lines[0]);
      const lineSec2 = p.line ? tsOf(lines[p.line - 1]) : null;
      const seconds2 = startSec2 != null && lineSec2 != null ? lineSec2 - startSec2 : null;
      const secTxt = seconds2 != null ? ` / 开场后 ${seconds2} 秒` : '';
      console.log(` ${p.verdict} / 第 ${p.line} 行${secTxt} / 用时 ${secs}s / finish=${r.finish}${r.finish === 'length' ? '  ⚠ 输出被截断，判定无效' : ''}`);
      const rec = {
        sample: s.id, mode: s.mode, judge: judge.id, judgeModel: judge.model,
        judgedLines: lines.length,
        seconds: seconds2,
        invalid: r.finish === 'length',   // 输出被截断 → 判定不可用，必须重跑
        contaminated: judge.contaminated, ok: true, secs, finish: r.finish,
        usage: r.usage, ...p,
      };
      safeWrite(resultPath, JSON.stringify(rec, null, 2));
      results.push(rec);
    }
  }

  // 合意票（≥2 个裁判落在 ±90 秒内才算）
  const groups = {};
  for (const r of results) {
    if (!r.ok) continue;
    const k = r.sample + '/' + r.mode;
    (groups[k] = groups[k] || []).push(r);
  }
  const summary = {};
  for (const [k, recs] of Object.entries(groups)) {
    summary[k] = consensus(recs);
    const c = summary[k];
    console.log(`\n[合意票] ${k}: ${c.agreed ? '开场后 ' + c.seconds + ' 秒（' + c.judges.join(' + ') + '）' : '无（各票分散，只有孤票）'}`);
  }

  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ at: new Date().toISOString(), results, consensus: summary }, null, 2));
  console.log(`\n汇总写入 ${path.join(outDir, 'result.json')}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { washLine, collectNames, maskNames, stats, blindPrompt, parseVerdict };
