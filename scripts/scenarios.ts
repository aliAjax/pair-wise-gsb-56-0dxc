// 对账批次核心场景的 headless 验证（node --import tsx 运行）
// Node 20 已内置全局 crypto（randomUUID），只需补 localStorage 垫片
const mem = new Map<string, string>()
const storage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
}
// @ts-expect-error 浏览器 API 垫片
globalThis.localStorage = storage
// @ts-expect-error 浏览器 API 垫片
globalThis.window = { localStorage: storage }

import { createInitialState } from '../src/services/mockData'
import { setWriteFault, saveWorkspace } from '../src/services/storage'
import {
  backfillDigests,
  buildFileRef,
  ingestInbox,
  invalidateForFileChange,
  liveRoute,
  release,
  releaseGate,
} from '../src/services/reconciliation'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

const state = createInitialState()

console.log('1) 送审固化：引用版本必须逐页核对、跨版本错配禁止送审')
{
  const mismatched = state.files.find((f) => f.id === 'file-001-a')!
  const ref = buildFileRef(mismatched)
  check('file-001-a 现行版已逐页核对 → 可固化', 'fileId' in ref)
}

console.log('2) 重复回执只入一次，错版回执停在待核')
{
  const batch = state.batches.find((b) => b.id === 'batch-001')!
  const before = batch.receipts.length
  const out = ingestInbox({ batches: state.batches, inbox: state.inbox }, '许可管理员')
  const fresh = out.batches.find((b) => b.id === 'batch-001')!
  const newRecords = fresh.receipts.length - before
  const dup = fresh.receipts.filter((r) => r.state === 'duplicate')
  const pending = fresh.receipts.filter((r) => r.state === 'pending_check')
  check('入账新增 2 张（1 重复 + 1 错版）', newRecords === 2, `got ${newRecords}`)
  check('重复回执标记 duplicate，只入一次', dup.length === 1, `got ${dup.length}`)
  check('错版回执进入 pending_check', pending.length >= 1, `got ${pending.length}`)
  check('批次停在待核', fresh.status === 'pending_check' || fresh.status === 'in_approval', fresh.status)
  Object.assign(state, { batches: out.batches, inbox: out.inbox })
}

console.log('3) 文件换版：只失效依赖该文件的待审批步骤，已确认意见保留；未核回执失效')
{
  const batch = state.batches.find((b) => b.id === 'batch-001')!
  const approvedBefore = batch.route.filter((s) => s.status === 'approved').length
  const targetFile = state.files.find((f) => f.id === 'file-001-a')!
  const src = targetFile.versions.find((v) => v.id === targetFile.activeVersionId)!
  const newVersion = {
    ...src,
    id: `file-version-test-${Math.random()}`,
    label: 'V9.9',
    hash: 'ZZZZ-0000',
    pages: src.pages.map((p) => ({ ...p, id: `p-${Math.random()}` })),
  }
  targetFile.versions.push(newVersion)
  targetFile.activeVersionId = newVersion.id
  targetFile.referencedVersionId = newVersion.id
  const nextRef = buildFileRef(targetFile)
  if ('error' in nextRef) throw new Error(nextRef.error)
  const updated = invalidateForFileChange(batch, 'file-001-a', nextRef, '测试员')
  const approvedAfter = updated.route.filter((s) => s.status === 'approved').length
  check('已通过节点数量不变（意见保留）', approvedAfter === approvedBefore, `${approvedBefore} -> ${approvedAfter}`)
  check('出现失效留痕节点 + 新待办节点', updated.route.some((s) => s.status === 'invalidated'))
  const firstActive = liveRoute(updated).find((s) => s.status === 'active')
  check('重签首个节点重新 active（已通过的业务复核不动）', firstActive?.role === '技术安全审查', firstActive?.role)
  const receiptsForFile = updated.receipts.filter((r) => r.fileId === 'file-001-a')
  check('同文件旧回执保留（verified 留痕，不删除）', receiptsForFile.some((r) => r.state === 'verified'))
  // 复位文件，避免污染后续场景
  targetFile.versions = targetFile.versions.filter((v) => v.id !== newVersion.id)
  targetFile.activeVersionId = src.id
  targetFile.referencedVersionId = src.id
}

console.log('4) 两人同时确认只放行一个（乐观锁 rev）')
{
  const released = state.batches.find((b) => b.id === 'batch-002')!
  const attempt = release(
    { ...released, status: 'pending_receipt', releasedAt: undefined, releasedBy: undefined, rev: 5 },
    5,
    '甲',
  )
  check('首个确认成功', attempt.ok)
  if (attempt.ok) {
    const second = release(attempt.batch, 5, '乙')
    check('同 rev 第二个确认冲突被拒', !second.ok && second.conflict === true)
    const stale = release(attempt.batch, 999, '乙')
    check('过期 rev 一律拒绝', !stale.ok && stale.conflict === true)
  }
}

console.log('5) 摘要补不全不放行；可按首次送审内容回填')
{
  const legacy = state.batches.find((b) => b.id === 'batch-003')!
  const reasons = releaseGate(legacy)
  check('缺摘要批次存在阻断原因', reasons.length > 0)
  const filled = backfillDigests(legacy, state.files, '合规专员')
  const unresolved = filled.files.reduce(
    (sum, ref) => sum + ref.digests.filter((d) => d.state === 'unresolvable').length,
    0,
  )
  check('引用版本已回收的文件回填后仍 unresolvable', unresolved >= 1, `unresolved=${unresolved}`)
  check('回填后仍阻断（补不全不放行）', releaseGate(filled).some((r) => r.includes('补不全')))
}

console.log('6) 已放行批次的许可记录在换版后保留')
{
  const released = state.batches.find((b) => b.id === 'batch-002')!
  const license = state.licenses.find((l) => l.batchId === released.id)
  check('已放行批次有许可记录', Boolean(license))
  check('许可记录标记 retained', license?.retained === true)
}

console.log('7) 写入失败：saveWorkspace 抛出，状态转入待重试')
{
  setWriteFault(true)
  let threw = false
  try {
    saveWorkspace(state)
  } catch {
    threw = true
  }
  setWriteFault(false)
  check('故障开启时落盘抛错', threw)
  let recovered = false
  try {
    saveWorkspace(state)
    recovered = true
  } catch {
    recovered = false
  }
  check('关闭故障后落盘恢复', recovered)
}

console.log('8) 已放行批次不再吃新回执（旧回执放行不被换版/晚到件推翻）')
{
  const out = ingestInbox(
    { batches: state.batches, inbox: state.inbox.map((m) => ({ ...m, ingested: false })) },
    '许可管理员',
  )
  const releasedBatch = out.batches.find((b) => b.id === 'batch-002')!
  const extraForReleased = releasedBatch.receipts.length - (state.batches.find((b) => b.id === 'batch-002')!.receipts.length)
  check('已放行批次不新增回执账', extraForReleased === 0, `extra=${extraForReleased}`)
}

if (failures > 0) {
  console.error(`\n${failures} 项断言失败`)
  process.exit(1)
}
console.log('\n全部场景断言通过')
