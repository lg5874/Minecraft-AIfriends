#!/bin/bash
# 多 bot 并行测试启动器
#
# 用法：
#   ./scripts/multi-bot.sh start 3      # 启动 3 个 bot
#   ./scripts/multi-bot.sh stop         # 停掉所有
#   ./scripts/multi-bot.sh status       # 看状态
#   ./scripts/multi-bot.sh logs 1       # 看 1 号的日志
#
# 每个 bot 有独立的：
#   - 游戏 ID（XJJ1, XJJ2, ...）
#   - 数据目录（data/runtime-1, runtime-2, ...）
#   - 日志文件

set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)

# 名字池
NAMES=(阿豆 小北 老陈 阿七 石头)

start_one() {
  local idx=$1
  local name="XJJ${idx}"
  local datadir="data/runtime-${idx}"
  local logfile="${datadir}/bot.log"

  mkdir -p "$datadir"

  # 生成这个实例的配置
  local cfg="config.${idx}.json"
  node -e "
    const fs = require('fs');
    const base = JSON.parse(fs.readFileSync('config.json', 'utf8'));
    base.bot.username = '${name}';
    fs.writeFileSync('${cfg}', JSON.stringify(base, null, 2));
  "

  # 启动
  AIFRIEND_CONFIG="$cfg" AIFRIEND_DATA="$datadir" \
    setsid nohup node main.js > "$logfile" 2>&1 < /dev/null &

  echo "  启动 ${name}（数据目录 ${datadir}）"
  sleep 2
}

case "${1:-start}" in
  start)
    N=${2:-2}
    echo "启动 ${N} 个 bot..."
    for i in $(seq 1 $N); do
      start_one $i
    done
    echo "完成。用 './scripts/multi-bot.sh status' 看状态"
    ;;

  stop)
    echo "停止所有 bot..."
    pkill -f "node main.js" 2>/dev/null || true
    sleep 2
    echo "已停止"
    ;;

  status)
    echo "=== 运行中的 bot ==="
    for pid in $(pgrep -f "node main.js" 2>/dev/null); do
      # 从 /proc 拿环境变量判断是哪个实例
      datadir=$(tr '\0' '\n' < /proc/$pid/environ 2>/dev/null | grep AIFRIEND_DATA | cut -d= -f2 || echo "默认")
      echo "  PID $pid  数据: $datadir"
    done
    [ -z "$(pgrep -f 'node main.js' 2>/dev/null)" ] && echo "  （没有在跑的）"

    echo
    echo "=== 各实例最新日志 ==="
    for d in data/runtime*/; do
      [ -f "${d}bot.log" ] || continue
      echo "--- $d ---"
      tail -3 "${d}bot.log" 2>/dev/null | sed 's/^/  /'
    done
    ;;

  logs)
    idx=${2:-1}
    tail -f "data/runtime-${idx}/bot.log"
    ;;

  clean)
    echo "清理测试数据..."
    rm -rf data/runtime-* config.*.json
    echo "完成"
    ;;

  *)
    echo "用法: $0 {start [N]|stop|status|logs [N]|clean}"
    exit 1
    ;;
esac
