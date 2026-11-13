#!/usr/bin/env node
/**
 * 用 GitHub REST API 推送（绕过 github.com:443 连不上的问题）
 * 用法: node /tmp/push-api.js <token>
 */
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const TOKEN = process.argv[2]
if (!TOKEN) { console.error('需要 token'); process.exit(1) }
const OWNER = 'lg5874'
const REPO = 'minecraft-AIfriend'
const BRANCH = 'main'
const ROOT = '/root/workspace/minecraft-AIfriend'

const api = async (method, endpoint, body) => {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      'Authorization': `token ${TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'push-api'
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch (e) { data = { raw: text } }
  if (!res.ok) throw new Error(`${method} ${endpoint} -> ${res.status}: ${text.slice(0, 200)}`)
  return data
}

const main = async () => {
  // 1. 拿远端 main 的 HEAD
  const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)
  const remoteSha = ref.object.sha
  console.log('远端 HEAD:', remoteSha.slice(0, 7))

  // 2. 本地 HEAD 和它的 tree
  const localSha = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
  console.log('本地 HEAD:', localSha.slice(0, 7))

  // 3/4. 找变化的文件
  // 如果本地没有远端那个 commit（API 推送产生的历史），就退化成
  // "用远端 tree 作 base，把当前 HEAD 的全部文件都推一遍"
  let changed
  let forceAll = false
  try {
    execSync(`git cat-file -e ${remoteSha}`, { cwd: ROOT, stdio: 'ignore' })
    changed = execSync(`git diff --name-status ${remoteSha} ${localSha}`, { cwd: ROOT, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
    const commits = execSync(`git rev-list ${remoteSha}..${localSha}`, { cwd: ROOT, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
    console.log('要推', commits.length, '个提交')
  } catch (e) {
    console.log('本地没有远端 commit，改用全量模式')
    forceAll = true
    changed = execSync(`git ls-tree -r --name-only ${localSha}`, { cwd: ROOT, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).map(f => 'M\t' + f)
  }
  if (!changed.length) { console.log('没有要推的文件'); return }
  console.log('变化文件:', changed.length, '个', forceAll ? '(全量)' : '')

  // 5. 先建 blob
  const treeItems = []
  for (const line of changed) {
    const [status, ...rest] = line.split('\t')
    const file = rest.join('\t')
    if (status === 'D') {
      // 删除：tree 里不给这个 path
      continue
    }
    const abs = path.join(ROOT, file)
    // 跳过目录
    try { if (!fs.statSync(abs).isFile()) continue } catch (e) { continue }
    const content = fs.readFileSync(abs)
    const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: content.toString('base64'),
      encoding: 'base64'
    })
    treeItems.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha })
    process.stdout.write('.')
  }
  console.log('')

  // 6. 建 tree
  const baseTree = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${remoteSha}`)
  const tree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
    base_tree: baseTree.tree.sha,
    tree: treeItems
  })
  console.log('新 tree:', tree.sha.slice(0, 7))

  // 7. 建 commit
  const msg = execSync(`git log -1 --format=%B ${localSha}`, { cwd: ROOT, encoding: 'utf8' })
  const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: msg + `\n\n(pushed via API, local ${localSha.slice(0, 7)})`,
    tree: tree.sha,
    parents: [remoteSha]
  })
  console.log('新 commit:', commit.sha.slice(0, 7))

  // 8. 更新 ref
  await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    sha: commit.sha,
    force: false
  })
  console.log('✅ 推送成功')
  console.log('远端现在是:', commit.sha.slice(0, 7))
}

main().catch(e => { console.error('失败:', e.message); process.exit(1) })
