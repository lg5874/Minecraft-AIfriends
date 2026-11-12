const mineflayer=require('mineflayer')
const {pathfinder,Movements,goals}=require('mineflayer-pathfinder')
const cfg=require('./config.json')
const bot=mineflayer.createBot({host:cfg.bot.host,port:cfg.bot.port,username:'XJJ',auth:'offline',version:'1.21.11',hideErrors:true})
bot.loadPlugin(pathfinder)
bot.once('spawn',async()=>{
  await bot.waitForChunksToLoad()
  await new Promise(r=>setTimeout(r,2000))
  const p=bot.entity.position.clone()
  console.log('起点', `${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}`)

  // 关键：让 pathfinder 允许挖，并且允许搭方块（往上爬必须能搭）
  const m=new Movements(bot)
  m.canDig=true
  m.digCost=5                    // 挖方块代价低一点，鼓励它挖
  m.allow1by1towers=true         // 允许原地搭柱
  m.scafoldingBlocks=[
    bot.registry.itemsByName.dirt.id,
    bot.registry.itemsByName.cobblestone.id,
    bot.registry.itemsByName.andesite.id
  ].filter(Boolean)
  m.maxDropDown=4
  m.liquidCost=50
  bot.pathfinder.setMovements(m)

  // 目标：往正上方 20 格
  const target={x:Math.floor(p.x),y:Math.floor(p.y)+20,z:Math.floor(p.z)}
  console.log('目标', `${target.x},${target.y},${target.z}`, '（往正上方 20 格）')
  console.log('可搭的方块:', m.scafoldingBlocks.length, '种')

  let status='?'
  bot.on('path_update',r=>{ if(r.status) status=r.status })
  bot.pathfinder.setGoal(new goals.GoalBlock(target.x,target.y,target.z))

  for(let i=0;i<30;i++){
    await new Promise(r=>setTimeout(r,1000))
    const q=bot.entity.position
    const up=q.y-p.y
    if(i%3===0) console.log(`[${i+1}s] y=${q.y.toFixed(0)} 上升${up.toFixed(0)}格 status=${status}`)
    if(up>=18) { console.log('✅ 上去了！'); break }
  }
  const finalUp=bot.entity.position.y-p.y
  console.log(`\n最终: 上升 ${finalUp.toFixed(0)} 格`)
  bot.quit(); setTimeout(()=>process.exit(0),300)
})
bot.on('error',e=>console.log('err',e.message))
setTimeout(()=>process.exit(0),60000)
