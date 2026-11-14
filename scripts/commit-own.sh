#!/bin/bash
# 只提交"你点名的那些文件"（多 agent 共用一个 index 时用这个，别裸 git commit）
#
#   bash scripts/commit-own.sh -m "[owner: verify-owner] 说明" -- docs/x.md scripts/foo.js
#
# 【为什么必须点名】
# 08:00 我写的第一版会"自动挑无主文件"一起提交 —— 结果把 goals-owner 已经 git add 好的
# scripts/test-goals*.js 扫进了我的提交（提交 92ceefb）。无主 ≠ 是我的。
# 现在改成：**你写哪几个，就提交哪几个**；没写就拒绝，并列出暂存区里都有谁的什么。
#
# 【它还会做什么】
#   - 逐个检查归属：命中别人 owner 的直接拒绝，并告诉你该派给谁
#   - 检查文件真的在暂存区（没 add 的自动 add，避免"路径对了但内容没进"）
#
# 参数：
#   -m "..."        传给 git commit，原样
#   <路径...>        要提交的文件（相对仓库根）
#   --as <agent>     声明你是谁（默认 DSH_AGENT_NAME，再默认 lead）
#   --dry-run        只打印，不提交

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

AS="${DSH_AGENT_NAME:-lead}"
DRY=0
FILES=()
COMMIT_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --as) AS="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --) shift; while [ $# -gt 0 ]; do FILES+=("$1"); shift; done ;;
    -m) COMMIT_ARGS+=("-m" "$2"); shift 2 ;;
    -*) COMMIT_ARGS+=("$1"); shift ;;
    *) FILES+=("$1"); shift ;;
  esac
done

if [ ${#FILES[@]} -eq 0 ]; then
  echo "⛔ 没有点名要提交哪些文件。"
  echo
  echo "用法： bash scripts/commit-own.sh -m \"[owner: $AS] 说明\" -- <文件...>"
  echo
  echo "当前暂存区："
  node -e '
const fs=require("fs"),cp=require("child_process");
const MAP=JSON.parse(fs.readFileSync("scripts/ownership.json","utf8"));
const RULES=Object.entries(MAP).filter(([k])=>!k.startsWith("_"));
function ownerOf(f){
  for(const [r,o] of RULES) if(r===f) return o;
  for(const [r,o] of RULES){ if(!r.includes("*")) continue;
    const re=new RegExp("^"+r.replace(/[.+^${}()|[\]\\]/g,"\\$&").replace(/\*/g,".*")+"$");
    if(re.test(f)) return o; }
  return undefined;
}
const st=cp.execSync("git diff --cached --name-only",{encoding:"utf8"}).split("\n").filter(Boolean);
if(!st.length){ console.log("  （空）"); process.exit(0) }
for(const f of st){ const o=ownerOf(f); console.log("  "+f.padEnd(40)+(o==null?"（无主）":"owner = "+o)) }
'
  echo
  echo "把你要提交的那几个显式列出来，别让我猜。"
  echo
  echo "注意：scripts/test-* 无主，但别人可能已暂存。裸 git commit 会把它一起带上。"
  echo "      用 commit-own.sh 点名提交，或者先 git diff --cached --name-only 看一眼。"
  exit 1
fi

# 归属检查
BLOCKED=$(node -e '
const fs=require("fs");
const MAP=JSON.parse(fs.readFileSync("scripts/ownership.json","utf8"));
const RULES=Object.entries(MAP).filter(([k])=>!k.startsWith("_"));
const AS=process.argv[1], files=process.argv.slice(2);
function ownerOf(f){
  for(const [r,o] of RULES) if(r===f) return o;
  for(const [r,o] of RULES){ if(!r.includes("*")) continue;
    const re=new RegExp("^"+r.replace(/[.+^${}()|[\]\\]/g,"\\$&").replace(/\*/g,".*")+"$");
    if(re.test(f)) return o; }
  return undefined;
}
const bad=[];
for(const f of files){ const o=ownerOf(f); if(o!==undefined&&o!==null&&o!==AS) bad.push(f+"  (owner "+o+")") }
process.stdout.write(bad.join("\n"));
' "$AS" "${FILES[@]}")

if [ -n "$BLOCKED" ]; then
  echo "⛔ 这些文件不归你（当前身份 = $AS）："
  echo "$BLOCKED" | sed 's/^/   /'
  # 如果点名的文件全归同一个 owner，多半你就是它，只是没声明身份
  OWNERS=$(echo "$BLOCKED" | sed -E 's/.*\(owner ([^)]*)\).*/\1/' | sort -u)
  FIRST=$(echo "$BLOCKED" | head -1 | sed -E 's/.*\(owner ([^)]*)\).*/\1/')
  if [ "$(echo "$OWNERS" | wc -l)" -eq 1 ]; then
    echo
    echo "  如果你就是 $FIRST（只是没声明身份），照下面这样提交："
    echo "     bash scripts/commit-own.sh --as $FIRST -m \"……\" -- ${FILES[*]}"
  fi
  echo
  echo "  确实必须自己改：echo \"<文件> 原因：<一句话>\" >> /tmp/lead-override.txt 再提交"
  exit 1
fi

echo "将提交这些文件（只这些）："
for f in "${FILES[@]}"; do echo "  $f"; done

if [ "$DRY" = "1" ]; then echo "[dry-run] 未提交"; exit 0; fi

git add -- "${FILES[@]}" || exit 1
# 【关键】把身份传给 hook。没有这一行，owner 提交自己的文件照样被拦。
export DSH_AGENT_NAME="$AS"
# pathspec 提交：git 给 hook 建临时 index，只判定这一次要提交的文件
git commit "${COMMIT_ARGS[@]}" -- "${FILES[@]}"
