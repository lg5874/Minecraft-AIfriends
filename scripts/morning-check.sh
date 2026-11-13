#!/bin/bash
# 明早检查：一条命令跑完清单里的六项，直接给结论。
#
# 用法：
#   bash scripts/morning-check.sh
#
# 它只读，不改任何东西。看完自己决定动哪条（清单第五节的五条条件式）。
#
# 【为什么要有】07:30 那个窗口很窄，翻十六节清单会手忙脚乱。
# 这个脚本把「现在到底是什么状态、要不要干预」压缩成一次输出。

set -u
ROOT="/root/workspace/minecraft-AIfriend"
cd "$ROOT" || { echo "进不去 $ROOT"; exit 1; }

LOG="data/runtime/supervisor.log"
echo "════════════════════════════════════════════"
echo " 明早检查  $(date '+%Y-%m-%d %H:%M:%S')"
echo "════════════════════════════════════════════"

# ---------- 1. 进程 ----------
echo ""
echo "【1】进程"
if ps -p "$(cat /tmp/xjj-daemon.pid 2>/dev/null || echo 0)" >/dev/null 2>&1; then
  echo "  守护：✅ 在跑（pid $(cat /tmp/xjj-daemon.pid)）"
else
  echo "  守护：❌ 没在跑   -> bash scripts/daemon.sh start"
fi
NBOT=$(for f in /proc/[0-9]*/cmdline; do c=$(tr '\0' ' ' < "$f" 2>/dev/null); case "$c" in "node main.js"*) echo x;; esac; done 2>/dev/null | wc -l)
if [ "$NBOT" -ge 1 ]; then echo "  bot： ✅ $NBOT 个"; else echo "  bot： ❌ 没在跑   -> bash scripts/daemon.sh start"; fi

# ---------- 2. 位置 / 血 / 饿 ----------
echo ""
echo "【2】他现在的状态"
HB=$(grep "\[hb\]" "$LOG" 2>/dev/null | tail -1)
if [ -z "$HB" ]; then
  echo "  ❌ 日志里没有心跳（bot 可能刚重启）"
else
  echo "  $HB"
  X=$(echo "$HB" | grep -oE "\-?[0-9]+,\-?[0-9]+,\-?[0-9]+" | head -1 | cut -d, -f1)
  Y=$(echo "$HB" | grep -oE "\-?[0-9]+,\-?[0-9]+,\-?[0-9]+" | head -1 | cut -d, -f2)
  HP=$(echo "$HB" | grep -oE "血[0-9]+" | grep -oE "[0-9]+")
  FD=$(echo "$HB" | grep -oE "饿[0-9]+" | grep -oE "[0-9]+")
  echo "  → 高度 y=$Y   血=$HP   饿=$FD"
fi

# ---------- 3. 嘴通不通 ----------
echo ""
echo "【3】嘴通不通（最近 15 分钟）"
RECENT=$(tail -400 "$LOG" 2>/dev/null | grep -c "\[say\]")
if [ "$RECENT" -gt 0 ]; then
  echo "  ✅ 最近 400 行里有 $RECENT 句"
  tail -400 "$LOG" 2>/dev/null | grep "\[say\]" | tail -3 | sed 's/^/     /'
else
  echo "  ⚠️  最近 400 行里一句都没有"
fi
BLOCKED=$(grep -cE "instruction leak blocked|meta leak blocked|machine talk blocked" "$LOG" 2>/dev/null)
SAID=$(grep -c "\[say\]" "$LOG" 2>/dev/null)
echo "  拦截 $BLOCKED 次 / 说出口 $SAID 句"

# ---------- 4. 在干什么 ----------
echo ""
echo "【4】在干什么"
grep -E ">>> 开始|<<< " "$LOG" 2>/dev/null | tail -3 | sed 's/^/  /'

# ---------- 5. 心情 ----------
echo ""
echo "【5】心情"
node -e "
try{
  const m=require('./data/runtime/mood.json');
  const e=(m.energy||0).toFixed(2), i=(m.irritation||0).toFixed(2);
  console.log('  energy', e, '| irritation', i, '| resting', m.resting);
}catch(err){ console.log('  读不了 mood.json') }
" 2>/dev/null

# ---------- 6. 判断 ----------
echo ""
echo "════════════════════════════════════════════"
echo " 结论（清单第五节：只有这些情况才动手）"
echo "════════════════════════════════════════════"
ADVICE=0
if [ "$NBOT" -lt 1 ] || ! ps -p "$(cat /tmp/xjj-daemon.pid 2>/dev/null || echo 0)" >/dev/null 2>&1; then
  echo "  ❌ 进程不在        -> bash scripts/daemon.sh start"; ADVICE=1
fi
if [ -n "${Y:-}" ] && [ "$Y" -lt 50 ] 2>/dev/null; then
  echo "  ⚠️  在地下 y=$Y      -> 等天亮（修复 10 会自动爬出来）或按清单第九条调 energy"; ADVICE=1
fi
if [ -n "${HP:-}" ] && [ "$HP" -le 5 ] 2>/dev/null; then
  echo "  ⚠️  血 $HP ≤ 5       -> 他不接新任务（设计如此），等他回血或给吃的"; ADVICE=1
fi
if [ -n "${FD:-}" ] && [ "$FD" -eq 0 ] 2>/dev/null && [ -n "${HP:-}" ] && [ "$HP" -le 10 ] 2>/dev/null; then
  echo "  ⚠️  饿0+血≤10       -> 按清单第十一条：调 energy 到 0.8 让他动起来→掉血→死→重生满血"; ADVICE=1
fi
if [ "$RECENT" -eq 0 ]; then
  echo "  ⚠️  最近没说话      -> 先看是不是在 rest/躲夜（那是对的），别急着改"; ADVICE=1
fi
[ "$ADVICE" -eq 0 ] && echo "  ✅ 一切正常 —— 【什么都不做】（清单第五节：正常在干活就别碰）"
echo ""
echo "完整清单：docs/MORNING-CHECKLIST.md"
echo "夜账：    docs/NIGHT-SUMMARY.md"
