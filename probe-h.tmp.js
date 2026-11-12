'use strict'
process.env.AIFRIEND_DATA='data/runtime/integrator6'
process.env.AIFRIEND_CONFIG='config.integrator.json'
const path=require('path'),fs=require('fs'),Vec3=require('vec3').Vec3
const root=__dirname
const cfg=JSON.parse(fs.readFileSync(path.join(root,'config.integrator.json'),'utf8'))
cfg.bot.username='XJJHOME6'
const { Bot }=require(path.join(root,'main.js'))
const b=new Bot(cfg)
b.onSpawn=async function(){
  await Object.getPrototypeOf(b).onSpawn.call(this)
  setTimeout(async()=>{
    const p=this.bot.entity.position
    const tx=Math.round(p.x)+75, tz=Math.round(p.z)+75
    let ty=null
    for(let y=120;y>20;y--){const blk=this.bot.blockAt(new Vec3(tx,y,tz));if(blk&&blk.boundingBox==='block'){ty=y+1;break}}
    this.home.setHome({x:tx,y:ty,z:tz},'测试家')
    this.busy=false; this.taskDesc=''
    if(this.actions) this.actions.cancel=true
    try{this.bot.pathfinder.setGoal(null)}catch(e){}
    console.log('★ 家',tx,ty,tz,'| 出生',p.x.toFixed(1),p.y.toFixed(1),p.z.toFixed(1),'| 距离',this.home.hDistanceFromHome().toFixed(1))
    const t0=Date.now()
    await this.tryGoHomeAfterRespawn()
    console.log('★ 结果：离家',this.home.hDistanceFromHome().toFixed(1),'格，用时',Math.round((Date.now()-t0)/1000),'s')
    console.log('★ stats',JSON.stringify(this.home.stats))
    process.exit(0)
  },5000)
}
b.connect()
setTimeout(()=>{console.log('★ TIMEOUT');process.exit(2)},240000)
