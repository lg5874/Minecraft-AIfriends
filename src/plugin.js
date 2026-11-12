'use strict'
/**
 * 插件适配层。
 *
 * 问题：服务器以后会装各种插件（经济、领地、传送、小游戏…）。
 * 他能不能用，取决于插件是"哪种形态"。
 *
 * 三种形态：
 *   1. **指令型**：插件提供 /sethome /spawn /pay 这类命令
 *      → 他只要会敲指令就行。**这个完全能做到**，而且跟真人一样。
 *
 *   2. **物品/方块型**：插件加了自定义物品、方块、GUI
 *      → 需要 mineflayer 认识这些东西。原版的没问题；
 *        自定义的要看服务器有没有把定义下发给客户端（Java 版的 registry）。
 *
 *   3. **纯客户端型**：需要装 mod 才有的界面
 *      → 做不到，因为他没有那个客户端。
 *
 * 所以这个模块做三件事：
 *   - 自动探测服务器有哪些指令（tab 补全）
 *   - 把指令分成"能用的"和"危险的"
 *   - 生成提示词，让模型知道"这个服有哪些玩法"
 */

// 绝对不能自己敲的指令（管理类、破坏平衡类）
const FORBIDDEN = [
  /^\/?(op|deop|ban|kick|whitelist|gamemode|give|tp|setblock|fill|clone|summon|kill|effect|enchant|xp|clear|difficulty|gamerule|stop|reload|plugins?|pl|version|ver|icanhasbukkit|bukkit|minecraft)/i,
  /^\/?(sudo|execute|function|datapack|spawnpoint|setworldspawn|save-all|save-off)/i
]

// 明确"这是玩家正常会用的"
const PLAYER_COMMANDS = {
  // 传送/回家
  sethome: '设置家', home: '回家', delhome: '删除家', spawn: '回出生点',
  back: '回到上一个位置', tpa: '请求传送到某人', tpaccept: '同意传送',
  tpahere: '请求某人传送过来', warp: '传送到某个点', warps: '看有哪些传送点',
  setwarp: '设置传送点', tppos: '传送到坐标',
  // 经济
  balance: '看余额', bal: '看余额', pay: '转账', money: '看钱',
  baltop: '看富豪榜', shop: '打开商店', sell: '卖东西', buy: '买东西',
  auction: '拍卖行', ah: '拍卖行', market: '市场',
  // 领地
  claim: '圈地', unclaim: '取消圈地', trust: '信任某人',
  container: '设置容器权限', access: '设置访问权限',
  // 社交
  msg: '私聊', tell: '私聊', w: '私聊', r: '回复私聊',
  mail: '邮件', friend: '好友',
  // 信息
  list: '看在线玩家', who: '看在线玩家', seen: '看某人上次在线',
  ping: '看延迟', stats: '看统计', playtime: '看游戏时长',
  // 其他
  kit: '领新手礼包', kits: '看有哪些礼包', vote: '投票',
  sit: '坐下', hat: '把东西戴头上', nickname: '改昵称', nick: '改昵称'
}

class PluginAdapter {
  constructor (bot, ctx) {
    this.bot = bot
    this.ctx = ctx           // { log, mem }
    this.commands = []       // 探测到的所有指令
    this.usable = []         // 他能用的
    this.known = {}          // 指令 -> 中文说明
    this.lastScanAt = 0
  }

  /** 探测服务器有哪些指令（用 tab 补全） */
  async scan () {
    const bot = this.bot
    return new Promise((resolve) => {
      let done = false
      const finish = (list) => {
        if (done) return
        done = true
        this.commands = list
        this.classify()
        resolve(this.usable)
      }

      const timer = setTimeout(() => finish(this.commands), 4000)

      try {
        bot._client.once('tab_complete', (pkt) => {
          clearTimeout(timer)
          const list = (pkt.matches || [])
            .map(m => (typeof m === 'string' ? m : m.match))
            .filter(Boolean)
          // 去掉带命名空间前缀的重复项
          const clean = Array.from(new Set(list.map(c => c.replace(/^[a-z_]+:/i, ''))))
          finish(clean)
        })
        bot._client.write('tab_complete', {
          transactionId: Math.floor(Math.random() * 1000),
          text: '/',
          assumeCommand: true
        })
      } catch (e) {
        clearTimeout(timer)
        finish([])
      }
    })
  }

  /** 分类：哪些能用，哪些不能用 */
  classify () {
    const usable = []
    const known = {}

    for (const cmd of this.commands) {
      if (FORBIDDEN.some(re => re.test('/' + cmd))) continue
      usable.push(cmd)
      if (PLAYER_COMMANDS[cmd]) known[cmd] = PLAYER_COMMANDS[cmd]
    }

    this.usable = usable
    this.known = known
    this.lastScanAt = Date.now()

    if (this.ctx.log) {
      this.ctx.log(`[plugin] 探测到 ${this.commands.length} 个指令，能用 ${usable.length} 个`)
      const interesting = usable.filter(c => PLAYER_COMMANDS[c])
      if (interesting.length) {
        this.ctx.log('[plugin] 能玩的玩法: ' + interesting.map(c => `/${c}（${PLAYER_COMMANDS[c]}）`).join('、'))
      }
    }
  }

  /**
   * 生成提示词：告诉模型这个服有哪些玩法。
   * 只列他"该知道"的，不列管理指令。
   */
  prompt () {
    if (!this.usable.length) return ''

    const known = this.usable.filter(c => PLAYER_COMMANDS[c])
    const unknown = this.usable.filter(c => !PLAYER_COMMANDS[c] &&
      !/^(help|me|msg|tell|w|r|list|who|trigger|tm|teammsg|about)$/.test(c))

    if (!known.length && !unknown.length) return ''

    const lines = []
    if (known.length) {
      lines.push('这个服有这些玩法（都是玩家正常能用的）：')
      lines.push(known.map(c => `- /${c}：${PLAYER_COMMANDS[c]}`).join('\n'))
    }
    if (unknown.length) {
      lines.push('\n还有一些指令你不确定是干嘛的（想知道就试试，或者问别人）：')
      lines.push(unknown.slice(0, 20).map(c => `/${c}`).join('、'))
    }

    lines.push(`
用这些指令的时候就像普通玩家一样：想回家就 /home，想传送就问人家 /tpa。
不用指令也能玩，但该用的时候用，别自己硬走几十格。

**绝对不要用**管理指令（/op /give /tp /gamemode /setblock 这些），
那不是玩家该碰的，用了就不是"在玩"了。`)

    return `## 这个服的玩法\n${lines.join('\n')}`
  }

  /** 执行一个指令（带安全检查） */
  async run (cmd) {
    const clean = String(cmd || '').replace(/^\//, '').trim()
    if (!clean) return false

    // 安全检查
    if (FORBIDDEN.some(re => re.test('/' + clean))) {
      if (this.ctx.log) this.ctx.log('[plugin] 拒绝执行管理指令: /' + clean)
      return false
    }

    try {
      this.bot.chat('/' + clean)
      if (this.ctx.log) this.ctx.log('[plugin] 执行 /' + clean)
      return true
    } catch (e) {
      return false
    }
  }

  /** 定期重新探测（服务器可能中途装插件） */
  shouldRescan () {
    return Date.now() - this.lastScanAt > 30 * 60 * 1000
  }
}

module.exports = { PluginAdapter, FORBIDDEN, PLAYER_COMMANDS }
