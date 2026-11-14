'use strict'
/**
 * 小徐的主程序。
 *
 * 连接 → 活着 → 自己想干点什么 → 跟人说话。
 */

const fs = require('fs')
const path = require('path')
const judge = require('./src/judge')
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')

const Memory = require('./src/memory')
const { SkillLibrary } = require('./src/skills')
const { Actions, sleep } = require('./src/actions')
const { Coder } = require('./src/coder')
const { LLM } = require('./src/llm')
const Reflex = require('./src/reflex')
const damage = require('./src/damage')   // 伤害类型表（服务端 registry 优先，实测快照兜底）
const Talk = require('./src/talk')
const Will = require('./src/will')
const persona = require('./src/persona')
const knowledge = require('./src/knowledge')
const spontaneous = require('./src/spontaneous')
const { Invite } = require('./src/invite')
const { Watched: Audience } = require('./src/audience')
const { Perception } = require('./src/perceive')
const { PluginAdapter } = require('./src/plugin')
const { EventQueue } = require('./src/events')
const SelfState = require('./src/selfstate')
const { Taste } = require('./src/taste')
const Mood = require('./src/mood')
const { Impulse, classify, judgeFeeling } = require('./src/impulse')
const { Home } = require('./src/home')
const { Goals } = require('./src/goals')
// 代价层：放弃目标要结账、选目标要读记忆（src/cost.js）
const { Cost } = require('./src/cost')
// 实例锁：同一个数据目录只允许一个进程（不然 memory.json 会互相覆盖）
const InstanceLock = require('./src/instance')
const { ActionLock, REASON } = require('./src/actionlock')
const { Session } = require('./src/session')

const ROOT = __dirname
// 数据目录：多实例时每个实例独立（记忆/品味/心情/技能互不干扰）
// 用环境变量 AIFRIEND_DATA 指定，不指定就用默认
const DATA = process.env.AIFRIEND_DATA
  ? path.resolve(ROOT, process.env.AIFRIEND_DATA)
  : path.join(ROOT, 'data', 'runtime')

function loadConfig () {
  const p = path.join(ROOT, process.env.AIFRIEND_CONFIG || 'config.json')
  if (!fs.existsSync(p)) {
    throw new Error(`找不到配置文件：${p}\n先 cp config.example.json config.json 然后填 API key`)
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

class Bot {
  constructor (cfg) {
    this.cfg = cfg
    this.bot = null
    this.running = true

    this.mem = new Memory(DATA)
    // 代价层：账本存在 data/cost.json，记忆写 mem（通过它的公开接口）。
    // 只记账，不参与主循环；挂了也只是少记一笔，不能把 bot 带崩。
    this.cost = new Cost(DATA, { mem: this.mem, log: (s) => this.log(s) })
    this.skills = new SkillLibrary(DATA)
    // 【实测 · 2026-11-14】原来没传 log，llm 的切换/失败日志一条都不会出现
    // 在 main.js 日志里（实机 170s 里 [llm] 计数 = 0，不是没发生，是没打出来）
    this.llm = new LLM(cfg.llm, (s2) => this.log(s2))
    // 记忆层：把这一个小时的事攒成一段日记（voice-owner 的 mem-diary）。
    // 注入 LLM 的同时会起一个 5 分钟 unref 定时器；到点调 maybeWriteDiary()，
    // 一小时没攒够 3 件事就不写（不硬调模型）。
    // 不接也不会崩（writeDiary 里有 _ensureLLM 兜底），但那样会多造一个 LLM 客户端，
    // 而且没人给它起定时器 —— 等于日记永远不写。
    try { this.mem.attachLLM(this.llm) } catch (e) { this.log('[mem] attachLLM 失败: ' + e.message) }

    this.actions = null
    this.coder = null
    this.reflex = null
    this.talk = null
    this.will = null

    // 动作线仲裁：谁在占着 pathfinder。
    // 老的 busy / _homing 全部接到这把锁上（Step 1 兼容层，调用点一行都没改）。
    // busy 的 setter 每次打 `[lock] legacy busy=... @ main.js:行号` —— 那行就是迁移待办清单。
    this.lock = new ActionLock({ log: (s) => this.log(s) })
    // busy 只是锁的**只读**视图：谁占着、占多久去 lock.holders() 看。
    // Step 2 之后没有 setter —— 再写 `this.busy = true` 会直接抛错（严格模式），
    // 这是故意的：它逼你写清楚是哪条动作线，而不是又一个"谁都清得掉"的布尔。
    Object.defineProperty(this, 'busy', {
      configurable: true,
      enumerable: true,
      get: () => this.lock.busy
    })
    this.taskDesc = ''
    this.deathCount = 0
    this.deathsSinceSafe = 0
    this.seekingFood = false
    this.sheltered = false
    this.reconnectTimer = null
    this.clockTimer = null
    this.spont = null
    this.lastInventory = {}
    this.taste = null
    this.mood = null
    this.impulse = null
    this.perceive = null
    this.events = null
    this.plugin = null
    this.selfState = null
    this.home = null
    this.goals = null
    // 长期目标每 30 秒看一眼进度，记在同一处，避免多个地方各自计时
    this._lastGoalObserveAt = 0
  }

  log (s) {
    const t = new Date().toTimeString().slice(0, 8)
    console.log(`[${t}] ${s}`)
  }

  // ==================== 连接 ====================

  connect () {
    const c = this.cfg.bot
    // 重连前把上一局的动作线全部作废：一条没走到 finally 的线会把新一局锁死
    // （主循环看到 busy 就 return，人站着不动还查不出原因）。锁只在内存里，清掉不丢数据。
    if (this.lock) this.lock.forceReleaseAll('重新连接')
    // 新的一局：把上一局的"断线收尾"状态复位（kicked/error 可能没走到 end，
    // 那种情况下 _tornDown 还立着，不复位的话下一局永远收不了尾）。
    this._tornDown = false
    this._interrupted = false
    this.log(`连接 ${c.host}:${c.port} 作为 ${c.username}`)

    const bot = mineflayer.createBot({
      host: c.host,
      port: c.port,
      username: c.username,
      auth: c.auth || 'offline',
      version: c.version,
      hideErrors: false,
      checkTimeoutInterval: 120000,
      // 【视距 = 能不能找到树】2026-11-14
      //
      // 原来是 'short' = 4 区块 = 64 格。而 findBlocks 只扫**已加载区块**，
      // 所以半径设成 96 也没用 —— 64 格外的东西根本没加载。
      //
      // 实测证据：`[02:09:47] [act] [chop] 砍下 1 块原木（birch_log @133,75,116）`
      // 离家 66,64,-92 大约 **70 格** —— 树就在那儿，只是超出了 short 的加载范围。
      //
      // 这就是"背包有 22 根原木却做不出木镐"的另一半真相：
      // 不是 craft 链坏了，是**在他能看见的半径里确实没有木头**。
      //
      // 'normal' = 8 区块 = 128 格，够覆盖 70 格的树。代价是内存和带宽略增。
      viewDistance: 'normal'
    })
    this.bot = bot
    bot.loadPlugin(pathfinder)
    // 1.20.5+ 的 damage_type 注册表由服务端在 login 阶段下发，mineflayer 只收
    // chat/biome/dimension 三类，damage_type 被丢掉 —— 只能自己拦 registry_data。
    // 拦不到也不影响：src/damage.js 里有实测快照表。
    damage.attach(bot)

    bot.once('spawn', () => this.onSpawn())
    bot.on('respawn', () => this.onRespawn())
    bot.on('end', (r) => this.onEnd(r))
    // 【断线三条路径都要收尾】原来 kicked / error 只打一行日志，什么都不清。
    // spam 踢走的是 `kicked` —— 那条路径上以前一个字的状态都不清理。
    // 实测历史日志里的 `错误:` 全是连接级致命（EPIPE / ECONNRESET / ECONNREFUSED），
    // 没有一种是"会话内良性错误"，所以 error 也直接收尾是安全的。
    // _teardown 自己幂等，kicked -> end 连着来也只做一次。
    bot.on('kicked', (r) => {
      const why = 'kicked:' + (typeof r === 'string' ? r : JSON.stringify(r))
      this.log('被踢: ' + (typeof r === 'string' ? r : JSON.stringify(r)))
      try { this._teardown(why) } catch (e) { this.log('[teardown] ' + e.message) }
    })
    bot.on('error', (e) => {
      this.log('错误: ' + (e && e.message))
      try { this._teardown('error:' + (e && e.message)) } catch (e2) { this.log('[teardown] ' + e2.message) }
    })
    bot.on('death', () => this.onDeath())

    bot.on('chat', (username, message) => {
      if (username === bot.username) return
      // 【判定升级 · talk-owner 6f0cf79】「是不是在跟我说话」从正则改成模型判。
      // 正则补不上的漏：「你在哪呢」「在哪呢」没名字、结尾也不是问号 → 老代码判 false，
      // 于是从来不接话茬。模型能判 true，而「这破地方真难找」不会被误当成叫他。
      //
      // 判定是异步的（isAddressedTo 内部 5 秒超时，超了自己退正则）。
      // 所以只把「判定 + 推事件」放进一条 FIFO 链：
      //   · 事件回调本身立刻返回 —— 不耽误下面的 invite / talk，也不挡主循环
      //     （tick 是另一个循环，`await` 在事件回调里不会卡它）
      //   · 两条消息连着来时，链保证仍按收到的顺序 push（否则后一条可能先入队，
      //     events 批次的叙述顺序会乱）
      this._chatEnqueue(username, message)

      // 【能被邀请】先看这句是不是在叫他跟着走 / 别跟了
      if (this.invite) { try { this.invite.handleChat(username, message) } catch (e) {} }

      if (!this.talk) return
      this.talk.onChat(username, message).catch(e => this.log('chat err ' + e.message))
    })

    bot.on('playerJoined', (p) => {
      if (p.username === bot.username) return
      if (this.events) this.events.push('player_join', { who: p.username }, `${p.username} 上线了`)
      if (this.spont) this.spont.push(spontaneous.onPlayerJoin(p.username))
    })
    bot.on('playerLeft', (p) => {
      if (p.username === bot.username) return
      if (this.events) this.events.push('player_leave', { who: p.username }, `${p.username} 下线了`)
      if (this.spont) this.spont.push(spontaneous.onPlayerLeave(p.username))
    })

    // 别人挨打 —— UNHUMAN-SCAN #14。
    // spontaneous.onFriendInDanger 早就写好了，但全项目 0 处调用：
    // 触发源里根本没有"别人受伤"这一类，于是他永远不会说"你怎么了"。
    bot.on('entityHurt', (entity) => this.onEntityHurt(entity))

    bot.on('message', (msg) => {
      const t = msg.toString()
      // 跟自己名字一起出现的死亡消息
      if (!t.includes(bot.username)) return
      // 【BLIND-TEST L1075】原来只认 died|slain|... 一串**英文**。
      // 服务端说中文（"XJJ 被僵尸杀死了"/"XJJ 淹死了"）时整条丢掉，
      // lastDeathMsg 永远是 null，于是写进记忆的是"死了：不知道怎么回事"。
      // 现在中英文都认，并且留一个短缓冲：死亡包和死亡消息的先后顺序不保证。
      const DEATH_MSG = /died|slain|drowned|blew up|fell|burned|starved|withered|hit the ground|was killed|shot|impaled|suffocated|froze|magma|void|kinetic|被.{0,12}(杀|打死|打|射|炸|咬|戳|烧|撞)|淹死|摔死|烧死|饿死|窒息|冻死|岩浆|爆炸|掉出世界|掉了下去|摔了下来|摔下去/
      if (!DEATH_MSG.test(t)) return
      this.lastDeathMsg = t.replace(/^[^:]*:\s*/, '').trim()
      this._deathMsgs = (this._deathMsgs || []).concat([{ at: Date.now(), text: this.lastDeathMsg }]).slice(-5)
    })

    // ==================== 伤害来源识别 ====================
    //
    // packet_damage_event 的真实结构（1.21.11，实测抓包确认）：
    //   { entityId, sourceTypeId, sourceCauseId, sourceDirectId, sourcePosition? }
    //
    // 踩过的三个坑（都是实测）：
    //
    //  1) sourceTypeId 是 **damage type registry id**，不是"0=环境/1=实体"。
    //     老代码拿一张自己编的 0..19 表去映射，跟服务端 registry 完全对不上。
    //     实测摔伤抓到 sourceTypeId=10，按老表算"fall"是巧合撞对的。
    //     现在不再猜 registry 下标：**改用 sourceCauseId 判断有没有实体来源**。
    //
    //  2) sourceCauseId 是 entity id，**不是 id-1**。
    //     老代码写 `pkt.sourceCauseId - 1`，于是永远查错一格。
    //     实测摔伤 cause=0（没有来源实体），减一变成 -1，查出 null，
    //     于是打印"你被不知道什么东西打了"，几十条刷屏。
    //
    //  3) 环境伤害（摔/淹/饿/岩浆）根本没有来源实体，不该走"被谁打了"这条文案。
    // 【2026-11-14 · 实测事故】原来这里有两张手写的 id 表，**整体错位**：
    //   9 其实是 explosion（老表写 lava）、11 是 falling_anvil（老表写 drown）、
    //   24 才是 lava。于是 `[dmg] 未知类型 sourceTypeId=35` 满屏，
    //   死因只会写"受了点伤"，应对自然也选不对。
    // 现在一律走 src/damage.js：服务端 registry（`[registry_data] minecraft:damage_type`，
    // 实测 50 条）优先，拿不到就用实测快照。名字 / 中文文案 / 死因三件事都由它给。
    // 同一类伤害的节流：摔一次游戏会连推好几包，别每条都当新事件
    let lastDmgAt = 0
    let lastDmgKind = ''
    // 每一种伤害类型只打一行（骷髅连射一秒能推两包，不过滤就是刷屏）。
    // 打的是**可读名字**，不是裸 id —— 排查死因全靠这几行。
    const seenDmgType = new Set()

    bot._client.on('damage_event', (pkt) => {
      try {
        if (!bot.entity || pkt.entityId !== bot.entity.id) return

        // causeId 是 entity id 本身。0 = 没有来源实体（环境伤害）。
        const causeId = pkt.sourceCauseId || 0
        const ent = causeId > 0 ? bot.entities[causeId] : null
        // sourceTypeId 是服务端 damage_type 注册表下标（实测：28=mob_attack、0=arrow、
        // 24=lava、10=fall、6=drown、40=starve）。解析成名字 + 大类（人打的/环境）。
        const info = damage.infoOf(pkt.sourceTypeId)
        // 每个类型第一次出现打一行可读的 —— 验收/对账都靠它，且不会刷屏。
        if (!seenDmgType.has(pkt.sourceTypeId)) {
          seenDmgType.add(pkt.sourceTypeId)
          const cause = pkt.sourceCauseId || 0
          const direct = pkt.sourceDirectId || 0
          const same = cause > 0 && cause === direct     // 同一个实体 = 直接被打
          const ids = [cause ? 'cause=' + cause : '', direct ? 'direct=' + direct : ''].filter(Boolean).join(' ')
          this.log(`[dmg] ${info.name}(${pkt.sourceTypeId}) ${info.cat === 'env' ? '环境' : '攻击'}${same ? ' 同实体' : ''}${ids ? ' ' + ids : ''}${info.known ? '' : ' [registry 里没有这个 id]'}`)
        }

        // 有实体来源 -> 就是"被谁打了"
        if (ent) {
          const isPlayer = ent.type === 'player'
          // 怪用中文名（zombie -> 僵尸），玩家用 id
          const from = isPlayer ? (ent.username || '有人') : damage.mobCn(ent.name)
          this.lastDamageKind = info.name
          this.lastDamageFrom = from
          if (this.events) {
            this.events.push(
              isPlayer ? 'attack_by_player' : 'damage',
              { from, health: bot.health },
              `你被${from}打了，血剩 ${Math.round(bot.health)}`
            )
          }
          // 【死因】把这一下的来源存下来 —— onDeath() 靠它说人话。
          // 原来只有 lastDeathMsg（服务端死亡消息），消息一丢就"不知道怎么回事"。
          this._lastDamage = {
            at: Date.now(),
            kind: info.name,
            text: `被${from}打了`,
            // 死因要能说清"被僵尸打死"，不是"受了点伤"
            deathText: damage.deathTextOf(pkt.sourceTypeId, from),
            by: from,
            sourceTypeId: pkt.sourceTypeId
          }
          // 第 4 个参数给反射层：类型/大类/来源实体 —— 它据此决定"跑/打/退"。
          // 不传也能跑（反射层还有掉血速率那条通用触发）。
          if (this.reflex) {
            this.reflex.onHurt(ent, bot.health, info.name, {
              id: pkt.sourceTypeId,
              name: info.name,
              attack: true,
              cat: info.cat,
              causeId: pkt.sourceCauseId || 0,
              directId: pkt.sourceDirectId || 0,
              pos: pkt.sourcePosition || null
            })
          }
          // 【痛觉】血到线以下就真的停手，不是提示词里写一句
          this.onPain(bot.health, this._lastDamage.text)
          return
        }

        // 没有实体来源 -> 环境伤害。别再说"被打了"。
        // 节流：1.5 秒内同一种环境伤害只记一次（摔落会连推多包）。
        const now = Date.now()
        const key = info.name
        if (key === lastDmgKind && now - lastDmgAt < 1500) return
        lastDmgAt = now
        lastDmgKind = key
        this.lastDamageKind = info.name
        this.lastDamageFrom = null

        const text = info.cn
        if (this.events) {
          // 【踩坑】原来推的类型是 'damage_env'，而 events.js 的 TYPES 表里
          // 根本没有这个键（表里叫 'damage'，注释就写着"伤害来源是环境"）。
          // 于是每挨一次环境伤害都只留一行「[event] 未知事件类型: damage_env」，
          // 事件被丢掉 —— 他永远不知道"快淹死了，血剩 5"。
          // 6 秒内同一种环境伤害合并成一条（溺水一秒一包），
          // 但 what 每次都更新成最新血量 —— 急件不刷屏，又不能报到旧数字。
          this.events.push(
            'damage',
            { kind: info.name, health: bot.health },
            `${text}，血剩 ${Math.round(bot.health)}`,
            { cooldown: 6000, whatUpdate: true, dedupeKey: 'env:' + info.name }
          )
        }
        // 【死因】环境伤害同样要落一条，否则淹死/摔死也会变成"不知道怎么回事"
        this._lastDamage = {
          at: Date.now(),
          kind: info.name,
          text,
          deathText: damage.deathTextOf(pkt.sourceTypeId),
          by: null,
          sourceTypeId: pkt.sourceTypeId
        }
        // 【痛觉】环境伤害更容易"眼睁睁看着死"（L547 连挖到第 12 层）
        this.onPain(bot.health, text)
        // 环境伤害也要走反射层 —— 溺水/摔落一样会死
        if (this.reflex) {
          this.reflex.onHurt(null, bot.health, info.name, {
            id: pkt.sourceTypeId,
            name: info.name,
            attack: info.attack,
            cat: info.cat,
            causeId: pkt.sourceCauseId || 0,
            directId: pkt.sourceDirectId || 0,
            pos: pkt.sourcePosition || null
          })
        }
      } catch (e) {}
    })

    // ==================== 事件源（perception-owner 补） ====================
    // 规矩：每个监听器里只有一行推送，判断/节流/格式化全在 src/events.js。
    // 这样 main.js 不被业务逻辑污染，以后加事件源也不动主循环。
    // 每个 pushXxx 自己 try/catch，断了不会把连接带崩。
    bot.on('health', () => { if (this.events) this.events.pushHealth(bot) })
    bot.on('time', () => { if (this.events) this.events.pushTime(bot) })
    bot.on('rain', () => { if (this.events) this.events.pushWeather(bot) })
    bot.on('weatherUpdate', () => { if (this.events) this.events.pushWeather(bot) })
    bot.on('blockUpdate', (oldBlock, newBlock) => { if (this.events) this.events.pushBlockChange(oldBlock, newBlock, bot) })
    bot.on('blockBreakProgressObserved', (block, stage, entity) => { if (this.events) this.events.pushDig(block, bot, entity) })
    bot.on('playerCollect', (collector, collected) => { if (this.events) this.events.pushCollect(collector, collected, bot) })
    bot.on('experience', () => { if (this.events) this.events.pushExp(bot) })
    bot.on('entityMoved', () => { if (this.events) this.events.pushProximity(bot) })
    bot.on('kicked', (reason) => { if (this.events) this.events.pushKick(reason) })
    bot.on('respawn', () => { if (this.events) this.events.pushRespawn(bot) })
  }

  // ==================== 上线 ====================

  async onSpawn () {
    const bot = this.bot

    // 补配方数据：服务器 registry 里没有 recipes，mineflayer 的合成会全废
    try {
      if (!bot.registry.recipes) {
        const mcData = require('minecraft-data')(bot.version)
        bot.registry.recipes = mcData.recipes
        bot.registry.items = bot.registry.items || mcData.itemsArray
        this.log('补上配方数据：' + Object.keys(mcData.recipes).length + ' 条')
      }
    } catch (e) {
      this.log('补配方失败: ' + e.message)
    }

    // 等区块，不然 findBlock 全是 null
    try {
      await bot.waitForChunksToLoad()
      this.log('区块加载完成')
    } catch (e) {}

    this.log('进来了：' + bot.username + ' @ ' + bot.entity.position)

    // ===== 寻路配置（实测调过）=====
    const moves = new Movements(bot)
    moves.canDig = true
    moves.digCost = 20          // 别太低，不然它到处乱挖

    // 【关键】允许搭方块往上爬
    // 实测：打开后 pathfinder 1.2 秒能把自己顶上 3 格，1 格宽通道也管用。
    // 关着的话他永远爬不出洞 —— 这是"困在地下"的根本原因。
    moves.allow1by1towers = true
    moves.scafoldingBlocks = [
      bot.registry.itemsByName.dirt.id,
      bot.registry.itemsByName.cobblestone.id,
      bot.registry.itemsByName.andesite.id,
      bot.registry.itemsByName.stone.id,
      bot.registry.itemsByName.gravel.id
    ].filter(x => x != null)

    moves.canOpenDoors = true
    moves.liquidCost = 20       // 别太怕水（怕水走不了路），也别主动跳
    moves.maxDropDown = 3       // 最多跳 3 格（8 格会摔死）
    // 【maxDropDown 唯一漏掉的场景】引擎默认 infiniteLiquidDropdownDistance=true，
    // 而 movements.js:487 是 `if (!this.infiniteLiquidDropdownDistance && 落差 > maxDropDown) return`
    // —— 也就是**落点是水时，上面那个 3 完全不生效**，可以从任意高度跳进水里。
    // 实测（move-owner）：改后 15 分钟内 4 次坠落，最大一次 11.9 格（y 62→50），
    // 落水没掉血，但人被冲下去 12 格，紧接着 `[survive] 在水里/憋气，先浮上去`；
    // 早期探针里的 `[death] 快淹死了` 就是这条路的终点。
    // 关掉之后"3 格安全线"对实地和水面同时成立，代价是过河/下矿可能绕一点路。
    moves.infiniteLiquidDropdownDistance = false

    bot.pathfinder.setMovements(moves)
    this._moves = moves
    this.log(`[path] canDig=${moves.canDig} towers=${moves.allow1by1towers} 搭塔方块=${moves.scafoldingBlocks.length}种`)

    // 计时开始（下线不走）
    const online = this.mem.goOnline()
    this.startClock()

    // 组件
    const self = this
    this.actions = new Actions(bot, {
      log: (s) => this.log(s),
      cfg: this.cfg,
      mem: this.mem,
      get reflex () { return self.reflex },
      onComplain: (kind, detail) => {
        if (!this.spont) return
        const ev = spontaneous.onComplain(kind, detail)
        if (ev) this.spont.push(ev)
      }
    })
    // 家：认家 / 记路 / 走回去。
    // 必须放在 actions 之后 —— 它寻路失败时要借 actions.goto 兜底。
    // attach() 之后：放下箱子/床自动认家，每 1.5 秒记一次出门的路。
    this.home = new Home(bot, {
      dataDir: DATA,
      log: (s) => this.log(s),
      mem: this.mem,
      actions: this.actions
    })

    // 静止自救：30 秒没挪窝就强制换动作（修 UNHUMAN-SCAN #5）
    // 实测原来在 61,32,-10 站了 270 秒，玩家一眼看出这号卡了。
    this.actions.startWatchdog()

    this.home.attach()
    this.coder = new Coder(bot, this.actions, this.llm, this.skills, {
      log: (s) => this.log(s),
      say: (m) => this.talk ? this.talk.say(m) : null,
      mem: this.mem,
      cfg: this.cfg,
      dumpCode: (goal, code, attempt) => this.dumpCode(goal, code, attempt),
      // 白干的时间要能结算：技能层主动放弃时回调到这里
      onNoProgress: (secs, goal) => {
        try {
          this.skills.data.stats = this.skills.data.stats || {}
          this.skills.data.stats.noProgressAbandons = (this.skills.data.stats.noProgressAbandons || 0) + 1
          this.skills.data.stats.noProgressSeconds = (this.skills.data.stats.noProgressSeconds || 0) + secs
          this.skills.save()
        } catch (e) {}
        this.log(`[cost] 白干 ${secs}s（${String(goal).slice(0, 20)}）`)
      }
    })
    this.talk = new Talk(bot, this.llm, this.mem, {
      log: (s) => this.log(s),
      cfg: this.cfg,
      // 只有真的在干正事才算忙。卡住/发呆/原地折腾都不算
      busy: () => {
        if (!this.busy) return false
        // 如果一分钟没动静，就不算忙了（他只是在等模型或者卡住了）
        if (this._taskProgress && Date.now() - this._taskProgress.at > 60000) return false
        return true
      },
      currentTaskDesc: () => this.taskDesc ? `你现在正在${this.taskDesc}。` : '你现在没什么事干。',
      taskDesc: () => this.taskDesc,
      actions: this.actions,
      dataDir: DATA,
      mood: this.mood,
      taste: this.taste,
      perceive: this.perceive,
      botNames: (this.cfg.behavior && this.cfg.behavior.botNames) || [],
      // 他答应了别人要干的事：插队执行
      onComply: (who, task) => {
        this.log('[comply] 答应 ' + who + ' 去干：' + task)
        if (this.impulse) {
          this.pendingTask = { text: '帮 ' + who + ' ' + task, from: who, at: Date.now() }
        }
      }
    })
    // 长期目标：心里挂着的一件事，跨天不丢（data/runtime/goals.json）。
    // 必须放在 will 之前 —— will.think() 第一件事就是看有没有长期目标的当前阶段，
    // 有就直接接着干，而不是每天从零想"我今天干嘛"。
    // taste 这时候还没构造，用 getter 延迟取（tasteBonus 是运行时才读的）。
    this.goals = new Goals(DATA, {
      llm: this.llm,
      ctx: {
        log: (s) => this.log(s),
        get taste () { return self.taste },
        actions: this.actions,
        // 【跨层闸门】session 在下面才构造，必须 getter 延迟取。
        // goals.isResting() 要读它判断"今天是不是已经收工"。
        // 实测冲突（run5 22:19-22:23）：
        //   [session] 今天到此为止，回去歇着
        //   [goals]  换法子（目标不变）：找块够平的地方…   ← 收工了还在派人
        // 跟"休息窗口里启动 5 个任务"是同一个病，只是信号源从 mood.resting 换成 session.phase。
        get session () { return this.session },
        // 【让看门狗从"猜"变成"读"】2026-11-14
        //
        // goals 的 30 秒看门狗原来只能靠"最后一条 [act] 日志 + 位移"猜他在不在干活，
        // 于是把「任务刚收尾 + 下一个任务正在跑」这 37 秒也算成"没动作"——
        // 实测误判：03:20:16 完成 → 03:20:43 重立 → 03:20:53 判卡死 → 放弃整个盖房目标。
        //
        // 接上 busy / taskSince 之后它直接读，不用猜。纯 additive，不改任何控制流。
        get busy () { return self.busy },
        get taskSince () { return self._taskStartAt }
      }
    })
    // 代价层挂上去：放弃时结算、选目标时读记忆、提示词里带上"最近的亏"。
    // 用实例包装而不是改 goals.js —— 那边在改，而且 settle() 幂等，
    // 将来挪进 goals.js 也不会重复记账。
    // 注意：goals 每次上线都会重建，所以 attach 必须留在这里（connect 里）。
    try {
      this.cost.attach(this.goals)
    } catch (e) {
      this.log('[cost] 接线失败: ' + e.message)
    }
    this.will = new Will(this.llm, this.mem, this.skills, {
      log: (s) => this.log(s),
      cfg: this.cfg,
      actions: this.actions,
      goals: this.goals,
      deaths: () => this.deathsSinceSafe,
      deathsReset: () => { this.deathsSinceSafe = 0 }
    })
    this.reflex = new Reflex(bot, {
      mem: this.mem,
      log: (s) => this.log(s),
      cfg: this.cfg,
      // 只有真的在干正事才算忙。卡住/发呆/原地折腾都不算
      busy: () => {
        if (!this.busy) return false
        // 如果一分钟没动静，就不算忙了（他只是在等模型或者卡住了）
        if (this._taskProgress && Date.now() - this._taskProgress.at > 60000) return false
        return true
      },
      onEvent: (kind, data) => this.onReflexEvent(kind, data),
      // 【求救要能说出口】reflex 原来只动作不说话 —— ctx.say 从来没传过，
      // 所以血 3 卡在洞里的 20 分钟里他一句没吭（实测 /tmp/soak2.log）。
      // 明天用户第一眼最需要听到的就是"我快不行了，有吃的吗"。
      // talk 还没建好时静默跳过（构造顺序上 reflex 早于 talk）。
      say: (t) => { try { if (this.talk) this.talk.say(t) } catch (e) {} }
    })
    this.reflex.start()

    // 事件队列：所有事情先进这里
    this.events = this.events || new EventQueue({ log: (m) => this.log(m) })
    this.events.onWake((ev) => this.onUrgentEvent(ev))

    // 自我状态：让他"一直在场"（知道自己的镐子还在不在）
    this.selfState = new SelfState(bot, {
      log: (m) => this.log(m),
      events: this.events
    })
    this.selfState.start()

    // 感知层：把世界翻译成人能看懂的话
    this.perceive = new Perception(bot, {
      mem: this.mem,
      events: this.events,
      log: (m) => this.log(m)
    })

    // 插件适配：探测这个服有哪些玩法
    this.plugin = new PluginAdapter(bot, { log: (m) => this.log(m), mem: this.mem })
    setTimeout(() => {
      this.plugin.scan().then(list => {
        this.log('[plugin] 扫描完成: ' + list.length + ' 个可用指令')
      }).catch(e => this.log('[plugin] 扫描失败: ' + e.message))
    }, 6000)

    // 品味（自己长出来的）和心情（会影响判断）
    this.taste = this.taste || new Taste(DATA)
    this.mood = this.mood || new Mood(DATA)
    this.impulse = new Impulse({
      log: (s) => this.log(s),
      llm: this.llm,
      actions: this.actions,
      // 【UNHUMAN-SCAN #4】刚说出口的计划（60 秒内有效）。
      // impulse.maybe() 读到它就把走神概率打 1/4 —— 不硬拦，只是别 2 秒就翻案。
      // 懒取值：构造 Impluse 时 talk 可能还没建好。
      intention: () => (this.talk && this.talk.recentIntention ? this.talk.recentIntention() : null)
    })

    // 【被注视】显式接线，不再只靠 spontaneous.scanPeople 顺带喂。
    // 一个实例、两个入口：main 每轮 tick 喂一次，scanPeople 也调 observe（内部 900ms 节流）。
    this.audience = new Audience({
      log: (s) => this.log(s),
      busy: () => this.busy,
      familiarOf: (n) => {
        try { return this.mem && this.mem.people && this.mem.people[n] ? (this.mem.people[n].talkCount || 0) >= 3 : false } catch (e) { return false }
      },
      ignore: (n) => {
        try { return this.spont && this.spont._looksLikeBot ? this.spont._looksLikeBot(n) : false } catch (e) { return false }
      }
    })
    // attach 立刻装好 bot.dig 的节奏包装：不用等第一次扫人，
    // 否则"开局就被盯着挖"的那几格节奏是没变化的。
    this.audience.attach(bot)

    this.spont = new spontaneous.Spontaneity({
      log: (s) => this.log(s),
      busy: () => this.busy,
      watch: this.audience          // 共用同一个实例（别各扫各的）
    })

    // 【能被邀请】玩家说"跟我来/过来"就跟着走。
    // 只加状态，不动任务收尾：跟随期间主循环靠 invite.active 挡住"开新任务"。
    this.invite = new Invite({
      log: (s) => this.log(s),
      speak: (situation, opts) => this.talk.speak(situation, opts),
      isBotName: (n) => {
        try { return this.spont && this.spont._looksLikeBot ? this.spont._looksLikeBot(n) : false } catch (e) { return false }
      },
      busy: () => this.busy,
      progress: () => {
        // 手上这件活干到几成（0~1）。没这个口子，invite 就永远当"不忙"，
        // "等我把这块弄完就来"那条分支永远不触发。
        // goals.status() 在没目标时返回 { has:false }，没有 progress 字段 ->
        // Number(undefined) = NaN -> _progress() 自己判 isFinite 后返回 0，
        // 也就是"没在忙大事"一律答应。这条兜底是有意的，别改成 throwing。
        try {
          const st = this.goals && this.goals.status ? this.goals.status() : null
          return st ? (Number(st.progress) || 0) : 0
        } catch (e) { return 0 }
      }
    })
    this.invite.attach(bot)
    this.lastInventory = this.snapshotInventory()

    // ===== 「这一次上线」=====
    // 进门先扫一眼家（东西还在不在、墙有没有被拆），再定今天干什么。
    // 只动连接钩子这一层：不碰任务收尾判据，也不改 tick 的决策顺序。
    await this.beginSession()

    // 上线：如果有人在，让他自己决定说不说、说什么
    const last = this.mem.lastSummary()
    setTimeout(async () => {
      const names = Object.keys(bot.players).filter(n => n !== bot.username)
      if (!names.length) return
      const situation = online.sessionsBefore > 0
        ? `你刚上线，服务器里 ${names.join('、')} 在。上次下线前你在：${last ? last.text : '（记不清了）'}。`
        : `你刚进服务器，${names.join('、')} 已经在里面了。`
      await this.talk.speak(situation, { chance: 0.65, maxLen: 25, people: names })
    }, 4000 + Math.random() * 4000)

    this.loop().catch(e => this.log('loop crash ' + e.message))
  }

  /**
   * 「这一次上线」的接线。
   *
   * 上下文全部用 getter —— 断线重连后 this.bot / this.actions 会被换成新的，
   * 把旧对象钉死在里面，第二次上线读到的就是上一次的尸体。
   *
   * 会话自己负责三件事（见 src/session.js）：
   *   1. 上线结算：跟离线前的 snapshot 比，箱子少了什么 / 墙被拆没
   *   2. 定方向：按家里的存货和上一趟的死活决定今天干什么（不走 goals 菜单）
   *   3. 收工：活干够了就 todayDone -> 回家歇着 -> 歇够算新的一天
   */
  async beginSession () {
    const self = this
    if (!this.session) {
      this.session = new Session({
        dataDir: DATA,
        cfg: this.cfg,
        log: (s) => this.log(s),
        get bot () { return self.bot },
        get mem () { return self.mem },
        get home () { return self.home },
        get actions () { return self.actions },
        get goals () { return self.goals },
        get spont () { return self.spont },
        // 收工要一条 rank 80 的动作线（见 src/actionlock.js）：能压过 task，
        // 压不过 survive —— 被追的时候不收工。
        get lock () { return self.lock },
        get clock () { return self.mem ? self.mem.clock : null },
        isBusy: () => this.busy,
        status: () => this.statusWithUnderground(),
        taskDesc: () => this.taskDesc,
        snapshotInv: () => this.snapshotInventory(),
        // 走主循环已有的 pendingTask 通道（跟"答应了别人要干的事"同一条路），
        // 不去改 tick 里"先自救、再躲夜、再问自己想干嘛"的顺序。
        setTask: (text) => { this.pendingTask = { text, since: Date.now(), done: false } }
      })
    }
    try {
      await this.session.begin()
    } catch (e) {
      this.log('[session] 上线结算出错: ' + e.message)
    }
  }

  startClock () {
    if (this.clockTimer) clearInterval(this.clockTimer)
    this.clockTimer = setInterval(() => {
      try { this.mem.tick(1) } catch (e) {}
    }, 1000)

    // 心跳：每 30 秒打一行，方便看出是不是卡死了
    if (this._heartbeat) clearInterval(this._heartbeat)
    this._heartbeat = setInterval(() => {
      const b = this.bot
      if (!b || !b.entity) {
        this.log('[hb] 不在游戏里（' + (b ? 'entity 空' : '没连接') + '）')
        return
      }
      const p = b.entity.position
      const st = this.actions ? this.actions.status() : null
      const idle = this._taskProgress ? Math.round((Date.now() - this._taskProgress.at) / 1000) : 0
      const inv = st ? Object.keys(st.inventory).length : 0
      // 收工状态直接从 session 读（原来是 `this._sessionResting`，只写不读的死标记，已删）
      const sess = this.session ? this.session.status() : null
      const sessText = sess
        ? (sess.phase === 'resting'
            ? `｜收工中(第${sess.day}天,还剩${Math.max(0, Math.ceil(sess.restLeftMs / 60000))}分钟)`
            : `｜今天第${sess.day}趟`)
        : ''
      this.log(`[hb] ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)} 血${st ? st.health : '?'} 饿${st ? st.food : '?'} 背包${inv}种 ${this.busy ? '忙:' + this.taskDesc + (idle > 20 ? `（${idle}秒没动）` : '') : '空闲'}｜锁:${this.lock.describe()}${sessText} 心情:${this.mood ? this.mood.state() : '?'}`)
    }, 30000)
  }

  // ==================== 下线 / 重连 ====================

  /**
   * 断线统一收尾。`onEnd` / `kicked` / `error` 三条路径共用。
   *
   * 【为什么非要有这个】
   * 断线前的一堆状态全都**引用了外部现实**（哪个人、哪个动作线、哪句话说到一半），
   * 重连之后那个现实已经不存在了。不清的话：
   *   · 锁还挂着 → 主循环看到 busy 就 return → **永远开不了新任务**（最重的一条）
   *   · `will.current` / `pendingTask` 还挂着 → 重连后继续干一件已经没意义的事
   *   · 闸门时间戳还在 → 重连后第一句正常的话被拦（sayWindow 是 20 秒，比 15 秒重连长）
   *   · 待办队列里还排着断线前的人和事 → 重连后蹦出一句「那个 XJJ 打我」——真人不会这么说
   *
   * 【分四类，按"引用了什么"分，不是按字段清单】
   *   ① 限速/时间   → 清零
   *   ② 待办/承诺   → 清空
   *   ③ 占用/锁     → 强制释放 + 记日志
   *   ④ 目标/进度   → **只标记 interrupted，绝不记 fail**
   *
   * ④ 是硬约束：断线不是"他没做成事"。记了 fail，goals 会以为这个阶段不行、
   * 技能库会"越失败越窄"，一次网络抖动就被当成能力问题。
   * 实现方式是 `this._interrupted` —— `reportTaskResult` 看到它就直接返回，
   * 不碰 goals 的 attempts/fails。
   */
  _teardown (reason) {
    // 三条路径会互相触发（kicked -> end，error -> end），只做一次。
    if (this._tornDown) return false
    this._tornDown = true
    const why = String(reason || '断线')

    // ④ 先立标记：在飞的任务接下来无论走成功/失败/异常哪条路，都不算数
    this._interrupted = true

    // ---- ③ 占用 / 锁（最容易漏、后果最重）----
    try {
      const held = (this.lock && this.lock.holders) ? this.lock.holders().map(h => (h && h.reason) || h) : []
      if (held.length) this.log(`[teardown] 释放锁：${held.join(' / ')}（${why}）`)
      if (this.lock) this.lock.forceReleaseAll(why)
    } catch (e) { this.log('[teardown] 清锁出错: ' + e.message) }
    try {
      if (this.actions) { this.actions.cancel = false; this.actions.stop() }
    } catch (e) {}
    if (this._taskTimer) { clearTimeout(this._taskTimer); this._taskTimer = null }
    this._taskProgress = null
    this._taskStartAt = null
    this._taskStartPos = null
    this._taskStartInv = null
    this._taskStartWorld = null
    this._taskStartHealth = null
    this._taskStartFood = null
    this._taskStartHeld = null

    // ---- ② 待办 / 承诺 ----
    if (this.will) this.will.current = null
    this.pendingTask = null
    try { if (this.spont) this.spont.pendingEvents = [] } catch (e) {}
    try {
      // invite 的 attach() 重连时**会**清这两个，但「断线到重连」这十几秒里它们还挂着；
      // 而且 stop() 在没跟人时直接 return、清不到。所以这里先清。
      if (this.invite) {
        this.invite._pendingFollow = null
        this.invite._pendingRecover = null
      }
    } catch (e) {}
    try { if (this.invite) this.invite.stop(why, { quiet: true }) } catch (e) {}
    try { if (this.talk && this.talk.cancelPendingAck) this.talk.cancelPendingAck(why) } catch (e) {}

    // ---- ① 限速 / 时间 ----
    try {
      const T = this.talk
      if (T) {
        T.lastSayAt = 0
        T.lastSpokeAt = 0
        T.sayWindow = []
        if (T.repliedMsgIds && T.repliedMsgIds.clear) T.repliedMsgIds.clear()
      }
      // 进程级闸门在 talk.js 的模块作用域里，但它是导出的（module.exports.GLOBAL_SAY）。
      // 不清它的话，同进程多实例会把上一局的说话记录算到这一局头上。
      const GS = Talk.GLOBAL_SAY
      if (GS) { GS.lastAt = 0; GS.window.length = 0 }
    } catch (e) { this.log('[teardown] 清闸门出错: ' + e.message) }
    this._foodCooldownUntil = 0
    this._lowHpAt = 0
    this._lastHeadHomeAt = 0
    this._lastGoalObserveAt = 0
    this._lastLateNightAt = 0
    this._nightAlerted = false
    this._lastWrapUpAt = 0
    this._lastDangerAt = 0
    this._lastDangerKey = ''
    this._lastSelfChangeAt = 0
    this._lastInnerTick = 0
    this._friendHurtAt = 0
    this._restingLoggedAt = 0
    this._painLogAt = 0
    this._lastHealth = null
    this._lastDamage = null
    this._deathMsgs = []
    this._lastProof = null

    // ---- ④ 目标/进度：只确认，不动 ----
    // 这里**故意不碰** goals 的 attempts/fails/stage，也不调 reportTaskResult。
    // 断线不是失败，标记已经由 `this._interrupted` 立好了。
    this.log(`[teardown] 断线收尾完成（${why}）：锁已释放、待办已清、闸门已归零`)
    return true
  }

  onEnd (reason) {
    this.log('断开: ' + reason)
    // 这一趟到此为止：先结算，再拆上下文。
    // 必须在 home.detach / mem.goOffline 之前 —— 那之后背包和坐标都读不到了。
    // 不 await：断线路径不能等慢操作（里面自己会异步存盘）。
    if (this.session) {
      try { this.session.end('断开:' + reason) } catch (e) { this.log('[session] 下线结算出错: ' + e.message) }
    }
    if (this.reflex) this.reflex.stop()
    if (this.selfState) this.selfState.stop()
    // 家有个 1.5 秒的记路定时器，不解绑的话重连后会有两个在跑
    if (this.home) { try { this.home.detach() } catch (e) {} this.home = null }
    if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = null }
    try { this.mem.goOffline() } catch (e) {}

    // 【断线收尾】必须在 session.end / home.detach / mem.goOffline 之后：
    // 前面那几步还要读背包和坐标，收尾会把这些上下文拆掉。
    try { this._teardown('end:' + reason) } catch (e) { this.log('[teardown] ' + e.message) }

    if (!this.running) return
    const d = (this.cfg.behavior.reconnectDelaySeconds || 15) * 1000
    this.log(`${d / 1000} 秒后重连`)
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => { if (this.running) this.connect() }, d)
  }

  // ==================== 动作线仲裁 ====================
  //
  // 这一节只做两件事：**发中断信号**和**换动作线**。
  //
  // 存在理由：`busy` 是个布尔，表达不了"两条线同时占着"。任务收尾无条件 busy=false，
  // 把回家的忙状态误清，主循环立刻起新任务，两边抢 pathfinder ——
  // 实测「107 → 105 → 107」原地打转。当时的修法是加 `if (!this._homing)` 例外，
  // 再加 follow / session 就是四方抢，bug 会精确复现。
  //
  // 现在所有权都在 this.lock 里（见 src/actionlock.js），legacy busy=false 只清 __legacy__。

  /**
   * 唯一允许写 `actions.cancel = true` 的地方。
   *
   * stall / 硬超时 / 自救 / 死亡 / 以后新增的动作线，一律从这里（或 interruptCurrent）走。
   * 守住这一条，`cancel` 就不会出现"谁都能置位、谁都能清掉"的四方抢。
   */
  _signalCancel (why) {
    if (!this.actions) return false
    // 已经置位就不重复打日志（tick/超时/stall 可能同时触发）
    if (this.actions.cancel) return false
    this.actions.cancel = true
    this.log(`[lock] 中断信号 <- ${why || '未说明'}（持有：${this.lock.describe()}）`)
    return true
  }

  /**
   * 换动作线：先拿新的，再打断旧的，等旧的自己放手，超时才夺锁。
   *
   * 三种写错法对应三种后果：
   *   release(from) → acquire(to)   中间有窗口，主循环看到 busy=false 就起新任务 → 107
   *   release(from) 但不 cancel     旧动作还在跑，新动作已经开始 → 两条线抢 pathfinder
   *   cancel 但没人 release         永久卡死（最严重，只能等 watchdog）
   *
   * 所以顺序只有这一种，**写进这里，外面不许手写**：
   *   1. acquire(to)        —— 先保证任何时刻至少一方持有
   *   2. _signalCancel()    —— 打断在跑的动作
   *   3. 等 from 自己 release（它的 finally 会做），最多 timeoutMs
   *   4. 超时 → forceRelease(from) + 打日志
   *   5. 只有 !lock.busy 才复位 cancel —— 否则会清掉别人的中断信号
   *
   * 调用方只负责 `finally { this.lock.release(to) }`，永远不碰 actions.cancel。
   *
   * @returns {Promise<boolean>} 新线有没有成功上位（rank 抢不过时 false，什么都没动）
   */
  async interruptCurrent ({ from, to, why = '', timeoutMs = 8000, step = 50 } = {}) {
    if (!to) {
      this.log('[lock] interruptCurrent 缺少 to，忽略')
      return false
    }
    const got = this.lock.acquire(to, why || `interruptCurrent ${from || '空线'} -> ${to}`)
    if (!got) {
      this.log(`[lock] interruptCurrent 上不了位：${to}（rank ${this.lock.rankOf(to)}）抢不过 ${this.lock.describe()}，保持原动作线`)
      return false
    }
    this._signalCancel(`${from || '空线'} -> ${to}${why ? '：' + why : ''}`)
    if (from && from !== to) {
      const t0 = Date.now()
      while (this.lock.isHolding(from) && Date.now() - t0 < timeoutMs) await sleep(step)
      if (this.lock.isHolding(from)) {
        this.log(`[lock] ${from} 超时未释放 ${((Date.now() - t0) / 1000).toFixed(1)}s，强制夺走（${this.lock.describe()}）`)
        this.lock.forceRelease(from, 'timeout')
      }
    }
    // 只有真的没人占着了才复位：否则会把别人（home/follow/session）的中断信号清掉
    if (this.actions && !this.lock.busy) this.actions.cancel = false
    return true
  }

  // ==================== 痛觉 ====================

  /**
   * 挨了一下之后：血到线以下就**真的停手**，不是提示词里写一句。
   *
   * 【BLIND-TEST L547 / L659，裁判原话】
   *   `第3层挖石出错: 报错：快淹死了`          → 继续挖到第 12 层
   *   `求救：血 6，紧急保命（血太少）`        → 边喊保命边继续挖矿直到淹死
   *
   * 查下来不是 reflex.sos() 没触发 —— 它触发了，也游了一下、也喊了，
   * 但**在跑的挖掘任务是另一条线**：只要 `actions.cancel` 不被置位，
   * 它的 dig 循环就一层层往下走，直到血归零。血越低越"看不见"。
   *
   * 真人这里不需要调度器批准：疼了就停。所以：
   *   血 <= STOP(6)  -> 直接打断在跑的动作线（_signalCancel），清寻路，交给 reflex 保命
   *   血 <= WARN(10) -> 推进事件队列，让他下一轮开口/知道自己在掉血
   * 打断信号是全局的，任务代码里任何一个 await 都会抛「任务被中断」，
   * 于是任务当场结束，主循环回到 checkSurvival()，走 lowhp 自救。
   */
  onPain (hp, causeText) {
    const h = Number(hp)
    if (!isFinite(h)) return
    const now = Date.now()
    const why = causeText || '受伤'
    const WARN = 10
    const STOP = 6

    // 【按威胁类型决定停不停手，不只看血量】
    // 血 7~10 继续干活是合理的（真人也会），但**正在淹死/在岩浆里**不是血量的
    // 问题，是下一口就没了的问题 —— 这个档位也必须停。
    const lethalKind = this._lastDamage && now - this._lastDamage.at < 5000
      ? String(this._lastDamage.kind || '')
      : ''
    const LETHAL = lethalKind === 'drown' || lethalKind === 'lava' ||
      lethalKind === 'on_fire' || lethalKind === 'in_fire' ||
      lethalKind === 'in_wall' || lethalKind === 'cramming' ||
      lethalKind === 'suffocate' || lethalKind === 'out_of_world'
    const stopLine = LETHAL ? WARN : STOP

    // 血不高就推一条事件（20 秒最多一条，别刷屏）
    if (h <= WARN && this.events && now - (this._lowHpAt || 0) > 20000) {
      this._lowHpAt = now
      this.events.push('health_low', { health: h, cause: why },
        `${why}，血只剩 ${Math.round(h)}${h <= stopLine ? ' —— 撑不住了' : '，得小心点'}`)
    }

    if (h > stopLine) return

    // 停手。两件事都得做：清寻路（否则 pathfinder 还在走）+ 打断动作线（否则 dig 循环还在挖）
    this.painUntil = now + 60000
    try { this.bot.pathfinder.setGoal(null) } catch (e) {}
    const interrupted = this._signalCancel(`受伤 ${Math.round(h)}（${why}）`)

    // 30 秒最多一条日志：挨打是连续的（溺水一次推好几包），别刷屏
    if (now - (this._painLogAt || 0) > 30000) {
      this._painLogAt = now
      const whyStop = LETHAL ? `${lethalKind === 'drown' ? '还在水里' : '还在危险环境里'}，先离开再干活` : '疼'
      this.log(`[pain] 血 ${Math.round(h)}（${why}）—— ${whyStop}，停手${interrupted ? '（已打断当前任务）' : '（早就打断了）'}`)
    }

    // 保命动作照旧走反射层（游上去/跑/吃），urgent 不吃 1.2 秒节流
    if (this.reflex) {
      let kind = 'lowhp'
      try {
        if (this._lastDamage && now - this._lastDamage.at < 3000) kind = this._lastDamage.kind || 'lowhp'
        // 被打（近战/远程/玩家/爆炸/药水）对反射层来说都只是"有人在弄你"，
        // 具体怎么应对由它自己按血量分档决定。
        if (kind === 'mob' || kind === 'player' || /^(mob_attack|mob_attack_no_aggro|mob_projectile|arrow|player_attack|player_explosion|spear|mace_smash|thrown|trident|fireball|fireworks|wind_charge|sonic_boom|sting|spit|explosion|magic|indirect_magic|wither|wither_skull|thorns)$/.test(String(kind))) kind = 'lowhp'
      } catch (e) {}
      try { this.reflex.sos(kind, { urgent: true }) } catch (e) {}
    }
  }

  /**
   * 这一回到底是怎么死的。
   *
   * 【BLIND-TEST L1075】`死了：不知道怎么回事`
   *
   * 原来的唯一来源是 lastDeathMsg（服务端的死亡消息），而那条路有两个断点：
   *   1) 只认英文关键词，服务端说中文就整条丢掉
   *   2) 死亡包和死亡消息谁先到不保证，先到就先读了 null
   * 于是记忆里全是"不知道怎么回事"—— 死因写不进去，「上次在这片被僵尸弄死」
   * 这类因果记忆永远长不出来，cost 结算也算不准。
   *
   * 现在按可靠性排序：
   *   1) 死亡前 20 秒内的最后一次 damage_event（服务端必发，带类型/来源）
   *   2) 死亡前 15 秒内的死亡消息（中英文都认）
   *   3) 饿死（food=0）
   *   4) 真不知道
   */
  resolveDeathCause () {
    const now = Date.now()

    if (this._lastDamage && now - this._lastDamage.at < 20000) {
      return {
        text: this._lastDamage.deathText || this._lastDamage.text,
        kind: this._lastDamage.kind || 'unknown',
        by: this._lastDamage.by || null,
        sourceTypeId: this._lastDamage.sourceTypeId,
        src: 'damage_event'
      }
    }

    const msgs = (this._deathMsgs || []).filter(m => now - m.at < 15000)
    if (msgs.length) {
      const m = msgs[msgs.length - 1]
      return { text: m.text, kind: 'death_msg', by: null, src: 'chat' }
    }
    if (this.lastDeathMsg) {
      return { text: this.lastDeathMsg, kind: 'death_msg', by: null, src: 'chat' }
    }

    try {
      if (this.bot && this.bot.food === 0) {
        return { text: '饿死了', kind: 'starve', by: null, src: 'food' }
      }
    } catch (e) {}

    return { text: '不知道怎么回事', kind: 'unknown', by: null, src: 'none' }
  }

  // ==================== 死亡 ====================

  onDeath () {
    this.deathCount++
    this.deathsSinceSafe++
    this._deathTimes = (this._deathTimes || [])
    this._deathTimes.push(Date.now())

    // 【L1075】死因不再靠"猜"：优先用最后一次伤害，其次死亡消息
    const cause = this.resolveDeathCause()
    const how = cause.text
    // 判据没命中时把 registry id 一起打出来：光有「受了点伤」三个字，
    // 分不清是摔死、骷髅箭还是窒息 —— 而这三样的应对完全不同。
    const rawId = (cause.kind === 'unknown' && cause.sourceTypeId != null) ? ` / sourceTypeId=${cause.sourceTypeId}` : ''
    this.log(`[death] ${how}（来源：${cause.src}${cause.kind && cause.kind !== 'unknown' ? ' / ' + cause.kind : ''}${rawId}）`)
    if (this.events) this.events.push('death', { how, kind: cause.kind, by: cause.by }, `你死了（${how}）`)

    // 代价层：记下这次死在哪、被什么弄死的 —— 接下来一阵子别往那种地方钻
    // （岩浆死 -> 25 分钟不选深层；摔死 -> 先别跑远；被怪弄死 -> 别一个人往黑地方去）
    try {
      const cp = this.bot && this.bot.entity ? this.bot.entity.position : null
      if (this.cost) this.cost.onDeath({ how, pos: cp })
    } catch (e) {}

    // 记住这次死 —— 带上死因和坐标。
    // 只有"死了"这一句是长不出因果记忆的；「上次在这片被僵尸弄死」需要地点 + 原因。
    let where = null
    try {
      const p = this.bot && this.bot.entity && this.bot.entity.position
      if (p) where = `${Math.round(p.x)},${Math.round(p.z)}`
    } catch (e) {}
    this.mem.add({
      // 地点只放 where 字段 —— 记忆层会自己拼成「55,-2那儿死了一回（<怎么死的>）」，
      // 再在正文里写一遍坐标会变成「…（快淹死了（在 55,-2 附近））」这种叠字。
      text: '死了：' + how,
      kind: 'event',
      where,
      emotion: 0.65,
      importance: 0.5
    })

    // 死亡吐槽（连续死会说得更重）
    if (this.spont) {
      const recentDeaths = (this._deathTimes || []).filter(t => Date.now() - t < 300000).length
      const ev = recentDeaths >= 3
        ? spontaneous.onComplain('diedAgain', how)
        : spontaneous.onComplain('died', how)
      if (ev) this.spont.push(ev)
    }
    this.lastDeathMsg = null
    // 死因用完就作废，别让下一回死继续复用上一次的伤害记录
    this._lastDamage = null
    this._deathMsgs = []

    // 死一次，所有动作线一起作废。
    // 只清 busy/_homing 会漏掉后来加的 follow/session —— 漏掉的那条就永久卡死，
    // 主循环的 `if (this.busy) return` 会一直把 tick 挡在门外。这是安全阀，必须整把锁清空。
    this.lock.forceReleaseAll('死亡')
    this.taskDesc = ''
    this.seekingFood = false
    this.sheltered = false
    if (this.home) { try { this.home.stop() } catch (e) {} }
    if (this.actions) { this._signalCancel('死亡'); this.actions.stop() }
    if (this.will) this.will.finish()
    if (this.mood) this.mood.onEvent('death', 1)
  }

  async onRespawn () {
    this.log('复活了')
    if (this.reflex) this.reflex.reset()
    // 复活 = 重开一局：可能没经过 onDeath（比如 /spawn），所有动作线一起作废。
    // 只清 busy/_homing 会漏掉 follow/session，漏掉的那条就永久卡住主循环。
    this.lock.forceReleaseAll('复活')
    if (this.actions) { this.actions.cancel = false; this.actions.stop() }
    setTimeout(() => this.afterRespawn(), 3000)
  }

  async afterRespawn () {
    const bot = this.bot
    if (!bot || !bot.entity) return
    this.lastDamageKind = null

    // 短时间内连续死 -> 出生点不安全，得走远
    const now = Date.now()
    this._deathTimes = (this._deathTimes || []).filter(t => now - t < 180000)
    if (this._deathTimes.length >= 2) {
      this.log('[respawn] 这地方反复死，走远点重生')
      try {
        await this.actions.wander(60)
        await this.actions.ensureChunks(4000)
      } catch (e) {}
      this._deathTimes = []
    }

    try {
      // 水里往上浮
      if (bot.entity.isInWater || (bot.oxygenLevel !== undefined && bot.oxygenLevel < 20)) {
        this.log('在水里，往上游')
        const dirs = ['forward', 'left', 'right']
        bot.setControlState('jump', true)
        for (let i = 0; i < 30; i++) {
          if (!bot.entity.isInWater) break
          bot.setControlState(dirs[Math.floor(i / 10) % 3], true)
          await sleep(250)
        }
        for (const k of ['jump', 'forward', 'left', 'right']) bot.setControlState(k, false)
      }

      await this.actions.bestWeapon().catch(() => {})
      await this.actions.autoArmor().catch(() => {})

      const near = this.reflex.nearestHostile(12)
      if (near) {
        this.log('身边有怪，跑')
        this.reflex.flee(near)
        await sleep(4000)
      }

      const p = bot.entity.position
      this.mem.place('出生点', p, '复活的地方')

      for (let i = 0; i < 40 && bot.health < 16; i++) {
        if (bot.food <= 18 && this.actions.hasFood()) {
          await this.actions.eat().catch(() => {})
        }
        const h = this.reflex.nearestHostile(8)
        if (h) { this.reflex.flee(h); await sleep(2000) }
        await sleep(1000)
      }
      this.log('复活后状态：血 ' + Math.round(bot.health) + ' 饿 ' + Math.round(bot.food))
    } catch (e) {
      this.log('afterRespawn err ' + e.message)
    }

    // 死了回出生点 —— 出生点周围的资源早挖光了。
    // 走远了就自己走回去：这是"每次上线等于从零开始"的解法。
    await this.tryGoHomeAfterRespawn()
  }

  /**
   * 主循环里每轮问一次：现在该不该先回家一趟？
   *
   * 跟 tryGoHomeAfterRespawn 的区别：
   *   · 那个只在死后触发一次，不死就永远不回家
   *   · 这个在活着干活时也判断 —— 越挖越深、背包满了、镐子没了都算理由
   *
   * 判断全交给 home.shouldHeadHome()（距离/高差/背包/工具综合算），
   * main.js 只负责"真的走一趟"和防重入。
   *
   * @returns {boolean} 有没有真的去回家（去了就让主循环本轮到此为止）
   */
  tryHeadHome () {
    if (!this.home || !this.bot || !this.bot.entity) return false
    if (this.busy) return false
    // 别每 4 秒问一次就走 —— 刚放弃过一次，给它一点缓冲
    if (Date.now() - (this._lastHeadHomeAt || 0) < 120000) return false

    let head = null
    try {
      const st = this.actions ? this.actions.status() : null
      head = this.home.shouldHeadHome(st)
    } catch (e) {
      return false
    }
    if (!head || !head.should) return false

    this._lastHeadHomeAt = Date.now()
    this.log(`[home] 该回家了：${head.why}（代价 ${Math.round(head.cost)}）`)

    // 异步走，不挡主循环（goHome 最长 5 分钟）
    this.walkHomeNow(head.why).catch(() => {})
    return true
  }

  /** 真的走一趟回家。跟 tryGoHomeAfterRespawn 共用同一套防重入。 */
  async walkHomeNow (why) {
    // 只占 home 这一条线。busy 是它的派生读法（getter），不用再手动置位 ——
    // 以前 _homing + busy 两个布尔写同一个事实，谁先谁后都能写出不一致。
    if (!this.lock.acquire(REASON.HOME, `走回家：${why || ''}`)) {
      this.log(`[lock] 回家上不了位（当前 ${this.lock.describe()}）`)
      return false
    }
    this.taskDesc = '走回家'
    try {
      const r = await this.home.goHome({ timeoutMs: 300000 })
      if (r && r.ok) {
        this.log(`[home] 到家了（${r.seconds}s）：${why || ''}`)
        if (this.events) this.events.push('found_something', { home: true }, '你走回家了')
        return true
      }
      this.log(`[home] 没走回去：${(r && r.reason) || '不知道为啥'}`)
      // 【实测 · 2026-11-14 07:51】冷却从错误的时间点算：
      // `tryHeadHome` 里 `_lastHeadHomeAt` 记的是"开始走"的时刻，可这一趟走了 153 秒
      // = 冷却（120 秒）在放弃的瞬间就已经过期 -> 1 秒后又 acquire home ->
      // 日志实录 `[07:51:02] release home（持了 153.0s）` → `[07:51:03] acquire home`。
      // 结果：home 几乎永久持锁，busy 恒真，主循环连 tick 的临界判断都跑不到
      // （`if (this.busy) return` 在 `_dropPendingIfCritical()` 之前），
      // 血低也不去找吃的。这是吞吐上最大的一条。
      // 改：放弃时重新起算，于是每趟失败后有 120 秒 busy=false 的窗口。
      this._lastHeadHomeAt = Date.now()
      return false
    } catch (e) {
      this.log('[home] 回家出错: ' + e.message)
      // 出错也算一次失败的尝试，同样要起算冷却 —— 否则异常路径也会立刻重试
      this._lastHeadHomeAt = Date.now()
      return false
    } finally {
      // 只放自己这一条。用 release 不用 forceRelease：
      // 锁被死亡/看门狗整把清过时它返回 false，不会误清别人的锁。
      if (this.lock.isHolding(REASON.HOME)) this.lock.release(REASON.HOME)
      if (!this.lock.busy) this.taskDesc = ''
    }
  }

  /**
   * 复活后如果离得太远，自己走回家。
   *
   * 96 格是"再挖下去也是荒的"的经验线：
   * 出生点附近的东西早被他自己挖干净了，回家才有存货和工具。
   *
   * 不能放在 onRespawn 里直接 await —— 那会把 3 秒后的 afterRespawn
   * 整段拖住，而回家最坏要 150 秒。
   */
  async tryGoHomeAfterRespawn () {
    if (!this.home || !this.bot || !this.bot.entity) return
    let far = false
    let dist = null
    let cost = null
    try {
      dist = this.home.hDistanceFromHome()
      cost = this.home.walkCostHome()
      // 用加权代价（垂直×3）判，不是纯水平 ——
      // 旧实现按水平算，实测「水平 82 / 垂直 46」被判成不远，永远不回家
      far = this.home.isFarFromHome(96)
    } catch (e) {
      return
    }
    if (!far) {
      if (Number.isFinite(dist)) {
        this.log(`[home] 复活点离家 水平${Math.round(dist)} 垂直${Math.round(this.home.vDistanceFromHome())} 代价${Math.round(cost)}，不用回去`)
      }
      return
    }

    // onRespawn 把 busy 清成 false 之后，主循环有 3 秒（afterRespawn 的延迟）
    // 去起一个新任务。这时候再去回家就是两个人抢同一个 pathfinder ——
    // 实测表现为「离家 164.8 格 → 197.5 格」，越走越远。
    if (this.busy) {
      this.log('[home] 手上有活，这趟先不回家')
      return
    }
    if (this.lock.isHolding(REASON.HOME)) return

    this.log(`[home] 离家 ${Math.round(dist)} 格，走回去`)

    // 【实测踩到第二个坑】只设 busy 不够。
    // 回来途中有一个"早就起跑"的任务走到 finally，它无条件把 busy 拍成 false，
    // 主循环于是又起新任务，两边抢 pathfinder。实测日志：
    //     06:18:14 [home] 离家 106 格，走回去
    //     06:18:16 <<< 完成（5s）：…            ← 老任务收尾，把 busy 清了
    //     06:18:27 >>> 开始：备料…              ← 主循环起了新任务
    //     06:18:33 [home] 第 1 段没往前走（107 → 105）
    // 所以再加一个"回家专用"的归属位 _homing，它只有这里写，
    // 主循环和 reflex 都认它 —— 谁也别想趁 busy 被误清时插进来。
    // 这一整套现在收在 walkHomeNow() 里，复活回家和主动回家共用。
    await this.walkHomeNow(`复活点离家 ${Math.round(dist)} 格`)
  }

  /** 急件来了：立刻有反应 */
  onUrgentEvent (ev) {
    this.log('[urgent] ' + ev.what)
    switch (ev.type) {
      case 'chat_me':
        // 有人叫我：如果在忙，记下来等会儿回；不忙就直接回
        break
      case 'damage':
      case 'attack_by_player':
        // 反射层已经在处理了
        break
      case 'danger':
        // 反射层处理
        break
      case 'death':
        break
      case 'gift':
        this.mood && this.mood.onEvent('gift', 1)
        break
      case 'demand':
        break
    }
  }

  // ==================== 反射事件 ====================

  onReflexEvent (kind, data) {
    if (!this.talk) return
    if (this.mood && kind === 'hurt_repeat') this.mood.onEvent('hurt', 1)
    if (kind === 'hurt_confused') {
      // 头一两次被打：还没搞清状况
      this.talk.speak(
        `${data.by} 打了你一下，这是第 ${data.times} 次。你还不太确定他是闹着玩还是故意。`,
        { chance: 0.5, maxLen: 20, people: [data.by] }
      ).catch(() => {})
    } else if (kind === 'hurt_repeat') {
      const hs = this.mem.hitStats(data.by)
      if (hs.times >= 3) {
        this.mem.note(data.by, `老打我（第${hs.times}次）`)
        this.talk.speak(
          `${data.by} 又打你了，这已经是第 ${hs.times} 次。之前他没道过歉。`,
          { chance: 0.7, maxLen: 25, people: [data.by] }
        ).catch(() => {})
      }
    }
  }

  // ==================== 主循环 ====================

  async loop () {
    while (this.running && this.bot && this.bot.entity) {
      // 兜底：某条动作线卡太久（异步链没走到 finally）就只清那一条，
      // 否则主循环的 `if (this.busy) return` 会永远把它挡在门外 —— 人站着不动还查不出原因。
      //
      // 阈值按线分：
      //   task    → 任务超时 + 30 秒（和原来一致）
      //   其它线  → 15 分钟硬上限（session 收工、follow 都可能跑几分钟，但不该这么久）
      //   home / survive 不在看门狗里管：home 自己有分段超时（最长 10 分钟），
      //   survive 每次只跑几秒。强行清它们只会让主循环插进来抢寻路。
      const taskCap = (this.cfg.behavior.taskTimeoutSeconds || 420) * 1000 + 30000
      const stuck = this.lock.holders().filter(h => {
        if (h.reason === REASON.HOME || h.reason === REASON.SURVIVE) return false
        const cap = h.reason === REASON.TASK ? taskCap : 15 * 60 * 1000
        return Date.now() - h.since > cap
      })
      if (stuck.length) {
        this.log(`[stall] 动作线卡太久：${stuck.map(h => `${h.reason} ${Math.round(h.secs)}s@${h.why}`).join('，')}，强制放开`)
        for (const h of stuck) this.lock.forceRelease(h.reason, '卡太久兜底')
        this.taskDesc = ''
        if (this.actions) this.actions.cancel = false
      }
      try {
        await this.tick()
      } catch (e) {
        this.log('[tick err] ' + (e && e.message))
      }
      await sleep(4000)
    }
    this.log('主循环退出')
  }

  /**
   * 把自我状态里"他自己注意到的变化"转进事件队列。
   *
   * selfstate.js 自己只推了三种（工具没了 / 背包满 / 血骤降），
   * 而工具拿到、换了、快用坏了这三种只写进 changes 数组，没人读。
   * 结果：他"知道了"却从来不会因为这个改变行为。
   *
   * 这里不动 selfstate.js（那是 perception-owner 的交付），
   * 在 main.js 侧把漏掉的三种转发成 inventory_change。
   * 用 lastChangeAt 游标，同一条只转一次。
   */
  pumpSelfChanges () {
    if (!this.selfState || !this.events) return 0
    const list = this.selfState.changes
    if (!Array.isArray(list) || !list.length) return 0

    // 已经由 selfstate 自己推过的三种，别重复
    const OWNED = { tool_broke: 1, inv_full: 1, health_drop: 1 }
    let n = 0
    for (const c of list) {
      if (!c || !c.at) continue
      if (c.at <= (this._lastSelfChangeAt || 0)) continue
      this._lastSelfChangeAt = c.at
      if (OWNED[c.kind]) continue
      try {
        this.events.push('inventory_change', { kind: c.kind }, c.what, {
          cooldown: 8000,
          dedupeKey: 'self:' + c.kind
        })
        n++
      } catch (e) {}
    }
    return n
  }

  /**
   * 长期目标：扫一眼进度。
   *
   * 为什么单独抽出来：tick 每 4 秒一轮，但 observe 是纯同步的状态比对，
   * 每轮都调也没问题；真正贵的 ensure()（要问模型"你想干哪个"）只在
   * 没有目标时走一次，这里不碰。
   *
   * 返回 observe 的结果，调用方想用就用（现在只是记日志）。
   */
  /**
   * 带 underground 字段的状态快照。
   *
   * 【为什么必须有这个】
   * goals.js 的 `surface` 阶段和 `getup` 目标都靠它判"到没到地面"。
   * 不传的话只能按 y 坐标猜，两个方向都会错：
   *   - 山谷 y=52，头顶是天  -> 按 y 判"还在洞里"，白跑一趟 getup
   *   - 山体洞穴 y=70，头顶石头 -> 按 y 判"出来了"，实际还困在山肚子里
   *
   * isUnderground() 看头顶遮挡，两个场景都准。它返回三态（true/false/null），
   * null 表示区块没加载看不清 —— 这时候不传，让 goals 退回 y 估算。
   */
  statusWithUnderground () {
    if (!this.actions) return null
    const st = this.actions.status()
    if (!st) return null
    try {
      const ug = this.actions.isUnderground()
      // null 时不写这个字段，让 goals 知道"这次判断不了"
      if (ug === true || ug === false) st.underground = ug
    } catch (e) {}
    return st
  }

  observeGoals () {
    if (!this.goals) return null
    let res = null
    try {
      const st = this.statusWithUnderground()
      if (!st) return null
      // 30 秒一次就够 —— 进度是按背包/坐标算的，扫太勤没意义
      const now = Date.now()
      if (now - (this._lastGoalObserveAt || 0) < 30000) return null
      this._lastGoalObserveAt = now

      res = this.goals.observe(st)
      if (res && res.goalCompleted) {
        this.log('[goals] 长期目标做完了')
        if (this.spont) this.spont.push(spontaneous.onGoalDone('长期目标', ''))
      } else if (res && res.stageCompleted) {
        const cur = this.goals.current()
        this.log('[goals] 过了一步，下一步：' + (cur ? cur.text : '（没了）'))
      } else if (res && res.abandoned) {
        this.log('[goals] 放弃了这个目标，下一轮会重新想一个')
      }
    } catch (e) {
      this.log('[goals] observe 出错: ' + e.message)
    }
    return res
  }

  /**
   * 保证心里有个长期目标。没有就现在想一个（要问模型，所以是 async）。
   *
   * 调用点只有 tick 里"准备干活之前"那一处 —— 放在最前面会把自救饿死：
   * 一次 LLM 调用要好几秒，血快没了的时候不能等它。
   */
  async ensureGoal () {
    if (!this.goals) return null
    try {
      const st = this.statusWithUnderground()
      return await this.goals.ensure(st)
    } catch (e) {
      this.log('[goals] ensure 出错: ' + e.message)
      return null
    }
  }

  /**
   * 把一次任务的结果回报给长期目标。
   *
   * 为什么单独抽出来：成功/失败/异常三个分支都要调，而且每一处都不能
   * 因为 goals 挂了把主循环带崩 —— 统一在这里吞异常。
   */
  reportTaskResult (ok, text, outText, meta = {}) {
    if (!this.goals) return null
    // 【断线不记失败】`_teardown` 已经把这一局标成 interrupted。
    // 断线不是"他没做成事"：记了 fail，goals 会以为这个阶段不行、技能库会越失败越窄，
    // 一次网络抖动就被当成能力问题。所以这里直接返回，不碰 attempts/fails。
    if (this._interrupted) {
      this.log(`[goals] 这趟被断线打断，不记成败：「${String(text || '').slice(0, 20)}」`)
      return null
    }
    try {
      // 用 statusWithUnderground 而不是 actions.status()：
      // 后者没有 underground 字段，surface 阶段在 onTaskResult 里只能按 y 猜，
      // 而 observeGoals 那条路是带的 —— 同一个阶段两条路判据不一致。
      const st = this.statusWithUnderground()
      // progress 是**硬判据算出来的真实增量**，不是"完成"这两个字的副产品。
      // 以前不带这个字段，goals 那边就只能 `addWork(progress || 1)` ——
      // 于是任何 do/build 阶段，一次"完成"就无条件过。
      const res = this.goals.onTaskResult({ ok: !!ok, text, status: st, progress: meta.progress })
      if (res && res.abandoned) this.log('[goals] 这个阶段反复不成，换条路')
      else if (res && res.goalCompleted) this.log('[goals] 长期目标做完了')
      else if (res && res.stageCompleted) this.log('[goals] 过了一步')
      return res
    } catch (e) {
      this.log('[goals] onTaskResult 出错: ' + e.message)
      return null
    }
  }

  /**
   * 别人挨打（UNHUMAN-SCAN #14）。
   *
   * spontaneous.onFriendInDanger() 实现一直在，但没人调用 ——
   * 触发源里没有"别人受伤"这一类，所以 25 分钟里他一次都没关心过别人。
   *
   * 这里接 mineflayer 的 entityHurt：有玩家掉血就捏一个 social 事件塞进主动层，
   * 由它决定说不说（chance 0.8）。**只说话、不接管移动** ——
   * 帮忙的寻路逻辑属于 reflex/actions，这里不碰。
   *
   * 防刷屏：同一个人 30 秒内只报一次；血量读得到时，大于 12 就不报。
   */
  onEntityHurt (entity) {
    try {
      if (!entity || !entity.username) return          // 怪挨打不管
      const name = String(entity.username)
      if (!name || name === this.bot.username) return  // 自己挨打走 health 那条线
      if (this.bot.entity && entity === this.bot.entity) return

      const now = Date.now()
      this._friendHurtAt = this._friendHurtAt || new Map()
      if (now - (this._friendHurtAt.get(name) || 0) < 30000) return

      const hp = this.peerHealth(entity)
      if (hp != null && hp > 12) return                 // 掉一点血不算危险
      this._friendHurtAt.set(name, now)

      const shown = hp == null ? '?' : Math.round(hp)
      this.log(`[social] ${name} 在挨打（血 ${shown}）→ onFriendInDanger`)
      if (this.spont) {
        const ev = spontaneous.onFriendInDanger(name, hp == null ? '不多' : Math.round(hp))
        if (ev) this.spont.push(ev)
      }
    } catch (e) {
      this.log('[social] entityHurt 处理出错: ' + (e && e.message))
    }
  }

  /**
   * 读一个实体的血量。mineflayer 没有统一的 entity.health，
   * 玩家实体在 metadata[9]（1.20.x 协议：血量 float）。
   * 读不到就返回 null —— 由调用方决定怎么措辞，别硬编一个假数字。
   */
  peerHealth (entity) {
    if (!entity) return null
    if (typeof entity.health === 'number') return entity.health
    try {
      const md = entity.metadata
      const v = md ? md[9] : undefined
      if (typeof v === 'number') return v                       // 数组/对象下标都可能是裸数字
      if (v && typeof v.value === 'number') return v.value      // 有的版本是 {value}
    } catch (e) {}
    return null
  }

  /**
   * 任务之间发多久呆（UNHUMAN-SCAN #16）。
   *
   * 【为什么要有这个】config.json 里一直躺着 `behavior.idleThinkSeconds: 60`，
   * 但全项目没有任何一行代码读它 —— 主循环固定 4 秒一轮，任务之间只睡
   * `3000 + random*9000`。实测任务间隔中位数 10 秒、最短 1 秒，
   * 真人干完一件事至少会愣一会儿、走两步、想一想。
   *
   * 取 idleThinkSeconds 的 10%~50% 作为区间（60 -> 6~30 秒），
   * 上限封 30 秒：再久玩家会以为他掉线了。
   */
  idleThinkMs () {
    const sec = Number(this.cfg && this.cfg.behavior && this.cfg.behavior.idleThinkSeconds)
    const base = Number.isFinite(sec) && sec > 0 ? sec : 60
    const lo = Math.max(3, base * 0.1)
    const hi = Math.max(lo + 1, Math.min(30, base * 0.5))
    return Math.round((lo + Math.random() * (hi - lo)) * 1000)
  }

  /**
   * 发呆：站着看、偶尔转身、偶尔原地跳一下。
   *
   * 不调模型、不占 pathfinder、不置 busy —— 这期间有人说话照样回，
   * 有怪过来立刻收工交给主循环。
   */
  async idleThink () {
    const ms = this.idleThinkMs()
    const t0 = Date.now()
    this.log(`[idle] 发会儿呆（约 ${Math.round(ms / 1000)} 秒）`)
    while (Date.now() - t0 < ms && this.running && this.bot && this.bot.entity) {
      // 有东西摸过来就别演了
      const near = this.reflex ? this.reflex.nearestHostile(10) : null
      if (near) { this.log('[idle] 有东西过来了，先不发了'); break }
      // 东张西望
      if (Math.random() < 0.35) {
        try {
          const ent = this.bot.entity
          const yaw = (ent.yaw || 0) + (Math.random() - 0.5) * Math.PI
          const pitch = -0.15 + Math.random() * 0.35
          if (this.bot.look) await this.bot.look(yaw, pitch)
        } catch (e) {}
      }
      // 无聊蹦一下
      if (Math.random() < 0.12) {
        try {
          this.bot.setControlState('jump', true)
          await sleep(160)
          this.bot.setControlState('jump', false)
        } catch (e) {}
      }
      await sleep(700 + Math.random() * 1300)
    }
    try { this.bot.setControlState('jump', false) } catch (e) {}
  }

  /**
   * 命比手上这件事重要：血低 + 饿低时丢掉 `pendingTask`，把主循环让给找吃的。
   *
   * 【为什么必须有】goals-owner 修了 rest 死锁（bf1d523）之后留了个残余风险：
   *   `goals` 已经算好 food(110) 是第一优先，但主循环里
   *   `if (this.pendingTask) { want = this.pendingTask }` 在 `ensureGoal()` **之前** ——
   *   于是顺序变成：血 7 + 饿 17 → 不休息了 → 先跑「在附近弄点木头」→ 那条不吃东西 → 血继续 7。
   *
   * 【歇着时不清】`pendingTask` 里「歇着/回家/收拾/睡」那几类是 rest 分支的合法输入，
   * 清掉等于把"歇着"也一起取消。
   *
   * @returns {boolean} 当前是不是临界（调用方还要用它决定跳不跳冲动）
   */
  _dropPendingIfCritical () {
    const hp = this.bot && this.bot.health
    const fd = this.bot && this.bot.food
    // 血用 `<= 8`，不是 `< 8`：`reflex.js:56` 的 HP_PANIC = 8 是 `hp <= HP_PANIC -> 跑+吃`。
    // 写成 `< 8` 的话，血正好 8 时 reflex 已经在跑+吃了，主循环却还在派「砍木头」——
    // 两条线打架。8 是"跑+吃"的档，10（WARN）只是"小心点"，所以不对齐 10。
    const critical = (typeof hp === 'number' && hp <= 8) && (typeof fd === 'number' && fd < 18)
    if (!critical) return false

    const resting = !!(this.goals && this.goals.isResting && this.goals.isResting())
    if (resting) {
      if (this.pendingTask) {
        this.log(`[comply] 血 ${Math.round(hp)}、饿 ${Math.round(fd)} 都很低，但正在歇着 —— 不动 pendingTask`)
      }
      return true
    }
    if (!this.pendingTask) return true

    const txt = String(this.pendingTask.text || '')
    this.log(`[comply] 血 ${Math.round(hp)}、饿 ${Math.round(fd)}：先不吃这件「${txt.slice(0, 16)}」，去弄吃的`)
    this.pendingTask = null
    return true
  }

  /**
   * 老口径兜底：**一律借用 talk 里那份正则**，不在 main 里再写一遍。
   *
   * 两份实现必然漂 —— talk 的 `_regexAddressed` 已经是「跟 main.js 原来的口径保持一致」
   * 的版本（`bot.username` + 三个模式），这边再抄一份，改了一边另一边不知道。
   * 只有 talk 还没建好（连接早期）时才用内联那一份。
   */
  _chatFallbackCalled (myName, message) {
    try {
      if (this.talk && typeof this.talk._regexAddressed === 'function') {
        return !!this.talk._regexAddressed(message)
      }
    } catch (e) {}
    const m = String(message || '')
    return (myName && m.includes(myName)) ||
      /^(你|XJJ|小徐|小徐)/.test(m) ||
      /[?？]$/.test(m)
  }

  /**
   * 判「这句话是不是在跟我说」，然后推 `chat_me` / `chat_any`。
   *
   * 抽成方法而不是写在事件回调里：验收要能直接调它拿日志，
   * 否则只能等真服上刚好有人说一句「在哪呢」。
   *
   * @returns {{called:boolean, via:string}}
   */
  async _chatDecideAndPush (username, message) {
    const myName = this.bot ? this.bot.username : ''
    let called = false
    let via = 'regex'
    if (this.talk && typeof this.talk.isAddressedTo === 'function') {
      try {
        const r = await this.talk.isAddressedTo(username, message)
        called = !!(r && r.toMe)
        via = (r && r.via) || 'model'
      } catch (e) {
        // isAddressedTo 自己不会抛（内部全路径 return），这里防的是意外
        called = this._chatFallbackCalled(myName, message)
        via = 'regex(catch)'
        this.log('[chat] 判定抛错，退正则: ' + (e && e.message))
      }
    } else {
      called = this._chatFallbackCalled(myName, message)
      via = 'regex(no-talk)'
    }

    if (this.events) {
      if (called) this.events.push('chat_me', { who: username, message }, `${username} 跟你说：${message}`)
      else this.events.push('chat_any', { who: username, message }, `${username} 说：${message}`)
    }
    return { called, via }
  }

  /**
   * 把一条收到的公屏消息排进 FIFO 链：判定 → 推事件。
   *
   * 【为什么必须排队】判定是异步的（模型最多 5 秒），两条消息连着来时，
   * 后一条的快判定可能比前一条先回来 → 事件批次里的说话顺序就反了。
   * 链保证 push 顺序 == 收到顺序。
   *
   * 【为什么这条链不挡主循环】`bot.on('chat')` 是事件回调，链只是往里挂一个 then，
   * 回调本身立刻返回；tick 是另一个循环，不受影响。
   */
  _chatEnqueue (username, message) {
    this._chatSeq = (this._chatSeq || Promise.resolve())
      .then(() => this._chatDecideAndPush(username, message))
      .catch(e => this.log('chat 判定出错: ' + (e && e.message)))
    return this._chatSeq
  }

  async tick () {
    const bot = this.bot
    if (!bot || !bot.entity) return
    // 0. 长期目标：先扫一眼进度（同步、很便宜，不会挡住自救）
    //    这一步只更新"当前阶段完成到几成"，不跟模型说话。
    this.observeGoals()
    // 0.1 代价层：记走路里程和当前位置 —— 放弃时要算"走了多少路才弄到这点东西"
    try {
      if (this.cost && this.actions) this.cost.observe(this.actions.status())
    } catch (e) {}
    // 0.5 他自己注意到的变化（工具换了/快坏了）进事件队列
    this.pumpSelfChanges()

    // 0. 处理事件队列：攒够了就交给模型看
    if (this.events) {
      this.events.prune()
      const r = this.events.ripe()
      if (r.ripe) {
        const evs = this.events.drain()
        this.log(`[events] 处理 ${evs.length} 条（${r.reason}）`)
        for (const e of evs) this.log('  · ' + e.what)
        // 急件里的"有人叫我"：立刻回应
        // 注意：onChat 已经处理过一遍了，这里只处理"当时在忙没回"的
        const chats = evs.filter(e => e.type === 'chat_me')
        if (chats.length && this.talk && !this.busy) {
          const last = chats[chats.length - 1]
          // 用统一的查重（talk.reply 内部也会再查一次）
          if (!this.talk.hasReplied(last.data.who, last.data.message)) {
            this.talk.reply(last.data.who, last.data.message).catch(() => {})
          }
        }
      }
    }

    // 1. 危险先自救
    const danger = this.checkSurvival()
    if (danger) {
      const now = Date.now()
      const key = danger + ':' + Math.round(bot.health) + ':' + Math.round(bot.food)
      if (this._lastDangerKey !== key || now - (this._lastDangerAt || 0) > 20000) {
        this._lastDangerKey = key
        this._lastDangerAt = now
        this.log('[survive] ' + danger)
      }
      // 【自救时也要能说话】2026-11-14
      //
      // 原来这里直接 doSurvive + return，而 spont.tick 在 1777 行（这一行后面）——
      // 也就是说：**只要进入生存模式，他一句吐槽/社交都说不出来。**
      //
      // 实测：血 3 卡在洞里的那段时间，20 分钟只说了 1 句（还是上线那句），
      // 而 onDeath 明明 push 了 complain:died 事件、队列里也攒着，
      // tick 从来没被调用过。
      //
      // 明天他很可能长期处于生存状态（血低/饿），这条不修就等于"他一直不说话"。
      // complain/social 本来就是 busyExempt 的，tick 内部会自己判该不该说。
      if (this.spont && this.talk) {
        try { await this.spont.tick(this.talk) } catch (e) {}
      }
      await this.doSurvive(danger)
      return
    }

    // 2. 天亮重置
    const tod = bot.time && bot.time.timeOfDay
    if (tod !== undefined && (tod < 12000 || tod > 23500)) {
      const wasNight = this._wasNight
      this.sheltered = false
      this._nightAlerted = false     // 新的一夜可以再警觉一次
      this._wasNight = false

      // 【天亮要出洞】2026-11-14
      //
      // 这是用户最大的那句抱怨「我每次见到他他都在地下」的直接机制：
      //   天黑 -> reflex.shelter() 往下挖 2 格 + 封顶 -> 躲进去
      //   天亮 -> **这里只清了两个标记，没有任何"爬出来"的动作**
      //   下一次有人需要地面 -> 才碰巧触发 getToSurface
      // 于是他可以在地下的洞里待很久。
      //
      // 实测：`[03:57:38] [night] 天黑了，挖个洞躲一下` 之后 y 从 58 掉到 54。
      //
      // 真人天亮了会自己钻出来。这里补上这条出口：
      //   · 只在"刚从天黑变天亮"那一刻触发（wasNight）
      //   · 只在没忙的时候（不打断手上的活）
      //   · 在地下才做（y 低于地表基准）
      //   · try 包住，挖不上去也不影响主循环
      if (!this.busy && this.actions) {
        const y = bot.entity && bot.entity.position ? bot.entity.position.y : null
        const SURFACE_Y = 58
        // 【不只认"刚天亮"】2026-11-14
        //
        // 原来写的是 `wasNight &&` —— 但 bot 是白天启动的，`_wasNight` 一开始是
        // undefined，所以第一次天亮不会触发。而"第一次"恰好是明早用户进来的那一刻。
        //
        // 现在改成：白天 + 在地下 + 没忙 + 10 分钟内没试过 -> 就出来。
        // 不管他是"昨晚躲进来的"还是"启动时就在下面"。
        const sinceTry = Date.now() - (this._lastSurfaceTryAt || 0)
        if (y != null && y < SURFACE_Y && sinceTry > 10 * 60 * 1000) {
          this._lastSurfaceTryAt = Date.now()
          this.log(`[day] 天亮了还在下面（y=${Math.round(y)}），爬出去`)
          // 【主循环阻塞点】getToSurface 原来没有上限，实测 `[04:31:29] [act] [surface] 680 秒没升高`
          // —— 那 680 秒里整条主循环停摆，用户喊他一律不应。爬不上去就该放手。
          //
          // 但只做 Promise.race 是不够的：超时只是"不再等"，底层还在按 step 挖方块、
          // 还在动 pathfinder。主循环往下走就会两条线抢同一个 bot（107 那类 bug）。
          // getToSurface 每个 step 开头都有 check()，所以发中断信号它下一步就自己放手；
          // 等它真退出（最多 5 秒）再把信号撤回 —— 这个分支没有别的东西持有动作线，
          // 不撤的话全局 cancel 会一直立着，后面所有动作都抛「任务被中断」。
          const surfaceJob = this.actions.getToSurface()
          let surfaceTimer = null
          try {
            await Promise.race([
              surfaceJob,
              new Promise((_, rej) => {
                surfaceTimer = setTimeout(() => rej(new Error('出洞超时 90s')), 90000)
                if (surfaceTimer.unref) surfaceTimer.unref()
              })
            ])
          } catch (e) {
            this.log('[day] 出洞失败/超时：' + (e && e.message))
            this._signalCancel('出洞超时/失败')
            await Promise.race([surfaceJob.catch(() => {}), sleep(5000)])
            // 只有真的没人占着动作线才复位（同 interruptCurrent 的口径）：
            // 否则会把 home/follow/session 的中断信号误清掉。
            if (this.actions && !this.lock.busy) this.actions.cancel = false
            try { this.actions.stop() } catch (e2) {}
          } finally {
            if (surfaceTimer) clearTimeout(surfaceTimer)
          }
        }
      }
    } else if (tod !== undefined) {
      this._wasNight = true
    }

    // 3. 天黑 + 血少 -> 躲
    if (tod !== undefined && tod > 13000 && tod < 23000 && bot.health <= 14) {
      if (!this.sheltered) {
        this.sheltered = true
        this.log('[night] 天黑了，先躲起来')
        const near = this.reflex.nearestHostile(12)
        if (near) { this.reflex.flee(near); await sleep(3000) }
        await this.reflex.shelter()
      }
      // 【同一个形状的第二个连接】2026-11-14
      //
      // 天黑 + 血<=14 躲起来时，这里原来直接 sleep+return，
      // 而 spont.tick 在 1777 行（后面）—— 也就是说：
      // **天一黑、他又血少，他就不能说话了。**
      //
      // 普通模式有怪，明天他天黑大概率会躲；这条不修 = 晚上他是个哑巴。
      // 跟上面危险分支同一个修法：complain/social 是 busyExempt 的，
      // tick 内部自己判该不该说，外面只要别忘了调它。
      if (this.spont && this.talk) {
        try { await this.spont.tick(this.talk) } catch (e) {}
      }
      await sleep(8000)
      return
    }

    // 3.5 天黑 + 血够 -> 警觉，但不躲
    //
    // 【REAL-STATUS：`tod>13000 && health<=14`，满血永不触发】
    // 原来"天黑"这件事只有一条路：血 <=14 才躲。血满 20 的人天黑之后
    // 一条日志、一句话、一个动作都没有 —— 天黑对他等于不存在。
    //
    // 真人不分血量，天黑了都会警觉：抬头看一眼、插个火把、往家那边靠，
    // 或者至少嘟囔一句。要不要**停手躲起来**才取决于血。
    // 所以这里拆成两条：血低 -> 躲（上面那条，原样保留）；血够 -> 只是警觉。
    if (tod !== undefined && tod > 13000 && tod < 23000 && bot.health > 14) {
      if (!this._nightAlerted) {
        this._nightAlerted = true
        this.log(`[night] 天黑了（血 ${Math.round(bot.health)}，血够，不躲）—— 警觉一下`)
        // 心里有这件事：提示词里也会带（selfstate 的"时间"那行）
        if (this.events) {
          try { this.events.push('time_change', { tod, phase: 'night' }, '天黑了，外面开始刷怪') } catch (e) {}
        }
        // 让他在公屏上嘟囔一句（不一定说，chance 控制）
        if (this.spont) {
          try {
            this.spont.push({
              situation: '天黑了，外面开始刷怪。你血还是满的，不慌，但天黑了总归不是好事。',
              chance: 0.45,
              maxLen: 22
            })
          } catch (e) {}
        }
      }
    }

    // 4. 心情和品味随时间变化
    this.tickInnerState()

    // 5. 检查背包有没有新收获，攒个"想说话"的念头
    this.checkNewLoot()

    // 5.5 喂一次"有没有人在看我"（main 这一层显式接线）
    //     被注视强度 focus 会被 audience 自己用在 bot.dig 的停顿上；
    //     这里只负责让它每轮都有最新位置/朝向，别等人走了还在"被看着"。
    if (this.audience) {
      try { this.audience.tick(bot) } catch (e) {}
    }

    // 6. 有攒着的念头就问他要不要说（吐槽类不受"忙"限制）
    if (this.spont && this.talk) {
      await this.spont.tick(this.talk).catch(() => {})
    }

    // 6. 正在干活不打断
    //    回家也算在干活：它自己管 busy，但万一被别处误清过，
    //    这里再兜一次，保证主循环不会趁虚插进来抢寻路。
    if (this.busy) return

    // 6.05 血 <= 5：不接新任务。
    //      这时候再起一个"去挖矿"，等于让他走去送；逃跑/吃东西在 reflex 的
    //      独立定时器里跑，不受这个闸门影响 —— 这里只挡"开新任务"这一件事。
    if (this.reflex && this.reflex.blocksNewTasks()) return

    // 6.4 被人叫去跟着走的时候，不许自己开新任务。
    //     否则就是"两个东西并排走"：他在跟人，同时又决定去挖矿。
    if (this.invite && this.invite.active) return

    // 7. 有答应别人的事就先做（答应了要做到）
    let want = null

    // 6.5 该不该先回家一趟？
    //
    // 【实测 · 2026-11-13 16:30】旧实现只有"复活后离家>96才回家"这一条路，
    // 也就是说**不死就永远不回家**。实测他在地下 y=18 一直挖，家在
    // 66,64,-92（水平 82 格、垂直 46 格），旧的水平判定算出 82 格 < 96，
    // 判成"不远"，于是永远不回家 —— 用户说的「每次见他都在地下」就是这个。
    //
    // 现在每轮都问一次 home.shouldHeadHome()：距离/深度/背包/工具综合判断，
    // 只有代价真的超过收益时才打断，不是"离家就回"。
    if (this.home && this.home.hasHome && !this.lock.isHolding(REASON.HOME)) {
      const head = this.tryHeadHome()
      if (head) return
    }

    // 6.6 今天这一份挖够了没？待太久了没？
    //
    // 【为什么需要这一条】goals.js 有 shouldWrapUp()，但它不会自己打断任务。
    // 实测：回家成功后 1 分钟他又钻回地下（16:47 到家，16:48 到 y=60）。
    // 原因是长期目标「一直往下挖」没有"什么时候算完"。
    //
    // 现在挖到「今天份」（比如 8 块铁矿）或者在地下待了 25 分钟，
    // 就主动收工，让他有个自然的收尾。
    if (this.goals) {
      try {
        const wrap = this.goals.shouldWrapUp(this.statusWithUnderground())
        if (wrap && wrap.yes) {
          // 5 分钟冷却，别每轮都喊
          const now = Date.now()
          if (now - (this._lastWrapUpAt || 0) > 5 * 60000) {
            this._lastWrapUpAt = now
            this.log('[goals] 该收工了：' + wrap.why)
            if (this.will && this.will.finish) this.will.finish()
            // 下次 think() 会拿到 getup 或别的目标
            this.will && (this.will.current = null)
          }
        }
      } catch (e) {}
    }

    // ===== 歇着的时候，两个入口都要关掉 =====
    //
    // 【goals-fixer 实测 · 2026-11-13】`will.js:37` 的第一入口是 goals.current()，
    // 那条已经通过 isResting() 了。但另外三条绕开 goals 的路没有：
    //   ① pendingTask（答应别人的事 / session 派的活）
    //   ② impulse.maybe()（冲动，休息时不该有冲动去干活）
    //   ③ will.current 缓存（休息前领的活会跑到 finish()，最长 420s）
    //
    // 歇着就是歇着，别半路又被派走。
    if (this.goals && this.goals.isResting && this.goals.isResting()) {
      // 休息态：只允许 pendingTask 里"歇着"那一类（session 派的回家收拾）
      if (this.pendingTask && /歇|回家|收拾|睡/.test(this.pendingTask.text || '')) {
        want = this.pendingTask
        this.pendingTask = null
        this.log('[comply] 歇着，顺手做：' + want.text)
      } else {
        // 其它一律压到休息结束
        //
        // 【别刷屏】这段每秒跑一次，原来每次都打一行 —— 实测 `[rest] 正在歇着，…`
        // 每 5 秒一条，10 分钟 120 条，日志全被它淹了（真正的问题反而看不见）。
        // 改成 60 秒一次，而且只在"被什么压住了"这件事变了的时候才说。
        const heldKey = (this.pendingTask ? this.pendingTask.text : '') + '|' +
          (this.will && this.will.current ? this.will.current.text : '')
        if (heldKey !== this._restHeldKey || Date.now() - (this._restHeldAt || 0) > 60000) {
          this._restHeldKey = heldKey
          this._restHeldAt = Date.now()
          if (this.pendingTask) {
            this.log('[rest] 正在歇着，「' + this.pendingTask.text + '」等缓过来再说')
          }
          if (this.will && this.will.current) {
            this.log('[rest] 歇着，把手上「' + (this.will.current.text || '') + '」先放下')
          }
        }
        // impulse 不问了（歇着没冲动）
        if (this.will && this.will.current) this.will.current = null
        await sleep(3000)
        return
      }
    }

    // 【临界判断】血低 + 饿低 = 命比手上这件事重要，pendingTask 让位给找吃的。
    // 放在 `if (this.pendingTask)` 消费点**之前**，否则这一条永远轮不到。
    const critical = this._dropPendingIfCritical()

    if (this.pendingTask) {
      want = this.pendingTask
      this.pendingTask = null
      this.log('[comply] 去做答应的事：' + want.text)
    } else {
      // 看看有没有冲动想干别的
      // 临界时不问冲动：impulse.maybe() 要问模型（好几秒），血 7 的时候不能等它，
      // 而且它给出的多半是"看看那边"这类闲事 —— 会把刚让出来的位置又抢走。
      if (!critical && this.impulse && this.taste && this.mood) {
        const whim = await this.impulse.maybe(this.taste, this.mood, this.will.pending() || '')
        if (whim) {
          want = { text: whim, since: Date.now(), done: false }
          this.log('[impulse] 临时改主意：' + whim)
        }
      }
      // impulse.maybe() 也会问模型，同样要重新确认忙不忙
      if (this.busy) return
    }

    // 8. 没有别的事，就问自己想干什么
    //    问之前先保证心里有个长期目标 —— will.think() 第一件事就是看它。
    //    放这里而不是 tick 开头：ensure() 没有目标时要问模型（几秒），
    //    不能让自救/躲夜排队等它。
    await this.ensureGoal()
    // 【实测踩到】ensureGoal 要等模型好几秒。这几秒里别的地方可能已经把
    // busy 置成 true（复活后回家、反射层抢救），而上面第 6 步的 busy 检查
    // 早就过了。不在这里重新确认的话，回家途中会再起一个任务跟它抢
    // pathfinder 的目标 —— 实测「离家 164.8 格 → 197.5 格」，越走越远。
    if (this.busy) return
    if (!want) want = await this.will.think()
    if (!want) return

    // ===== 歇着不是任务 =====
    //
    // 【盲测 RT2 第 9 行抓到的】goals.current() 在休息态会返回一句
    // 「先歇着，什么都不干（精力还没回来）」，带 `resting: true` 标记 ——
    // 目的是不让 will 掉进兜底模板（那会变成"弄点木头先做把镐"，还是活）。
    //
    // 但主循环把它当成了正常任务：`>>> 开始：先歇着…` → 完成 → 下一轮又来
    // → 30 分钟里"什么都不干"被宣布了 23 遍，裁判第一眼就判不是真人。
    //
    // 为什么上面的休息态闸门没拦住：`isResting()` 是实时读 mood/session 的，
    // 精力在阈值附近恢复时它会翻。闸门那一刻是 false，等 will.think() 问到
    // goals.current() 时又成了 true —— 于是漏过去。
    //
    // 所以这里认 `resting` 标记，不认 isResting()：标记在 want 身上，不会翻。
    if (want && want.resting) {
      if (!this._restingLoggedAt || Date.now() - this._restingLoggedAt > 60000) {
        this._restingLoggedAt = Date.now()
        this.log('[rest] 歇着，不派活（精力还没回来）')
      }
      await sleep(5000)
      return
    }
    // will.think() 同样可能等模型；它回来时也可能已经忙起来了
    if (this.busy) return

    // 占住 task 这条线（rank 10）。抢不过说明有更高优先级的线在跑，这轮不起任务。
    // 以前这里是一句 busy=true，只能表达"有人占着"，说不出是谁、占多久。
    if (!this.lock.acquire(REASON.TASK, want.text)) {
      this.log(`[lock] 起任务被拒：${want.text}（当前 ${this.lock.describe()}）`)
      return
    }
    this.taskDesc = want.text
    this._taskStartInv = this.snapshotInv()   // 记下开始时的背包，用来判断产出
    // 同时记位置：观察/探索类任务没有背包指标，"有没有真的去"只能看位移
    try { this._taskStartPos = this.bot.entity.position.clone() } catch (e) { this._taskStartPos = null }
    // 【层1根治】记下脚下这片世界的方块快照。
    // 盖墙/铺路/挖通道这类活背包不会变（挖下来的东西又用掉了），
    // 只有"方块真的动了"能证明他干了事。
    try { this._taskStartWorld = this.worldSig(this._taskStartPos) } catch (e) { this._taskStartWorld = null }
    // 手持物品和饱食度：换装备时背包可能一点没变（工具在手上换），
    // 吃东西时食物一定变少 —— 这两样不记，这两类活永远没证据。
    try { this._taskStartHeld = this.bot.heldItem ? this.bot.heldItem.name : null } catch (e) { this._taskStartHeld = null }
    try { this._taskStartFood = Math.round(this.bot.food) } catch (e) { this._taskStartFood = null }
    try { this._taskStartHealth = Math.round(this.bot.health) } catch (e) { this._taskStartHealth = null }
    this._taskStartAt = Date.now()   // duration 类证据（待够 N 秒）要用
    if (this.actions) { this.actions.cancel = false; this.actions.stop() }
    const t0 = Date.now()
    if (this.impulse) this.impulse.taskStarted()
    this.log(`>>> 开始：${want.text}`)

    // 卡死检测：任务里如果连续 60 秒没有任何动作，就当它挂了
    this._taskProgress = { at: Date.now(), pos: this.bot.entity.position.clone() }
    const stallCheck = setInterval(() => {
      const tp = this._taskProgress
      if (!tp) return
      const p = this.bot.entity ? this.bot.entity.position : null
      if (!p) return
      // 位置动了、或者背包变了、或者刚打了日志 -> 算有进展
      if (p.distanceTo(tp.pos) > 0.8) {
        tp.pos = p.clone()
        tp.at = Date.now()
        return
      }
      if (Date.now() - tp.at > 60000) {
        this.log('[stall] 一分钟没动，强制结束任务')
        this._signalCancel('stall 一分钟没动')
        try { this.bot.pathfinder.setGoal(null) } catch (e) {}
        tp.at = Date.now() + 600000   // 别重复触发
      }
    }, 5000)

    // 硬超时：代码里可能卡在某个 await 上，到点强制打断
    const hardTimeout = (this.cfg.behavior.taskTimeoutSeconds || 420) * 1000
    const timeoutPromise = new Promise((_, rej) => {
      this._taskTimer = setTimeout(() => {
        this._signalCancel('任务硬超时')
        try { this.bot.pathfinder.setGoal(null) } catch (e) {}
        rej(new Error('这个任务干太久了，先放下'))
      }, hardTimeout)
    })

    try {
      const ctxText = this.contextForTask()
      // 把"家"和"长期目标"有没有进上下文一并打出来。
      // 光看 [ctx] 字符数证明不了这两个模块在工作 ——
      // 之前就是"接进去了"但没人验证过 summary() 真的在提示词里。
      const hasHome = /^## 家$/m.test(ctxText)
      const hasGoal = /^## 你心里挂着的一件事$/m.test(ctxText)
      this.log(`[ctx] 上下文 ${ctxText.length} 字符${/剖面/.test(ctxText) ? '（含视觉地形图）' : '（⚠️ 没有视觉）'}` +
        `｜家:${hasHome ? '✓' : '✗'} 长期目标:${hasGoal ? '✓' : '✗'}`)
      const result = await Promise.race([
        this.coder.writeAndRun(want.text, ctxText),
        timeoutPromise
      ])
      const secs = Math.round((Date.now() - t0) / 1000)
      // 【清理模型输出里的机器痕迹】2026-11-14
      //
      // 实测（时间线里能直接看到的）：
      //   <<< 完成（14s）：先把饥饿稳住了（饱食度 undefined），然后走到煤矿石旁…
      //   <<< 完成（112s）：找到一处较平的地方 x=71.6414073466172 z=-50.501282362381104
      //
      // `undefined` 和 16 位小数的坐标，一眼就是机器写的。
      // 而 outText 会进事件队列（`events.push({text: want.text + ' -> ' + outText.slice(0,60)})`），
      // 模型下一轮看得到 —— 于是它可能被说出来。
      //
      // 只清理不改变语义的两类：undefined/null/NaN，和超过 2 位的小数。
      const outText = String(result.output || '')
        .replace(/\b(undefined|null|NaN)\b/g, '?')
        .replace(/(-?\d+\.\d{3,})/g, (m) => String(Math.round(parseFloat(m) * 10) / 10))

      // ===== 成败判定 =====
      // 之前这里有两个致命 bug：
      //   1. 写了 judgeOutcome() 却从没调用，用的是一段只能匹配开头 40 字的粗糙正则
      //   2. 失败分支引用了未定义的 verdict 变量，抛 ReferenceError，
      //      导致所有失败记录都写不进记忆（日志里有三次 "verdict is not defined"）
      //
      // ===== 【层1根治】判成功必须看世界，不看话术 =====
      //
      // 参谋挖出来的分工（2026-11-13）：
      //   层1 判定看话术：result.ok = 代码没抛异常；verdict = 读模型自己写的结尾
      //   层2 技能记账：out.ok 同样的东西 -> 成功率虚高 -> 越熟越死
      //   层3 目标进度：kind do/build 一句"完成"就白送 +1
      //
      // 所以这里改权责：judgeOutcome 降级成**否决权**（说了失败词就是失败），
      // 不再有批准权。批准权交给 verifyTaskEffect()：背包 / 目标产物 /
      // 周围方块 / 位移，四样里得真的动了一个。
      // 顺序有意义：先拿世界的证据，再让文本行使否决权 ——
      // 文本里那些"推断类"判断（A→A 数量没变、零产出字样）在有硬证据时
      // 不该拍板。实测 22:34:13 一个真干成的任务（背包+9 方块15）
      // 就因为句子里有"3→3"被判死。
      const proof = this.verifyTaskEffect(want.text, outText)
      const verdict = this.judgeOutcome(want.text, outText, t0, proof.ok)

      if (result.ok && verdict.ok && proof.ok) {
        this.log(`<<< 完成（${secs}s）：${outText}`)
        // 【入库规则】没有"无进展退出"的代码不进库。
        // 双峰耗时的成因就是它只有成功出口；这种代码存下来会被复用一辈子。
        const keep = result.code ? require('./src/coder').hasNoProgressExit(result.code) : false
        if (result.code && !keep) {
          this.log('[skill] 这段代码没有"无进展就退出"的出口，不入库')
        }
        if (result.code && keep) {
          this.skills.add({
            name: 'k_' + Date.now().toString(36),
            desc: want.text,
            code: result.code,
            tags: extractTags(want.text)
          })
        }
        this.will.finish()
        this.mem.add({
          text: want.text + (outText ? ' -> ' + outText.slice(0, 60) : ''),
          kind: 'event',
          importance: 0.4,
          emotion: 0.3
        })

        // 做完之后，问自己爽不爽 —— 这是他品味的来源
        this.judgeAndGrow(want.text, outText).catch(() => {})
        if (this.mood) this.mood.onEvent('task_done', 1)
        // 干完了：攒个念头，让主动层决定说不说
        if (this.spont) this.spont.push(spontaneous.onGoalDone(want.text, outText))
        // 告诉长期目标"这一下算数" —— 带上**真实增量**，不再白送 +1
        this.log(`[proof] 硬判据通过：${proof.evidence || ''}`)
        this.reportTaskResult(true, want.text, outText, { progress: proof.progress })
      } else {
        const why = result.error ||
          (!verdict.ok ? verdict.why : '') ||
          (!proof.ok ? proof.why : '') ||
          outText
        this.log(`<<< 失败（${secs}s）：${why}`)

        // ===== 失败归因：进日志，不进长期记忆 =====
        //
        // 原来失败记 importance:0.65 + kind:'skill'（不衰减），
        // 成功只记 0.4（会衰减）—— 长期下来记忆里全是失败。
        //
        // 而且 wishFailText 会把 "模型调用失败: HTTP 403 <!DOCTYPE html>"
        // 当成"人生教训"存进长期记忆。那不是教训，是故障。
        //
        // 现在分两种：
        //   - 环境/网络/模型故障 -> 只进日志
        //   - 真正的"做事没成" -> 记进记忆，但 importance 降到 0.35（会衰减）
        const isEnvFailure = /HTTP \d|DOCTYPE|ECONN|timeout|超时|模型调用失败|401|403|429|500|502|503/i.test(why)
        if (!isEnvFailure) {
          this.mem.add({
            text: wishFailText(want.text, result.error || outText),
            kind: 'event',
            importance: 0.35
          })
        } else {
          this.log('[mem] 这是环境故障，不写进长期记忆')
        }
        this.will.finish()
        if (this.mood) this.mood.onEvent('task_fail', 1)
        // 告诉长期目标"这趟没成" —— 同一个阶段失败太多次它会自己换路
        this.reportTaskResult(false, want.text, why, { progress: 0 })
        const others = Object.keys(this.bot.players || {}).filter(n => n !== this.bot.username)
        // 断线打断时别攒抱怨 —— 同上，重连后不该提断线前的事
        if (this.spont && !this._interrupted) {
          const err = String(result.error || outText || '')
          const kind = /找不到|没找到|没树|没有/.test(err) ? 'nothingFound'
            : /合成|craft|材料/.test(err) ? 'craftFail'
            : /卡住|走不动/.test(err) ? 'stuck'
            : 'nothingFound'
          const ev = spontaneous.onComplain(kind, err.slice(0, 30))
          if (ev) this.spont.push(ev)
        }
      }
    } catch (e) {
      this.log('任务异常: ' + e.message)
      this.will.finish()
      // 异常也算一次失败：不回报的话，长期目标那边会以为"还没试过"，
      // 同一阶段会因为异常无限重试。
      // 但断线打断的异常不算 —— 那一局已经作废，见 _teardown / reportTaskResult。
      this.reportTaskResult(false, want.text, e.message, { progress: 0 })
      // 断线打断时也别攒「跑不动/找不到」的抱怨：那是网络问题，
      // 说出去就变成重连后突然提断线前的事（真人不会这么讲）。
      if (this.spont && !this._interrupted) {
        const err = String(e.message || '')
        const kind = /卡住|走不动/.test(err) ? 'stuck' : 'nothingFound'
        const ev = spontaneous.onComplain(kind, err.slice(0, 30))
        if (ev) this.spont.push(ev)
      }
    } finally {
      if (stallCheck) clearInterval(stallCheck)
      this._taskProgress = null
      if (this._taskTimer) { clearTimeout(this._taskTimer); this._taskTimer = null }
      // 【实测踩到的坑】任务收尾会无条件把 busy 拍成 false。
      // 但"回家"是另一条独立的动作线，它跑几十秒到几分钟。
      // 期间一个早就起跑的任务走到这里，就把回家的忙状态误清掉，
      // 主循环立刻起新任务，两边抢 pathfinder —— 实测「107 → 105 → 107」原地打转。
      // 回家期间不碰 busy，让 tryGoHomeAfterRespawn 的 finally 负责收尾。
      //
      // 只归还 task 这一条线 —— 这就是 107 的根因修法：
      // 早跑的任务收尾时，home/follow/session 的锁一格都不动。
      // 用 isHolding 兜一下：死亡/看门狗可能已经整把清过，那不是 bug，别刷告警。
      if (this.lock.isHolding(REASON.TASK)) this.lock.release(REASON.TASK)
      if (!this.lock.isHolding(REASON.HOME)) this.taskDesc = ''
      if (this.actions) this.actions.cancel = false
    }

    // 忙完了：回头接一下刚才没顾上的话（说"等会儿"就得回来）
    if (this.talk) {
      try {
        const replied = await this.talk.followUpDeferred()
        if (replied) this.log('[followup] 回头接完了')
      } catch (e) {
        this.log('[followup] ' + e.message)
      }
    }

    // 干完一件事先发一会儿呆（UNHUMAN-SCAN #16）。
    //
    // 原来这里固定 `sleep(3000 + random*9000)`，不管 config 里写的
    // idleThinkSeconds 是多少 —— 实测任务间隔中位数 10 秒、最短 1 秒，
    // 看起来像"任务队列在空转"，不像一个人在决定下一步做什么。
    await this.idleThink()
  }

  /**
   * 判断一个任务到底成没成。
   *
   * 不能靠正则匹配模型写的自然语言（"挖青金石矿（mine返回0）"这种，
   * 正则穷举不完）。改成三条硬标准，任一不满足就算失败：
   *
   *   1. 模型自己说了失败词（明确的"失败/没做成/做不了"）
   *   2. 输出里有"返回0""从0变成0""0块""0个"这种零产出的痕迹
   *   3. 任务说要做某样东西，但背包里没有
   */
  judgeOutcome (goal, outText, t0, hardOk) {
    const t = String(outText || '')

    // 1. 明确的失败词
    if (/^(失败|没做成|没成功|做不了|搞不定|完成不了|放弃)/.test(t)) {
      return { ok: false, why: '模型明确说了失败' }
    }
    // 执行异常
    if (/出错|Error:|任务被中断|异常|崩溃/.test(t)) {
      return { ok: false, why: '执行出错' }
    }
    if (/(做不了|做不出|放不出|挖不出|弄不出|盖不成|造不出|没做成|搞不定|完成不了|没能|白忙|砍不到|挖不到|找不到|没找着|找不着|没捞着|没弄到|弄不到|拿不到|啥也没有|白折腾|白费)/.test(t)) {
      return { ok: false, why: '输出里有失败词' }
    }
    // 超时 —— 明确没完成
    if (/超时|未完成|没跑完|超过\s*\d+\s*s/i.test(t)) {
      return { ok: false, why: '超时未完成' }
    }
    // "没凑齐"/"材料不够"/"差X个" —— 明确没做成
    if (/(没凑齐|凑不齐|材料不够|材料不足|还差|缺\s*\d)/.test(t)) {
      return { ok: false, why: '材料没凑齐' }
    }
    // "没X，Y不动" / "身上没X" / "挖不动" —— 能力不足，明确失败
    if (/(没镐子|没斧头|没工具|没材料|手上没有|身上没).*?(挖不动|砍不动|做不了)|挖不动|砍不动|搞不了/.test(t)) {
      return { ok: false, why: '能力不足（缺工具/材料）' }
    }
    // "弄到 0 份" / "0 个" 这种明确的零收获
    if (/(弄到|挖到|砍到|拿到|做了|合了|烤了)\s*0\s*(份|个|块|根|把|颗|件)/.test(t)) {
      return { ok: false, why: '明确零收获' }
    }

    // 目标是要"上去"，而文本自己承认还在下面 —— 明确的失败信号。
    // 真机铁证（22:54:45）：
    //   <<< 完成（86s）：没硬往上挖，往北探了探（没挪动），点了火把、捡了捡东西，
    //                    坐下歇了会儿。现在 y=42，还在地面下，出去的事改天再想。
    // 这句话里三个失败词（没硬往上挖 / 还在地面下 / 改天再想）原来一个都没识别。
    if (/(回到地面|回到上面|回到地表|离开地下|出洞|出土|上去|爬到|爬上|上到|升到)/.test(goal) &&
        /(还在地面下|还在地下|还在地底|没上去|没爬上去|没往上去|没硬往上|没往上挖|出去的事改天|改天再想)/.test(t)) {
      return { ok: false, why: '目标是上去，文本自己说还在下面/没上去' }
    }

    // ===== 到这里为止都是"明确的失败信号"，文本的否决权到此结束 =====
    //
    // 硬判据已经证明世界变了（hardOk）→ 直接放过。
    // 下面那些都是**推断**（正则猜"有没有产出"），不该压过真实背包/方块/位移。
    // 真机实测被它们误杀过一次：
    //   22:34:13 [ledger] 背包+9 方块15 位移3.7 结论:成
    //   22:34:13 <<< 失败（106s）：背包数量没变（3→3、0→0）
    if (hardOk) return { ok: true, why: '' }

    // 2. 零产出的痕迹
    //
    // 踩过的坑：单一正则太容易误判。
    // 例："用石镐挖了安山岩4块、石头0块；安山岩 51→52" —— 实际成功了，
    // 但 /0\s*块/ 匹配到"石头0块"就判失败。
    //
    // 改成：先看有没有"明确增加"的证据，有就放过；
    // 没有增加证据时，才用零产出模式判失败。
    // 先查"A→A"这种"数量没变" —— 比 hasGain 优先
    // 实测日志："用石镐挖了安山岩6块；安山岩 109→109，圆石 126→126"
    // 前半句的"6块"会被 hasGain 当成有产出，但实际一个都没增加
    //
    // 【降级为推断】硬判据已经通过时（hardOk），这一整块不判死：
    // 它读的是"句子里出现了一对 3→3"，而真正该看的是背包到底变没变。
    // 实测 22:34:13：背包+9、方块动 15 格的真成功，被这句"3→3"否掉。
    if (!hardOk) {
      const arrows = [...t.matchAll(/(\S+)\s*(\d+)\s*(?:→|->|>)\s*(\d+)/g)]
      if (arrows.length) {
        const gained = arrows.some(m => Number(m[3]) > Number(m[2]))
        if (!gained) {
          // 【删掉两处"文本批准"例外】原来这里有：
          //   if (isCraftTask && /做好了/.test(t)) return { ok: true }   ← 制作类
          //   if (isEatTask)                     return { ok: true }   ← 吃东西类
          // 它们解决的是"石镐做出来了但箭头全在减少"这个真实问题，
          // 但解决方式是**再用一句正则批准** —— 同一个病的第 5 次。
          // 现在这两类由 src/judge.js 的证据维度负责：
          //   制作 -> 产物进背包（stone_pickaxe +1）
          //   吃东西 -> 饱食度上升或食物类减少
          // judgeOutcome 只剩否决权，这里不再返回 ok:true。
          // scripts/check-judge-discipline.js 会盯着这条线。
          return { ok: false, why: `背包数量没变（${arrows.map(m => `${m[2]}→${m[3]}`).join('、')}）` }
        }
      }
    }

    // ===== 文本里的"增加证据"=====
    //
    // 【#8 的核心 bug】原来这里第一条是
    //   /[1-9]\d*\s*(块|个|根|把|颗|件)/
    // 意思是"文本里出现 4块/12个 就算有产出"。
    // 但技能 k_mwe74ysb 的结尾是无条件：
    //   return '现在手上有圆石' + actions.countOf('cobblestone') + '个，石料总共约' + finalCobble + '个，够垫脚用了'
    // "圆石132个" 正好命中 —— 哪怕一个都没捡到，也判成功。
    // 实测它 74 次复用 ok 74 / fail 0，世界却毫无变化。
    //
    // 现在：**光出现数字不算**。必须是"动词 + 数字"（真的做了/拿到了），
    // 或者 A→B 且 B>A 这种明确增量。
    // 单纯"有 132 个"只是描述存量，不是进展。
    const hasGain = [
      /从\s*\d+\s*变成\s*([1-9]\d*)/,                     // "从0变成5"
      /(?:→|->)\s*([1-9]\d*)/,                            // "51→52"（上面已单独校验 B>A）
      // 动词 + 数量：真做了事才有的说法
      /(?:挖到|捡到|拿到|砍到|采到|凑到|攒到|获得|收获)\s*[1-9]\d*/,
      /(?:挖|砍|捡|采|做|合|烤|种|放|摆|存|建|盖)(?:了|下|出|好|成)\s*(?:[1-9]\d*\s*(?:块|个|根|把|颗|件|张|座))?/,
      /做好了|做成了|搭好了|盖好了|摆好了|放好了|种好了|存好了/,
      // 明确的"增加/涨了"
      /(?:增加|多了|涨了|净增|\+)\s*[1-9]\d*/
    ].some(re => re.test(t))

    const zeroPatterns = [
      /（mine返回0）/,
      /返回\s*0\b(?!\s*(块|个))/,                 // "返回0" 但不匹配 "返回0块"
      /从\s*0\s*变成\s*0(?!\d)/,                 // "从0变成0" 但不匹配 "从0变成05"
      /挖了\s*0(?!\d)/,
      /做了\s*0(?!\d)/,
      /没拿到|没弄到|没挖到|没砍到|没找到|一个也没|一块也没/,
      /（尝试\s*\d+\s*轮）/
    ]

    // "不足"/"不够"/"未达标"/"仍需" —— 明确没达到要求，优先于 hasGain
    // 实测："爬升 1 格，需 ≥3，判定已出地面，爬升不足"
    // 句子里有"爬升 1 格"这种增加证据，但结论是"不足"
    if (/不足|不够|未达标|仍需|但没|但未/.test(t)) {
      return { ok: false, why: '没达到要求' }
    }

    // 有增加证据时，只信最明确的失败信号
    if (hasGain) {
      const hardFail = /（mine返回0）|没拿到|没弄到|没挖到|没砍到|一个也没|一块也没/
      if (hardFail.test(t)) return { ok: false, why: '有增加但也有明确失败' }
      // 否则放过
    } else {
      for (const re of zeroPatterns) {
        if (re.test(t)) return { ok: false, why: '输出显示零产出' }
      }
    }

    // ===== 3. 背包硬对比（#8 的正面修法）=====
    //
    // 上面两条都只看文本。文本可以被"无条件 return 成功文案"骗过去 ——
    // 这正是 k_mwe74ysb 74 次 0 失败的原因。
    // 所以这里加一条不看文本的判据：**任务开始时和现在，背包到底变没变。**
    //
    // 分类处理，不能一刀切：
    //
    //   A. 产出型任务（弄/挖/砍/收集/做...）
    //      -> 要求背包**增加**。没增加就是没做成，不管模型怎么说。
    //
    //   B. 消耗/放置型任务（放/摆/存/种/扔/建...）
    //      -> 这类本来就该"背包变少"，要求的是世界变了（方块放下去了）。
    //         背包减少也算成功证据。
    //
    //   C. 观察/探索型任务（看/观察/走/找/记...）
    //      -> 没有背包指标。这类只能靠文本，但要求更严（见下）。
    //
    // 注意不要退回老 bug：老判据只查"目标物品"（用石斧砍树 -> 查石斧 1->1 -> 误判失败）。
    // 这里查的是**整个背包的总变化**，不是特定物品。
    try {
      const before = this._taskStartInv
      if (before && typeof before === 'object') {
        const now = this.snapshotInv()
        const sum = (inv) => Object.values(inv || {}).reduce((a, b) => a + (b || 0), 0)
        const totalBefore = sum(before)
        const totalNow = sum(now)

        // 逐物品增减
        const gained = {}
        const lost = {}
        for (const [k, v] of Object.entries(now)) {
          const d = (v || 0) - (before[k] || 0)
          if (d > 0) gained[k] = d
        }
        for (const [k, v] of Object.entries(before)) {
          const d = (v || 0) - (now[k] || 0)
          if (d > 0) lost[k] = d
        }
        const gainedAny = Object.keys(gained).length > 0
        const lostAny = Object.keys(lost).length > 0

        const isProduce = /(做|制作|合成|弄|搞|挖|砍|打|采|收集|攒|备|升级|换|烤|烧|熔炼|种|捡|找点|弄点|弄到|搞到)/.test(goal)
        const isConsume = /(放|摆|存|放进|存进|摆好|放好|安置|整理|扔|丢|清空|倒)/.test(goal)
        const isObserve = /(看|观察|看看|望|巡视|转一圈|探|确认|记住|记下|标记|问问|说说|睡|歇|等)/.test(goal)

        // D. 搬到/挪到/移开：产物在过程中又被放回去了，背包一定不涨。
        //    这类只认"位置变了"，不查背包（否则"把熔炉搬到山顶"永远判失败）。
        const isMove = /(搬到|搬去|挪到|挪去|移到|移去|运到|扛到|抬到)/.test(goal)

        // A. 产出型：必须真的多了东西
        if (isProduce && !isConsume && !isObserve && !isMove) {
          if (!gainedAny && totalNow <= totalBefore) {
            return {
              ok: false,
              why: `背包没有任何增加（${totalBefore}->${totalNow} 个）——` +
                `文本说有产出，但物品栏没变，这是假成功`
            }
          }
          // 物品总量没涨，但种类变了（比如 1 原木 -> 4 木板，总量涨了；这里兜底）
          if (!gainedAny) {
            return {
              ok: false,
              why: `背包没有新增物品（${totalBefore}->${totalNow}）`
            }
          }
        }

        // B. 消耗/放置型：背包该变少，或者世界里有新方块
        if (isConsume && !isProduce) {
          if (!lostAny) {
            return {
              ok: false,
              why: `要"放/存/摆"东西，但背包一个都没少（${totalBefore}->${totalNow}）——` +
                `东西没出手，这是假成功`
            }
          }
        }

        // C. 观察型：不查背包，但纯文本不变（说明根本没动）要警惕
        if (isObserve && !isProduce && !isConsume) {
          // 位置也没变、背包也没变 => 大概率是干坐着
          const moved = this._taskStartPos
            ? this.bot.entity.position.distanceTo(this._taskStartPos)
            : null
          if (moved !== null && moved < 1.5 && !gainedAny && !lostAny) {
            // 观察类允许原地（比如"睡一会儿"），只记录不判死
            // 这里只对"探/找/看/巡视"这类要求走动的收紧
            if (/(探|找|巡视|转一圈|看看|观察)/.test(goal)) {
              return {
                ok: false,
                why: `说去"${goal.slice(0, 12)}"，但 位置只动了 ${moved.toFixed(1)} 格、` +
                  `背包也没变 —— 根本没去`
              }
            }
          }
        }

        // ===== 3.5 目标产物核对（判据 3，原来只写在函数注释里没实现）=====
        //
        // 函数开头写着"任务说要做某样东西，但背包里没有"要算失败，
        // extractWantedItem() / countItem() 也写好了 —— 但**一次都没被调用**，
        // 就是两段死代码。后果实测（data/runtime/bot.log）：
        //
        //   [code] 挖到铁矿石 0
        //   [code] 冶炼失败:Error: destination full
        //   <<< 完成（44s）：冲铁镐: 铁锭0 生铁0 圆石148
        //
        // 目标是"弄把铁镐"，铁锭 0、铁镐 0，只因为顺路挖了几块圆石让
        // 背包总数涨了，就判成功。同样是假进展，只是指标从小票换成了总数。
        const wanted = this.extractWantedItem(goal)
        if (wanted && isProduce && !isConsume && !isMove) {
          const hadN = before[wanted] || 0
          const nowN = this.countItem(wanted)
          if (nowN === 0) {
            return {
              ok: false,
              why: `目标是「${goal.slice(0, 14)}」，但背包里一个 ${wanted} 都没有` +
                `（背包总量 ${totalBefore}->${totalNow}，涨的是别的东西）`
            }
          }
          if (nowN <= hadN) {
            return {
              ok: false,
              why: `目标是「${goal.slice(0, 14)}」，${wanted} 还是 ${hadN} 个，` +
                `这一趟一个都没多 —— 别的东西涨了不算`
            }
          }
        }

        // ===== 3.6 无单位的零产出（"铁锭0 生铁0"）=====
        //
        // 老正则要求"0个/0块"这种带单位的写法。但模型汇报时常写成
        // "冲铁镐: 铁锭0 生铁0 圆石148" —— 数字紧贴物品名、没有单位，
        // 全部漏过。两个以上"物品0"是极强的零产出信号，产出型任务直接判失败。
        if (isProduce && !isConsume && !isMove) {
          const zeros = [...t.matchAll(/([\u4e00-\u9fa5]{2,6})\s*0(?![0-9])(?![个块根把颗件张座格层度次秒分米])/g)]
            .map(m => m[1])
            .filter(w => !/^(第|共|全|约|剩|差|还)$/.test(w))
          const uniq = Array.from(new Set(zeros))
          if (uniq.length >= 2) {
            return {
              ok: false,
              why: `输出里 ${uniq.map(w => w + '0').join('、')} —— 全是零产出`
            }
          }
        }
      }
    } catch (e) {
      // 背包读不到（断线等）时不因此判失败，交回文本判据
    }

    return { ok: true, why: '' }
  }

  // ==================== 硬判据（层1根治） ====================

  /**
   * 给脚下这片世界拍个方块快照。
   *
   * 为什么要它：盖墙、铺路、挖通道、堵门口的活，背包不会涨 ——
   * 挖下来的东西当场又用掉了。只看背包的话这些真干成的活全被判失败，
   * 只看话术的话没干成的活全被判成功。方块动了才是最硬的证据。
   *
   * 采样范围按半径 5、高 -2..+2（约 600 格）。这不是完整世界状态，
   * 是"他身边这一小片有没有变"—— 够用，而且开销可忽略。
   */
  // 快照统一走 src/judge.js —— 那边用**绝对坐标**做 key。
  // 之前这里 key 是相对偏移、比较时却按当前坐标重拍一次，
  // 人一动所有 key 全变：实测"动了 2 格没挖"报 482 格变化，
  // 等于把"他动过没有"当成了"世界变了没有"，走动型假成功全放行。
  worldSig (pos) {
    return judge.worldSig(this.bot, pos)
  }

  /** 和任务开始时的快照比，有几格的方块变了（-1 表示读不到） */
  worldDiff (pos) {
    const before = this._taskStartWorld
    if (!before) return -1
    // 关键：仍然按**任务开始时锚定的那片区域**取样，
    // 这样两次快照的坐标系完全一致。
    const anchor = this._taskStartPos || pos
    const now = this.worldSig(anchor)
    return judge.worldDiffCount(before, now)
  }

  /**
   * 硬判据：这一趟到底有没有改变世界。
   *
   * 返回 { ok, why, progress, evidence }
   *   progress 是给长期目标的**真实增量**（0 = 什么都没发生）。
   *   上层只用它，"完成"这两个字不再自带进度。
   */
  /**
   * 硬判据：这一趟到底有没有改变世界。**审批权在这里。**
   *
   * 判定本体搬到 src/judge.js 了 —— 因为 main 和 coder 原来各写一份，
   * 同一份证据能得出相反结论（38 个技能 × 3 种世界态，差值 42%）。
   * 现在两边都调 judge.judgeTask()，不会再漂。
   *
   * 返回 { ok, why, progress, evidence }
   *   progress 是给长期目标的**真实增量**（0 = 什么都没发生）。
   */
  verifyTaskEffect (goal, outText) {
    const posNow = (this.bot && this.bot.entity) ? this.bot.entity.position : null
    // 阶段自己声明的证据类型。judge 没有默认分支 —— 阶段没声明会直接抛错。
    // 没有阶段（临时任务，比如"跟他聊两句"）时按世界证据验：那是最严的一类，
    // 不是给文本开口子。
    let stage = null
    try {
      if (this.goals) stage = this.goals.currentStage ? this.goals.currentStage() : (this.goals.stage ? this.goals.stage() : null)
    } catch (e) {}
    // 有阶段就必须由阶段自己声明证据类型：缺了传 undefined，judge 入口直接抛错。
    // 只有"压根没有阶段"的临时任务（聊天、跟随）才按 world 验 —— 那是最严的一类，
    // 不是给文本开口子。
    const evidence = stage ? stage.evidence : 'world'
    const res = judge.judgeTask({
      evidence,
      minSec: stage && stage.minSec,
      durationSec: this._taskStartAt ? (Date.now() - this._taskStartAt) / 1000 : 0,
      healthBefore: this._taskStartHealth,
      healthAfter: this.bot ? Math.round(this.bot.health) : null,
      goal: String(goal || ''),
      text: String(outText || ''),
      invBefore: this._taskStartInv || {},
      invAfter: this.snapshotInv(),
      posBefore: this._taskStartPos,
      posAfter: posNow,
      worldBefore: this._taskStartWorld,
      worldAfter: this.worldSig(this._taskStartPos || posNow),
      heldBefore: this._taskStartHeld,
      heldAfter: (this.bot && this.bot.heldItem) ? this.bot.heldItem.name : null,
      foodLevelBefore: this._taskStartFood,
      foodLevelAfter: this.bot ? Math.round(this.bot.food) : null,
      // 硬事实：现在到底还在地下吗？位置类目标（回地面）可以直接用它判到。
      undergroundAfter: (() => {
        try { return this.actions.isUnderground() } catch (e) { return null }
      })()
    })
    // 【travel 阶段要真的走够】2026-11-14
    //
    // 实测（盲执行人抓到的那条）：
    //   >>> 开始：先往远处走走，看看那边有没有树
    //   [ledger] 背包+0 减0 方块6 位移3.6 ｜ 结论:成
    //   [proof] 硬判据通过：位移 3.6 格
    // 目标是「往外走 80 格」，走了 3.6 格就判完成 ——
    // 因为阶段 evidence 盖的是 'world'（方块变了就算数），而 travel 该看的是「走了多远」。
    //
    // 玩家视角：「说要去找树，43 秒就『做完』了，光走路都不止这点时间。」
    //
    // 所以：travel 阶段额外要求 stageProgress().ratio >= 0.8。
    // 只加这一条，不改 judge 的维度体系（那影响面太大）。
    try {
      if (res && res.ok && stage && stage.kind === 'travel' && this.goals && this.goals.status) {
        // 【别再用 stageProgress】它是 goals 模块导出的**函数**，不是实例方法。
        // 第一版写成 `this.goals.stageProgress()` —— 那会抛 TypeError，
        // 而外面包着 try/catch，于是**这个守卫一次都没真正执行过**。
        // 这是今晚第七个「没连上」，只是这次的受害者是我自己。
        const st2 = this.goals.status()
        const ratio = st2 && Number.isFinite(st2.progress) ? st2.progress : null
        if (ratio !== null && ratio < 0.8) {
          this.log(`[proof] travel 没走够（${st2.progressText || Math.round(ratio * 100) + '%'}），不算完成`)
          res.ok = false
          res.why = `只走了 ${st2.progressText || Math.round(ratio * 100) + '%'}，没到地方`
          res.evidence = ''
        }
      }
    } catch (e) {}

    this._lastProof = res
    // 账本对照：日志里声称的产量 vs 真实背包增量。
    // 哨兵审计里"声称 +0 件、实际捡起 28 件"就是这么来的：
    // 汇报是模型写的，背包是游戏给的，两者必须并排记下来才能对账。
    try {
      const inv = res.dims || {}
      // 账本差：日志/汇报里说的数 vs 背包真的动了多少。
      // 哨兵审计里"声称 +0 件、实际捡起 28 件"就是这条线要量的东西。
      let claim = ''
      try {
        const wants = judge.wantedItems(String(goal || ''))
        if (wants.length) {
          const cn = wants[0].cn
          const m = new RegExp(cn + '\\s*[:：]?\\s*(\\d+)').exec(String(outText || ''))
          const actual = (inv.targets || []).find(x => x.cn === cn)
          claim = ` 声称:${cn}${m ? m[1] : '?'}/实际${actual ? (actual.d >= 0 ? '+' : '') + actual.d : '?'}`
        }
      } catch (e) {}
      this.log(`[ledger]${claim} 背包${inv.invGain >= 0 ? '+' : ''}${inv.invGain} 减${inv.invLoss} ` +
        `方块${inv.blocks < 0 ? '?' : inv.blocks} 位移${inv.moved === null ? '?' : inv.moved} ` +
        `手持${inv.heldChanged ? '变' : '未变'} ｜ 结论:${res.ok ? '成' : '败'}`)
    } catch (e) {}
    return res
  }

  /** 从目标描述里猜他想要什么物品 */
  extractWantedItem (goal) {
    // 顺序有意义：长词在前，否则"做钻石镐"会先命中"石镐"。
    const map = {
      '钻石镐': 'diamond_pickaxe', '木镐': 'wooden_pickaxe', '石镐': 'stone_pickaxe',
      '铁镐': 'iron_pickaxe', '木斧': 'wooden_axe', '石斧': 'stone_axe',
      '铁斧': 'iron_axe', '木剑': 'wooden_sword', '石剑': 'stone_sword',
      '铁剑': 'iron_sword', '工作台': 'crafting_table', '熔炉': 'furnace',
      '箱子': 'chest', '木棍': 'stick', '火把': 'torch', '床': 'red_bed',
      '面包': 'bread', '木门': 'oak_door', '梯子': 'ladder',
      '煤': 'coal', '铁锭': 'iron_ingot', '青金石': 'lapis_lazuli',
      '钻石': 'diamond', '圆石': 'cobblestone', '木板': 'oak_planks'
    }
    for (const [cn, en] of Object.entries(map)) {
      if (goal.includes(cn)) return en
    }
    return null
  }

  /** 数背包里某个物品有多少 */
  countItem (name) {
    try {
      let n = 0
      for (const i of this.bot.inventory.items()) {
        if (i.name === name) n += i.count
      }
      return n
    } catch (e) { return 0 }
  }

  /** 背包快照（物品名 -> 数量） */
  snapshotInv () {
    const out = {}
    try {
      for (const i of this.bot.inventory.items()) {
        out[i.name] = (out[i.name] || 0) + i.count
      }
    } catch (e) {}
    return out
  }

  contextForTask () {
    // ===== 视觉：让他真的看见地形，不是我替他总结 =====
    // 地形剖面图比文字描述有用得多：一眼能看出前方通不通、头顶有没有石头
    let world = ''
    try {
      // range 按场景自适应：地面 5（省 127 字符），洞里 6（断头路要早看见）
      // 实测见 actions.js 的 lookAround3D 注释
      world = this.actions.lookAround3D(this.actions.pickRange())
    } catch (e) {
      this.log('[vision] ' + e.message)
      // 视觉失败就退回文字感知
      try {
        world = this.perceive ? this.perceive.snapshot({ radius: 16 }) : ''
      } catch (e2) {}
    }

    // 四个方向能不能走（直接给出结论，省得他看图算）
    try {
      const dirs = [['东', 1, 0], ['西', -1, 0], ['南', 0, 1], ['北', 0, -1]]
      const walks = dirs.map(([n, dx, dz]) => {
        const r = this.actions.canWalkTo(dx, dz)
        return `${n}${r.walkable ? '能走' + (r.needDig ? '（要挖' + r.needDig + '格）' : '') : '走不通（' + r.reason + '）'}`
      })
      world += '\n【四个方向】' + walks.join('，')
    } catch (e) {}

    const s = this.actions.status()
    const recalled = this.mem.remember(s.pos.x + ',' + s.pos.z, { limit: 4 })

    const extra = []
    if (s.food < 18) extra.push('注意：饱食度低于 18 不会回血，先解决吃的')
    if (s.health < 10) extra.push('注意：血很低，先保证安全')
    if (recalled.length) extra.push('想起：' + recalled.map(e => e.text).join('；'))

    // 这个服有哪些玩法
    let pluginHint = ''
    try {
      pluginHint = this.plugin ? this.plugin.prompt() : ''
    } catch (e) {}

    // 自我状态：永远是第一优先（镐子还在不在比地形更重要）
    let selfBlock = ''
    try {
      selfBlock = this.selfState ? this.selfState.prompt() : ''
    } catch (e) {
      this.log('[self] ' + e.message)
    }

    // 家在哪：他得知道"走远了该往回走"，而不是就地开荒
    let homeBlock = ''
    try {
      if (this.home) {
        homeBlock = this.home.summary()
        // 家附近有什么资源 —— findNearHome() 之前写好了但没人调，
        // 挖矿永远以脚底下为中心找，家附近有矿他也看不见。
        // 这里只是把情报摆到他眼前，挖矿逻辑本身没动（那是 dig-owner 的地盘）。
        let res = ''
        try { res = this.home.homeResourceHint() } catch (e) {}
        if (res) homeBlock += '\n' + res
      }
    } catch (e) {
      this.log('[home] ' + e.message)
    }

    // 长期目标：这一步是整件事的第几步、要去哪弄。
    //
    // 【补接】之前 promptBlock() 写好了但从来没人调 ——
    // 长期目标只通过 will.current() 传了一句任务文本过去，
    // 「这是第 2/4 步」「去哪弄」「这件事是一天天攒出来的」全丢了。
    // 结果他每轮都像第一次干这事，看不出进度，也不知道方向。
    let goalBlock = ''
    try {
      goalBlock = this.goals ? this.goals.promptBlock() : ''
    } catch (e) {
      this.log('[goals] ' + e.message)
    }

    return (selfBlock ? selfBlock + '\n\n' : '') +
      (goalBlock ? goalBlock + '\n\n' : '') +
      (homeBlock ? '## 家\n' + homeBlock + '\n\n' : '') +
      world + '\n' + extra.join('\n') + (pluginHint ? '\n' + pluginHint : '')
  }

  dumpCode (goal, code, attempt) {
    try {
      const dir = path.join(DATA, 'code')
      fs.mkdirSync(dir, { recursive: true })
      const f = path.join(dir, `${Date.now()}_${attempt}.js`)
      fs.writeFileSync(f, '// ' + goal + '\n' + code, 'utf8')
      this.log('[code] ' + f)
    } catch (e) {}
  }

  // ==================== 生存 ====================

  checkSurvival () {
    const bot = this.bot
    if (!bot.entity) return null
    const pos = bot.entity.position

    if (pos.y < -50) return 'void'
    if (bot.entity.isInLava) return 'lava'
    if (bot.entity.isInWater && bot.oxygenLevel !== undefined && bot.oxygenLevel < 8) return 'drowning'

    // 卡在方块里（只看真正挡人的）
    const feetB = bot.blockAt(pos)
    const headB = bot.blockAt(pos.offset(0, 1, 0))
    const blocks = (b) => {
      if (!b) return false
      if (b.name === 'air' || b.name === 'cave_air') return false
      if (b.boundingBox === 'empty') return false
      return true
    }
    if (blocks(feetB) || blocks(headB)) return 'suffocate'

    // in_wall/cramming 只有当血真的在掉、而且周围确实有方块时才算
    if (this.lastDamageKind === 'in_wall' || this.lastDamageKind === 'cramming') {
      this.lastDamageKind = null
      if (this.busy) return null          // 正在干活，多半是挖掘产生的误报
      if (bot.health > (this._lastHealth || 20) - 0.5) return null  // 没掉血，不是真卡
      if (blocks(feetB) || blocks(headB)) return 'suffocate'
      return null
    }

    if (bot.entity.onFire) return 'fire'
    const below = bot.blockAt(pos.offset(0, -1, 0))
    if (below && below.name === 'lava') return 'lava'

    // 血量骤降记一下（用来事后开口）
    if (this._lastHealth != null && bot.health < this._lastHealth - 6) {
      if (this.spont) {
        this.spont.push(require('./src/spontaneous').onNearDeath(
          this.lastDamageKind ? this.lastDamageKind + ' 伤害' : '被打了'
        ))
      }
    }
    this._lastHealth = bot.health

    // 只有真的快死了才算紧急。饱食度低但血还够，让他自己去干活顺便找吃的
    if (bot.health <= 6) return 'lowhp'
    return null
  }

  /**
   * 做完一件事：问他爽不爽，然后长进品味里。
   * 这是偏好"自己长出来"的唯一来源。
   */
  async judgeAndGrow (task, outcome) {
    if (!this.taste || !this.mood) return
    const kinds = classify(task)
    if (!kinds.length) return   // 归不了类的不记

    const v = await judgeFeeling(this.llm, {
      what: task,
      outcome,
      mood: this.mood.describe(),
      tasted: this.taste.likes().concat(this.taste.dislikes)
    })
    if (!v) return

    this.taste.record({
      what: `${task}（${v.why || outcome}）`,
      kinds,
      feeling: v.feeling,
      now: this.mem.clock.now()
    })
    this.log(`[taste] ${task} -> 感觉 ${v.feeling.toFixed(2)} ${v.why || ''}`)

    // 记住这次体验（重要的才记）
    if (Math.abs(v.feeling) > 0.6) {
      this.mem.add({
        text: `${task}，感觉${v.feeling > 0 ? '挺爽' : '有点烦'}${v.why ? '：' + v.why : ''}`,
        kind: 'fact',
        importance: 0.6,
        emotion: Math.abs(v.feeling)
      })
    }
  }

  /** 心情/品味随时间推进 */
  tickInnerState () {
    const now = Date.now()
    if (!this._lastInnerTick) this._lastInnerTick = now
    const deltaMin = (now - this._lastInnerTick) / 60000
    if (deltaMin < 0.5) return
    this._lastInnerTick = now
    try {
      if (this.mood) this.mood.tick(deltaMin)
      if (this.taste) this.taste.decay(this.mem.clock.now())
    } catch (e) {}
    try { this.noteLateNight() } catch (e) {}
  }

  /**
   * 夜深了，提一句时间。
   *
   * 【2026-11-13 UNHUMAN-SCAN #11】
   *   [04:00:21] [hb] 心情:good
   *   [04:01:19] 还在挖矿
   * 10 次心跳全 good，全程一句没提"这么晚了"。
   *
   * 原因很简单：spontaneous.js 里 onLateNight() 逻辑完整，
   * 判断 isVeryLate、算概率、给话术都写好了 —— **但全项目 0 次调用**。
   * 写好了没人用，等于没写。
   *
   * 这里每 10 分钟看一次，符合条件就攒一个"想说话"的念头。
   * 为什么不每轮都看：凌晨一直在游戏里，每轮都提一次"几点了"会变成复读机。
   */
  noteLateNight () {
    const now = Date.now()
    // 10 分钟一次就够。onLateNight 内部还有自己的概率，叠起来不会太吵
    if (now - (this._lastLateNightAt || 0) < 10 * 60 * 1000) return
    this._lastLateNightAt = now

    let t = null
    try { t = require('./src/realtime').realTime() } catch (e) { return }
    // 【凌晨 5-8 点不该说「该睡了」】2026-11-14
    //
    // final-checker 抓到的：
    //   [06:21:48] [say] 六点多了 天都亮了 得睡了
    // 同一句里"天都亮了"和"得睡了"自相矛盾。
    // `isEarlyMorning` 是 5-8 点，那时候天亮了 —— 真人这时候说的是
    // "一宿没睡"或者"天都亮了赶紧收拾收拾"，不是"该睡了"。
    if (!t || !(t.isLate || t.isEarlyMorning)) return

    const ev = spontaneous.onLateNight()
    if (!ev) return

    // 【2026-11-13 修 · UNHUMAN-SCAN #11 接上之后实测的第二个坑】
    //
    // 第一版是 `this.spont.push(ev)` 交给队列。凌晨实测他整局都在干活，
    // 而 spont.tick 对非社交/非吐槽事件有一条 `if (busy) return false` ——
    // 于是"几点了"这条念头每一轮都被忙挡掉，队列 120 秒后再判定过期。
    // 也就是说：接上了调用，话还是说出口不了。
    //
    // 时间这件事不像"挖到铁矿"，它不需要抽离任务才能说 ——
    // 人边挖边嘀咕一句"卧槽四点了"是常态。所以这里直接开口。
    const chance = t.isVeryLate ? 0.55 : 0.35
    this.log(`[time] ${t.clock} 夜深了，想提一句（p=${chance}）`)
    if (this.talk && Math.random() < chance) {
      this.talk.speak(ev.situation, {
        maxLen: ev.maxLen || 25,
        minGap: 20000,
        extraHint: t.isLate
          ? '提一句现在几点了/该睡了。随口一句，别像报告时间，也别拿这个当借口长篇大论。'
          : '提一句天亮了/一宿没睡。随口一句，别像报告时间，也别说"该睡了"（天都亮了）。'
      }).then(ok => {
        this.log(ok ? `[time] 说了：${t.clock}` : '[time] 这轮没说')
      }).catch(() => {})
    }
    // 队列里也留一份：万一这轮开口被别的事挤掉，下一轮还有机会
    this.spont.push(ev)
  }

  /** 背包快照 */
  snapshotInventory () {
    const out = {}
    try {
      for (const i of this.bot.inventory.items()) out[i.name] = (out[i.name] || 0) + i.count
    } catch (e) {}
    return out
  }

  /** 对比上次快照，发现新收获就攒个念头 */
  checkNewLoot () {
    if (!this.spont) return
    const now = this.snapshotInventory()
    const prev = this.lastInventory || {}
    for (const [name, count] of Object.entries(now)) {
      const gained = count - (prev[name] || 0)
      if (gained <= 0) continue
      const ev = spontaneous.onValuableFind(name, gained)
      if (ev) this.spont.push(ev)
    }
    this.lastInventory = now
  }

  async doSurvive (why) {
    // 找吃的本身需要动作能力，不能把 cancel 设成 true
    const needCancel = why !== 'lowhp'
    if (needCancel) this._signalCancel('自救：' + why)
    // 逃命压过一切（rank 100）。home 还在走的话先把它按下去（goHome 每段都会看 cancel），
    // 否则两条线同时抢 pathfinder —— 那正是「107 → 105 → 107」的形状。
    if (this.lock.isHolding(REASON.HOME) && this.home) {
      try { this.home.stop() } catch (e) {}
    }
    this.lock.acquire(REASON.SURVIVE, '自救：' + why)
    try {
      await this._survive(why)
    } finally {
      if (this.lock.isHolding(REASON.SURVIVE)) this.lock.release(REASON.SURVIVE)
      if (this.actions) this.actions.cancel = false
    }
  }

  async _survive (why) {
    const bot = this.bot

    if (why === 'lava' || why === 'fire') {
      this.log('[survive] 泡在岩浆/火里，往上爬')
      for (let i = 0; i < 20 && (bot.entity.isInLava || bot.entity.onFire); i++) {
        bot.setControlState('jump', true)
        bot.setControlState('forward', true)
        await sleep(250)
      }
      bot.setControlState('jump', false)
      bot.setControlState('forward', false)
      try { await this.actions.wander(10) } catch (e) {}
      return
    }

    if (why === 'water' || why === 'drowning') {
      this.log('[survive] 在水里/憋气，先浮上去')
      const dir = ['forward', 'left', 'right'][Math.floor(Math.random() * 3)]
      bot.setControlState('jump', true)
      bot.setControlState(dir, true)
      for (let i = 0; i < 40; i++) {
        if ((bot.oxygenLevel === undefined || bot.oxygenLevel >= 20) && !bot.entity.isInWater) break
        await sleep(200)
        if (i % 10 === 9) {
          bot.setControlState(dir, false)
          const d2 = ['forward', 'back', 'left', 'right'][Math.floor(Math.random() * 4)]
          bot.setControlState(d2, true)
        }
      }
      for (const k of ['jump', 'forward', 'back', 'left', 'right']) bot.setControlState(k, false)
      return
    }

    if (why === 'suffocate') {
      this.log('[survive] 卡在方块里，挣脱')
      const pos = bot.entity.position
      let freed = false
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const t = pos.offset(dx, 0, dz)
        const feetB = bot.blockAt(t)
        const headB = bot.blockAt(t.offset(0, 1, 0))
        const free = (b) => b && (b.name === 'air' || b.boundingBox === 'empty')
        if (free(feetB) && free(headB)) {
          try {
            await bot.look(Math.atan2(-dx, dz), 0, true)
            bot.setControlState('forward', true)
            await sleep(700)
            bot.setControlState('forward', false)
            freed = true
            break
          } catch (e) {}
        }
      }
      if (!freed) {
        try {
          const head = bot.blockAt(pos.offset(0, 1, 0))
          if (head && head.name !== 'air') await bot.dig(head)
        } catch (e) {}
      }
      bot.setControlState('jump', true)
      await sleep(500)
      bot.setControlState('jump', false)
      return
    }

    if (why === 'void') {
      this.log('[survive] 掉虚空了')
      return
    }

    if (why === 'lowhp') {
      // 饱食度够（>=18）就会自然回血，只要没怪，等着就行
      if (bot.food >= 18 && bot.health > 0) {
        const near0 = this.reflex ? this.reflex.nearestHostile(10) : null
        if (near0) {
          this.reflex.flee(near0)
          await sleep(4000)
          return
        }
        this.log('[survive] 吃饱了，等回血（' + Math.round(bot.health) + '/20）')
        // 找个安全地方待着
        await sleep(15000)
        return
      }
      if (this.actions.hasFood()) {
        const ate = await this.actions.eat().catch(() => null)
        if (ate) {
          this.log('[survive] 吃了 ' + ate + '，饱食度 ' + Math.round(bot.food))
          await sleep(2500)
          return
        }
      }
      const near = this.reflex ? this.reflex.nearestHostile(12) : null
      if (near) {
        this.log('[survive] 附近有怪，先躲开')
        this.reflex.flee(near)
        await sleep(5000)
        return
      }
      // 找吃的加冷却，别 4 秒一次狂刷
      const now = Date.now()
      if (!this._foodCooldownUntil) this._foodCooldownUntil = 0
      if (now >= this._foodCooldownUntil && !this.seekingFood) {
        this.seekingFood = true
        this.log('[survive] 没吃的，去找点吃的')
        try {
          // 先在附近找，找不到就走远一点再找
          let got = await this.actions.findFood()
          if (!got) {
            this.log('[survive] 附近没有，走远点')
            try { await this.actions.wander(40) } catch (e) {}
            await this.actions.ensureChunks(4000)
            got = await this.actions.findFood()
          }
          this.log('[survive] 找吃的：' + (got || '还是没有'))
        } catch (e) {
          this.log('[survive] 找吃的出错: ' + e.message)
        }
        this.seekingFood = false
        this._foodCooldownUntil = Date.now() + 30000   // 30 秒内不再试
        return
      }
      this.log('[survive] 血少，原地歇会儿')
      await sleep(10000)
    }
  }

  // ==================== 退出 ====================

  shutdown () {
    this.running = false
    if (this.reflex) this.reflex.stop()
    if (this.clockTimer) clearInterval(this.clockTimer)
    try { this.mem.goOffline() } catch (e) {}
    try { this.bot.quit() } catch (e) {}
  }
}

function wishFailText (goal, err) {
  const e = String(err || '').slice(0, 60)
  return `教训：${goal} 没成（${e}）`
}

function extractTags (text) {
  const tags = []
  const map = {
    挖: ['mine', '挖矿'], 矿: ['mine'], 铁: ['iron'], 钻: ['diamond'], 石: ['stone'],
    树: ['wood', 'tree'], 木: ['wood'], 砍: ['chop'],
    盖: ['build'], 屋: ['house', 'build'], 房: ['house', 'build'],
    打: ['fight'], 怪: ['mob'],
    合成: ['craft'], 做: ['craft'], 镐: ['pickaxe'], 剑: ['sword'],
    烧: ['smelt'], 熔: ['smelt'], 吃: ['eat'], 饿: ['food'],
    箱: ['chest'], 存: ['chest'],
    走: ['move'], 看: ['explore'], 找: ['find'], 村: ['village']
  }
  for (const [k, v] of Object.entries(map)) {
    if (text.includes(k)) tags.push(...v)
  }
  return Array.from(new Set(tags))
}

// ==================== 启动 ====================

function main () {
  let cfg
  try {
    cfg = loadConfig()
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }

  // ===== 数据目录 =====
  // 不设 AIFRIEND_DATA 就用默认目录。跑一个 AI 没事；跑多个必然互相覆盖记忆，
  // 所以这里必须喊一嗓子 —— 之前是静默的，谁都不知道自己在共用目录。
  if (!process.env.AIFRIEND_DATA) {
    console.log('[启动] 没设 AIFRIEND_DATA，用默认目录 data/runtime')
    console.log('       跑多个 AI 时必须各自设一个，否则会互相覆盖记忆')
  }

  // ===== 实例锁：一个数据目录只允许一个进程 =====
  // memory.json 是整文件覆盖，两个实例同目录 = 后写的把前一个的记忆吞掉，且不报错。
  // 所以宁可拒绝启动，也不能让它悄悄跑。
  const lock = InstanceLock.acquire(DATA, { username: cfg.bot.username })
  if (!lock.ok) {
    const e = lock.existing
    if (e && e.pid) {
      console.error(`[启动] 这个数据目录已经有一个实例在跑（pid ${e.pid}，起于 ${e.atText}）`)
      console.error('       要么关掉它，要么用 AIFRIEND_DATA 换个目录')
    } else {
      console.error('[启动] 这个数据目录的实例锁建不上（' + (lock.error || '锁文件被占用') + '）')
      console.error('       要么等一会儿重试，要么用 AIFRIEND_DATA 换个目录')
    }
    process.exit(1)
  }
  console.log(`[启动] 数据目录 ${path.relative(ROOT, DATA) || DATA}（实例锁已拿到，pid ${process.pid}）`)

  const b = new Bot(cfg)

  process.on('SIGINT', () => { b.shutdown(); process.exit(0) })
  process.on('SIGTERM', () => { b.shutdown(); process.exit(0) })
  process.on('uncaughtException', (e) => {
    const msg = e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)
    console.log('[fatal] ' + msg)
    // 别让这类断言错误把整个进程干掉
    if (/Invalid itemType|AssertionError/.test(msg)) {
      console.log('[fatal] 这是 mineflayer 内部断言，忽略继续跑')
      return
    }
  })

  b.connect()
}

if (require.main === module) main()

module.exports = { Bot }
