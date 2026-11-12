# 寻路问题证据

## 现象

机器人反复出现 `[goto] 走不通了（差 5.1~8.0 格）`，目标就在眼前但走不过去。
3 分钟内 11 次失败。

## 实测数据（两次诊断结果矛盾）

### 第一次诊断（02:11）
```
位置 (66.5, 46, -90.7) 脚下: andesite
青金石在 (74, 46, -85) 距离 9.4

路径地形采样（直线插值）：
  67,46,-91 = air (脚下 stone)
  68,46,-90 = stone (脚下 stone)       ← 实心
  68,46,-89 = andesite (脚下 andesite) ← 实心
  69,46,-89 = stone (脚下 stone)       ← 实心
  70,46,-88 = stone (脚下 stone)       ← 实心
  71,46,-88 = stone (脚下 stone)       ← 实心
  71,46,-87 = stone (脚下 stone)       ← 实心
  72,46,-87 = stone (脚下 stone)       ← 实心
  73,46,-86 = coal_ore (脚下 coal_ore) ← 实心
  74,46,-85 = lapis_ore (脚下 lapis_ore)

四种配置对比：
  默认           status=success  走了 8.1 格
  允许挖         status=success  走了 2.2 格
  允许挖+搭      status=success  走了 0.8 格
  宽松           status=?        走了 0.0 格
```

**结论：目标被实心石头包住，直线路径全是石头。**
默认配置反而走了 8.1 格（它绕路找洞），我加的"允许挖+搭"反而只走 0.8 格。

### 第二次诊断（02:13，逐项测配置）
```
baseline(纯默认)   走了 0.0 格 status=?
+canDig           走了 0.0 格 status=?
+digCost15        走了 0.0 格 status=?
+allowTowers      走了 0.0 格 status=?
+scaffolding      走了 0.0 格 status=?
+liquidCost8      走了 0.0 格 status=?
+maxDropDown8     走了 0.0 格 status=?
```

**全是 0，status 一直没更新。** 说明这个诊断脚本本身有问题（可能 bot 刚 spawn 位置不对，或者 path_update 事件没触发）。

## 现在的配置（main.js onSpawn）

```js
const moves = new Movements(bot)
moves.canDig = true
moves.digCost = 15
moves.allow1by1towers = true
moves.scafoldingBlocks = [
  bot.registry.itemsByName.dirt.id,
  bot.registry.itemsByName.cobblestone.id,
  bot.registry.itemsByName.gravel.id
].filter(x => x != null)
moves.canOpenDoors = true
moves.liquidCost = 8
moves.maxDropDown = 8
bot.pathfinder.setMovements(moves)
```

## 现状的 goto 实现（src/actions.js）

```js
async goto (x, y, z, range = 1, timeoutMs = 30000) {
  this.check()
  this.current = `走到 ${...}`

  const p0 = this.pos()
  const dy = Math.abs(y - p0.y)

  // 目标跟自己不在同一层：先解决高度差
  if (dy > 3) {
    const reached = await this.gotoVertical(y, timeoutMs)
    if (!reached) return false
  }

  const goal = new goals.GoalNear(...)
  this.bot.pathfinder.setGoal(goal)

  // 循环检查：
  // 1. 自己算距离，够近就 return true
  // 2. pathfinder.isMoving() === false 就等 200ms 再确认，停住了就 return false
  // 3. 连续 6 秒没挪窝就 return false
}
```

## 已知的可疑点

1. `moves.liquidCost = 8` 比默认低很多，可能让寻路优先走水路（然后淹死）
2. `moves.maxDropDown = 8` 允许从 8 格高跳下去（会摔死）
3. 目标被石头包住时，`canDig: true` 应该能挖过去，但实测只走 0.8 格
4. 两次诊断结果矛盾，说明诊断方法本身不可靠
