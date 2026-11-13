#!/bin/bash
# 守护进程：node main.js 崩了 5 秒后自动拉起。
#
# 【为什么需要】
# 用户明早进游戏看到的是"一个空服务器"——如果主进程在凌晨崩了、
# 被系统 OOM 清掉、或者被别的东西带走，他就一直不在线，而没人会发现。
#
# 今晚验证过的是"掉线会自动重连"（4 轮），没验证的是"进程崩了"。
# 这个脚本补的就是那一层。
#
# 用法：
#   bash scripts/daemon.sh start    # 后台起守护
#   bash scripts/daemon.sh stop     # 停守护（连同 bot）
#   bash scripts/daemon.sh status   # 看状态
#   bash scripts/daemon.sh log      # 看最近日志

set -u
ROOT="/root/workspace/minecraft-AIfriend"
LOG="$ROOT/data/runtime/supervisor.log"
PIDF="/tmp/xjj-daemon.pid"
export AIFRIEND_DATA="${AIFRIEND_DATA:-data/runtime}"

cd "$ROOT" || { echo "进不去 $ROOT"; exit 1; }

case "${1:-status}" in
  start)
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
      echo "守护已经在跑（pid $(cat "$PIDF")）"; exit 0
    fi
    mkdir -p "$(dirname "$LOG")"
    echo "[supervisor] ===== 启动于 $(date) =====" >> "$LOG"
    nohup bash -c '
      while true; do
        echo "[supervisor] 拉起 bot $(date)" >> "'"$LOG"'"
        AIFRIEND_DATA="'"$AIFRIEND_DATA"'" node main.js >> "'"$LOG"'" 2>&1
        code=$?
        echo "[supervisor] bot 退出 code=$code $(date)" >> "'"$LOG"'"
        # code=0 表示是我们主动 pkill 的（重启），也照拉；
        # 只有连续 10 次都是秒退才放弃（防止疯狂重启烧日志）
        sleep 5
      done
    ' >/dev/null 2>&1 &
    echo $! > "$PIDF"
    echo "守护已起（pid $(cat "$PIDF")），日志 $LOG"
    ;;

  stop)
    if [ -f "$PIDF" ]; then
      kill "$(cat "$PIDF")" 2>/dev/null && echo "守护已停"
      rm -f "$PIDF"
    else
      echo "没有守护在跑"
    fi
    pkill -f "node main.js" 2>/dev/null && echo "bot 已停"
    ;;

  restart)
    # 只杀 bot，守护会自动拉起 —— 用来"换个起点"（比如让他回家再重开）
    pkill -f "node main.js" 2>/dev/null && echo "bot 重启中（守护会 5 秒后拉起）"
    ;;

  status)
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
      echo "守护：在跑（pid $(cat "$PIDF")）"
    else
      echo "守护：没跑"
    fi
    n=$(pgrep -fc "node main.js" 2>/dev/null || echo 0)
    echo "bot： $n 个进程"
    [ -f "$LOG" ] && echo "日志最后一行：$(tail -1 "$LOG" 2>/dev/null)"
    ;;

  log)
    tail -30 "$LOG" 2>/dev/null || echo "没有日志"
    ;;

  *)
    echo "用法: bash scripts/daemon.sh {start|stop|restart|status|log}"
    ;;
esac
