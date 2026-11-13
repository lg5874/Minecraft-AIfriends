'use strict'
// #8 修技能库里"结尾无条件 return 成功文案"的技能。
//
// 为什么不是简单删掉：
//   这些技能体本身是有用的（挖/做/找的判断都在），坏的只是**最后一句汇报**。
//   删掉等于把"这条路走通过"一起丢了；改成"没达标就说没达标"更值。
//
// 硬要求：返回的失败文案必须是 judgeOutcome 认得的词
//   （main.js judgeOutcome 里有 /还差|没凑齐|材料不够/ 这一条），
//   否则技能自己诚实了，判据还是看不懂，白改。
//
// 用法：node scripts/repair-fake-skills.js [--dry]

const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'data', 'runtime', 'skills.json')
const DRY = process.argv.includes('--dry')

const REPAIRS = {
  // 「先弄把铁镐」：复用 50 次，一次铁锭都没产出，却因为"圆石148"被判有产出。
  // 结尾把**存量**当成果汇报，且无条件执行。这是被点名的那条。
  k_mwe60wh8: {
    find: "return '冲铁镐: 铁锭' + actions.countOf('iron_ingot') + ' 生铁' + actions.countOf('raw_iron') + ' 圆石' + actions.countOf('cobblestone')",
    replace: `// 【#8】原来这句无条件返回库存，铁锭 0 也照说，而判据会拿"圆石148"当产出。
// 现在没做出铁镐就明说没做成（含"还差"，judgeOutcome 的否决权认这个词）
if (!actions.item('iron_pickaxe')) {
  return '冲铁镐: 铁锭' + actions.countOf('iron_ingot') + ' 生铁' + actions.countOf('raw_iron') +
    ' 圆石' + actions.countOf('cobblestone') + '，铁镐没做出来，还差材料'
}
return '做了一把铁镐，铁锭' + actions.countOf('iron_ingot') + ' 生铁' + actions.countOf('raw_iron')`
  },

  // 「铺路面」：一块没铺上去也说"铺平了 0 处"
  k_mwdx6wfo: {
    find: "return '在庇护所门口用圆石铺平了 ' + paved + ' 处路面，还剩圆石 ' + actions.countOf('cobblestone') + ' 块，手上拿好石镐'",
    replace: `// 【#8】一块都没铺上也照样说"铺平了"，改成先看实际铺了几处
if (!paved) {
  return '门口一块都没铺上，还差，先不铺了（圆石 ' + actions.countOf('cobblestone') + ' 块）'
}
return '在庇护所门口用圆石铺平了 ' + paved + ' 处路面，还剩圆石 ' + actions.countOf('cobblestone') + ' 块，手上拿好石镐'`
  },

  // 「沿途插火把做路标」：placed=0 时说"沿0个方向插了0个火把…记下了来路"
  k_mwe780yp: {
    find: "return '沿' + placed + '个方向插了' + placed + '个火把做路标，记下了来路，剩下火把' + actions.countOf('torch') + '个'",
    replace: `// 【#8】一个火把都没插成，却说"记下了来路"。没插成就是没插成
if (!placed) {
  return '想沿路插火把做路标，但一个都没插成，还差火把（剩 ' + actions.countOf('torch') + ' 个）'
}
return '沿' + placed + '个方向插了' + placed + '个火把做路标，记下了来路，剩下火把' + actions.countOf('torch') + '个'`
  },

  // 「带上吃的和火把再出门」：42 次使用，结尾永远说"收拾好了"
  k_mwe6vrg3: {
    find: "return '收拾好了：食物' + foodCount + '个，火把' + torchNow + '个，血' + bot.health + '/饱食' + bot.food + '，可以出门了'",
    replace: `// 【#8】原来这里无条件 return "收拾好了…可以出门了"，
// 没吃的没火把也这么说。改成按实际数量汇报，没带齐就明说"还差"
if (foodCount < 4 || torchNow < 4) {
  return '没带齐：食物' + foodCount + '个，火把' + torchNow + '个，还差，先别出门'
}
return '收拾好了：食物' + foodCount + '个，火把' + torchNow + '个，血' + bot.health + '/饱食' + bot.food + '，可以出门了'`
  }
}

function main () {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const list = raw.skills || []
  let n = 0
  for (const sk of list) {
    const r = REPAIRS[sk.name]
    if (!r) continue
    if (!sk.code.includes(r.find)) {
      console.log(`跳过 ${sk.name}：已不是原来的结尾（可能已修或被改过）`)
      continue
    }
    const before = sk.code
    sk.code = sk.code.replace(r.find, r.replace)
    // 代码变了，指纹和代码分析必须一起更新，否则去重/适用性判断还按老代码走
    const crypto = require('crypto')
    sk.codeHash = crypto.createHash('sha1').update(sk.code).digest('hex')
    sk.codeSig = null          // 下次 load 时 migrate 会重算（signature 变了，去重才对）
    sk.analysis = null
    sk.repairedAt = Date.now()
    sk.repairedFor = '#8 无条件成功文案'
    n++
    console.log(`修好 ${sk.name}：${sk.desc}`)
    console.log(`  结尾已改成按实际数量判断（没带齐 -> 含"还差"，judgeOutcome 认得）`)
    if (DRY) sk.code = before
  }
  if (n && !DRY) {
    raw.stats = raw.stats || {}
    raw.stats.fakeSuccessRepaired = (raw.stats.fakeSuccessRepaired || 0) + n
    fs.writeFileSync(FILE, JSON.stringify(raw, null, 1), 'utf8')
    console.log(`\n写回 ${n} 个技能`)
  } else if (!n) {
    console.log('没有需要修的技能')
  }
}

if (require.main === module) main()
