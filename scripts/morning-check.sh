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
#
# 【2026-11-14 07:15 验收员改过的地方】（都是判据/文案，结构没动）
#   1. 血阈值：原判据「≤5 不接新任务」是**对的**（reflex.js:49 HP_CRIT=5）。
#      缺的是 6~10 这一段——原版在血 7~10 时一声不吭，而 reflex HP_FLEE=10 / HP_PANIC=8
#      已经生效、actions.js:2564 在 ≤6 会抛「血太少了得先撤」、goals.js:1444 在 ≤4 放弃目标。
#      现在按 4/5/6/8/10 五档分开提示，5 那一档保持原来的说法。
#   2. bot 数 ≥2 从 ✅ 改成 ❌ —— 多个 bot 会互踢，昨天数字就是这么污染的。
#   3. 加了「日志多久没更新」—— 进程活着但卡死时，原来的版本会把很久以前的心跳当现在。
#   4. 加了「被踢/重连」计数（明早最该看的一条，原来没有）。
#   5. 「最近 15 分钟」原来其实是 tail -400 行，与时间无关；现在真按时间戳算。
#   6. 心跳里血是 `?` 时不再当成正常，单独提一句。

set -u
ROOT="/root/workspace/minecraft-AIfriend"
cd "$ROOT" || { echo "进不去 $ROOT"; exit 1; }

LOG="${MC_LOG:-data/runtime/supervisor.log}"   # 可用 MC_LOG=... 指到别的日志做演练
echo "════════════════════════════════════════════"
echo " 明早检查  $(date '+%Y-%m-%d %H:%M:%S')"
echo "════════════════════════════════════════════"

# ---------- 1. 进程 ----------
echo ""
echo "【1】进程"
DPID=$(cat /tmp/xjj-daemon.pid 2>/dev/null || echo 0)
if ps -p "$DPID" >/dev/null 2>&1; then
  echo "  守护：✅ 在跑（pid $DPID）"
  DUP=0
else
  echo "  守护：❌ 没在跑   -> bash scripts/daemon.sh start"
  DUP=1
fi
NBOT=$(for f in /proc/[0-9]*/cmdline; do c=$(tr '\0' ' ' < "$f" 2>/dev/null); case "$c" in "node main.js"*) echo x;; esac; done 2>/dev/null | wc -l)
if [ "$NBOT" -eq 0 ]; then
  echo "  bot： ❌ 没在跑   -> bash scripts/daemon.sh start"
elif [ "$NBOT" -eq 1 ]; then
  echo "  bot： ✅ 1 个"
else
  echo "  bot： ❌ $NBOT 个同时在跑 —— 会互踢，先杀到只剩一个"
fi

# ---------- 2. 位置 / 血 / 饿 ----------
echo ""
echo "【2】他现在的状态"
HB=$(grep "\[hb\]" "$LOG" 2>/dev/null | tail -1)
HBAGE=""
if [ -z "$HB" ]; then
  echo "  ❌ 日志里没有心跳（bot 可能刚重启）"
  Y=""; HP=""; FD=""
else
  echo "  $HB"
  X=$(echo "$HB" | grep -oE "\-?[0-9]+,\-?[0-9]+,\-?[0-9]+" | head -1 | cut -d, -f1)
  Y=$(echo "$HB" | grep -oE "\-?[0-9]+,\-?[0-9]+,\-?[0-9]+" | head -1 | cut -d, -f2)
  HP=$(echo "$HB" | grep -oE "血[0-9]+" | grep -oE "[0-9]+")
  FD=$(echo "$HB" | grep -oE "饿[0-9]+" | grep -oE "[0-9]+")
  echo "  → 高度 y=$Y   血=${HP:-?}   饿=${FD:-?}"
fi

# ---------- 2b. 日志新鲜度 ----------
LASTTS=$(grep -oE "^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\]" "$LOG" 2>/dev/null | tail -1 | tr -d '[]')
if [ -n "${LASTTS:-}" ]; then
  # 【2026-11-14 08:43 修】原来用 $(( $(date +%H) * 3600 ... ))，
  # `date +%H` 在 8 点返回 "08"，bash 的 $(( )) 把它当八进制 -> "08: value too great for base"。
  # 07:59 之前正常、08:00 一到就每次都报错（时间炸弹）。
  # 现在整段不碰手写算术：把日志时间戳交给 date 解析成纪元秒再相减。
  LSE=$(date -d "$(date +%F) $LASTTS" +%s 2>/dev/null)
  if [ -z "${LSE:-}" ]; then
    echo "  ⚠️  解析不了日志时间戳：$LASTTS"
    LASTTS=""
  else
    HBAGE=$(( $(date +%s) - LSE ))
    [ "$HBAGE" -lt 0 ] && HBAGE=$(( HBAGE + 86400 ))
  fi
  if [ "$HBAGE" -gt 300 ]; then
    echo "  ❌ 日志已经 $(( HBAGE / 60 )) 分钟没更新（最后一条 $LASTTS）—— 进程可能在但卡死了"
  else
    echo "  ✅ 日志 ${HBAGE} 秒前还在写"
  fi
else
  echo "  ⚠️  读不到日志时间戳"
fi

# ---------- 3. 嘴通不通 ----------
echo ""
echo "【3】嘴通不通（最近 15 分钟，按时间戳算）"
RECENT=$(awk -v now="$(date +%H:%M:%S)" '
  /^\[[0-9][0-9]:[0-9][0-9]:[0-9][0-9]\]/ {
    ts=substr($0,2,8);
    t=(substr(ts,1,2)*3600 + substr(ts,4,2)*60 + substr(ts,7,2));
    n=(substr(now,1,2)*3600 + substr(now,4,2)*60 + substr(now,7,2));
    d=n-t; if (d<0) d+=86400;
    if (d<=900 && /\[say\]/) c++;
  } END { print c+0 }' "$LOG" 2>/dev/null)
if [ "${RECENT:-0}" -gt 0 ]; then
  echo "  ✅ 最近 15 分钟说了 $RECENT 句"
  grep "\[say\]" "$LOG" 2>/dev/null | tail -3 | sed 's/^/     /'
else
  echo "  ⚠️  最近 15 分钟一句都没说"
fi
BLOCKED=$(grep -cE "instruction leak blocked|meta leak blocked|machine talk blocked" "$LOG" 2>/dev/null)
SAID=$(grep -c "\[say\]" "$LOG" 2>/dev/null)
echo "  全程：拦截 $BLOCKED 次 / 说出口 $SAID 句"

# ---------- 3b. 被踢 ----------
echo ""
echo "【3b】被踢 / 重连"
KICK=$(grep -ciE "被服务器踢|disconnect\.|Connection throttled|duplicate_login" "$LOG" 2>/dev/null)
echo "  全程被踢/断线 $KICK 次"
[ "${KICK:-0}" -gt 0 ] && grep -iE "被服务器踢|disconnect\.|Connection throttled|duplicate_login" "$LOG" 2>/dev/null | tail -2 | sed 's/^/     /'

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
  const f=(v)=>v==null?'(字段缺失)':Number(v).toFixed(2);
  console.log('  energy', f(m.energy), '| irritation', f(m.irritation), '| resting', m.resting);
}catch(err){ console.log('  读不了 mood.json') }
" 2>/dev/null

# ---------- 6. 判断 ----------
echo ""
echo "════════════════════════════════════════════"
echo " 结论（清单第五节：只有这些情况才动手）"
echo "════════════════════════════════════════════"
ADVICE=0
if [ "${DUP:-0}" -eq 1 ] || [ "$NBOT" -lt 1 ]; then
  echo "  ❌ 进程不在        -> bash scripts/daemon.sh start"; ADVICE=1
fi
if [ "$NBOT" -gt 1 ]; then
  echo "  ❌ $NBOT 个 bot 同时跑 -> 互踢，先杀到只剩一个（scripts/daemon.sh restart）"; ADVICE=1
fi
if [ -n "${HBAGE:-}" ] && [ "$HBAGE" -gt 300 ]; then
  echo "  ❌ 日志 $(( HBAGE / 60 )) 分钟没更新 -> 先看是不是卡死：tail -50 data/runtime/supervisor.log"; ADVICE=1
fi
if [ -n "${Y:-}" ] && [ "$Y" -lt 50 ] 2>/dev/null; then
  echo "  ⚠️  在地下 y=$Y      -> 等天亮（修复 10 会自动爬出来）或按清单第九条调 energy"; ADVICE=1
fi
if [ -n "${HP:-}" ] && [ "$HP" -le 10 ] 2>/dev/null; then
  # 档位来自代码，别改数字：
  #   reflex.js:49 HP_CRIT=5  血<=5  -> 跑 + 吃 + 不接新任务
  #   reflex.js:48 HP_PANIC=8 血<=8  -> 跑 + 吃
  #   reflex.js:47 HP_FLEE=10 血<=10 -> 真跑
  #   goals.js:1444  血<=4     -> 放弃长期目标保命
  #   actions.js:2564 血<=6    -> 抛「血太少了，得先撤」
  if [ "$HP" -le 4 ] 2>/dev/null; then
    echo "  ❌ 血 $HP ≤ 4       -> goals 会放弃长期目标保命（goals.js:1444），设计内，别手动塞任务"
  elif [ "$HP" -le 5 ] 2>/dev/null; then
    echo "  ❌ 血 $HP ≤ 5       -> 他不接新任务（reflex.js:49 HP_CRIT），跑+吃+保命；别塞任务，等回血"
  elif [ "$HP" -le 6 ] 2>/dev/null; then
    echo "  ⚠️  血 $HP ≤ 6       -> 动作层会抛「血太少了，得先撤」（actions.js:2564），任务会中途失败"
  elif [ "$HP" -le 8 ] 2>/dev/null; then
    echo "  ⚠️  血 $HP ≤ 8       -> 反射层跑+吃（reflex.js HP_PANIC=8），干活效率会掉"
  else
    echo "  ⚠️  血 $HP ≤ 10      -> 反射层已在逃跑档（reflex.js HP_FLEE=10），掉血趋势要看"
  fi
  ADVICE=1
fi
if [ -n "${FD:-}" ] && [ "$FD" -eq 0 ] 2>/dev/null && [ -n "${HP:-}" ] && [ "$HP" -le 10 ] 2>/dev/null; then
  echo "  ⚠️  饿0+血≤10       -> 按清单第十一条：调 energy 到 0.8 让他动起来→掉血→死→重生满血"; ADVICE=1
fi
if [ -z "${HP:-}" ] && [ -n "${HB:-}" ]; then
  echo "  ⚠️  心跳里读不到血量（血=?) -> 别当成正常，手动看一眼"; ADVICE=1
fi
if [ "${RECENT:-0}" -eq 0 ]; then
  echo "  ⚠️  最近 15 分钟没说话 -> 先看是不是在 rest/躲夜（那是对的），别急着改"; ADVICE=1
fi
[ "$ADVICE" -eq 0 ] && echo "  ✅ 一切正常 —— 【什么都不做】（清单第五节：正常在干活就别碰）"
echo ""
echo "ADVICE=$ADVICE  （0=别动，1=看上面哪条）"
echo "完整清单：docs/MORNING-CHECKLIST.md"
echo "夜账：    docs/NIGHT-SUMMARY.md"
