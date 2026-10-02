// 对账批次引擎行为验证（由 esbuild 打包到 CJS 后用 node 运行）
import assert from 'node:assert'
import { createInitialState } from '../src/services/mockData'
import {
  buildOutboxEntry,
  decideBatchStep,
  ingestReceipt,
  invalidateBatchForFileChange,
  migrateWorkspace,
  recomputeBatch,
  releaseBatch,
  retryBatchFromOutbox,
  submitBatch,
  verifyReceipt,
} from '../src/services/reconcile'

// ---- 浏览器环境垫片 ----
let counter = 0
const g = globalThis as unknown as Record<string, unknown>
g.crypto = {
  randomUUID: () => `test-uuid-${counter++}`,
}
g.structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown

// ---- 1. 迁移：旧批次摘要回填 / 补不全阻断 ----
const state = migrateWorkspace(createInitialState())

const batchA = state.batches.find((b) => b.id === 'batch-pkg-001-r1')!
assert.equal(batchA.status, 'pending', 'A: 版本不符回执 → 待核')
assert.ok(batchA.frozenDigestComplete, 'A: 逐页摘要完整')
assert.equal(batchA.receipts.find((r) => r.id === 'receipt-a3')?.status, 'mismatch')

const batchB = state.batches.find((b) => b.id === 'batch-pkg-002-r1')!
assert.equal(batchB.status, 'released', 'B: 已放行批次保持放行')
assert.equal(batchB.legacyBackfilled, true, 'B: 旧摘要按首次送审内容回填')
assert.ok(batchB.frozenDigestComplete, 'B: 回填后摘要完整')
assert.equal(batchB.receipts[0].status, 'verified', 'B: 已核验回执保留')

const batchC = state.batches.find((b) => b.id === 'batch-pkg-004-r1')!
assert.equal(batchC.status, 'blocked', 'C: 引用版本缺失 → 补不全阻断')
assert.equal(batchC.frozenDigestComplete, false)

console.log('✓ 迁移回填/阻断/旧回执状态正确')

// ---- 2. 重复回执只入一次（直接在 A 上再推一次相同编号会落在同一批次） ----
// A 已有 JTC-2026-1041（duplicateCount=1 种子）。再模拟一份新批次验证全链路：

// 用 pkg-001 之外的可送审包：A 仍开放，不能重复送审；改用构造一个干净包
// pkg-003 是 returned 且有开放批次吗？没有（只有 A/B/C），pkg-003 无批次
let threw = false
try {
  submitBatch(state, 'pkg-003', '测试员')
} catch (error) {
  threw = true
  console.log('  pkg-003 送审被拦:', (error as Error).message)
}
assert.equal(threw, false, 'pkg-003 应可送审')
const batchD = [...state.batches].reverse().find((b) => b.packageId === 'pkg-003')!
assert.equal(batchD.status, 'submitted')
const pkg3Files = state.files.filter((f) => f.packageId === 'pkg-003')

// 回执 v1 入账
const r1 = ingestReceipt(
  state,
  'pkg-003',
  {
    receiptNo: 'DOC-1',
    platform: 'P',
    amount: 1,
    packageVersionId: batchD.packageVersionId,
    fileRefs: pkg3Files.map((f) => ({ fileId: f.id, versionId: f.referencedVersionId })),
  },
  '平台',
)
assert.equal(r1.status, 'pending', '新回执未核验 → 待核')
assert.equal(r1.receipts.length, 1)

// 重复推送 → 只入一次，duplicateCount+1
ingestReceipt(
  state,
  'pkg-003',
  {
    receiptNo: 'DOC-1',
    platform: 'P',
    amount: 1,
    fileRefs: pkg3Files.map((f) => ({ fileId: f.id, versionId: f.referencedVersionId })),
  },
  '平台',
)
assert.equal(batchD.receipts.length, 1, '重复回执不新增记录')
assert.equal(batchD.receipts[0].duplicateCount, 1, '重复计数 +1')

// 跨批次重复编号也被拒（仍只计入原批次）
ingestReceipt(
  state,
  'pkg-003',
  {
    receiptNo: 'DOC-1',
    platform: 'P',
    amount: 1,
    fileRefs: pkg3Files.map((f) => ({ fileId: f.id, versionId: f.referencedVersionId })),
  },
  '平台',
)
assert.equal(batchD.receipts[0].duplicateCount, 2)
console.log('✓ 重复回执只入一次')

// ---- 3. 版本不符 → 待核 ----
ingestReceipt(
  state,
  'pkg-003',
  {
    receiptNo: 'DOC-OLD',
    platform: 'P',
    amount: 1,
    fileRefs: [{ fileId: pkg3Files[0].id, versionId: 'file-version-does-not-exist' }],
  },
  '平台',
)
assert.equal(batchD.status, 'pending')
assert.equal(batchD.receipts.find((r) => r.receiptNo === 'DOC-OLD')?.status, 'mismatch')
// 尝试放行 → 必须被拦
threw = false
try {
  releaseBatch(state, batchD.id, '测试员')
} catch {
  threw = true
}
assert.ok(threw, '版本不符 + 未核验时不能放行')
console.log('✓ 版本对不上停在待核且不放行')

// ---- 4. 换版只失效依赖步骤与未核回执，已确认意见保留 ----
// 先核验 DOC-1，并把前两步走 approve
verifyReceipt(state, batchD.id, batchD.receipts.find((r) => r.receiptNo === 'DOC-1')!.id, '核验员')
// senior 路线 4 步：业务复核/技术安全/高级出口管制/合规
const stepsAtStart = batchD.route.filter((s) => s.status === 'active' || s.status === 'waiting').length
assert.ok(stepsAtStart >= 2)
const token0 = batchD.route.find((s) => s.status === 'active')!.confirmToken!
decideBatchStep(state, {
  batchId: batchD.id,
  stepId: batchD.route[0].id,
  decision: 'approve',
  comment: '业务通过',
  confirmToken: token0,
  operator: '业务负责人',
})
assert.equal(batchD.route[0].status, 'approved')
assert.equal(batchD.route[0].comment, '业务通过')

// 上传新版本（复用引擎：手工加版本再调失效函数，模拟 /file/version/add）
const targetFile = pkg3Files[0]
targetFile.versions.push({
  id: 'file-version-new-x',
  label: 'V9.9',
  uploadedAt: new Date().toISOString(),
  hash: 'NEWHASH01',
  sizeKb: 1000,
  pages: [
    {
      id: 'page-new-1',
      page: 1,
      category: targetFile.kind,
      controlled: true,
      desensitized: false,
      note: '',
      reviewer: '',
    },
  ],
  changeSummary: '测试换版',
})
targetFile.activeVersionId = 'file-version-new-x'
targetFile.referencedVersionId = 'file-version-new-x'
invalidateBatchForFileChange(state, 'pkg-003', targetFile.id, '测试文件 V9.9')
assert.equal(batchD.status, 'invalidated', '换版后批次待重算')
assert.equal(batchD.route[0].status, 'approved', '已确认步骤保留')
assert.equal(batchD.route[0].comment, '业务通过', '已确认意见保留')
assert.equal(batchD.receipts.find((r) => r.receiptNo === 'DOC-1')?.status, 'verified', '已核验回执保留')
assert.equal(batchD.receipts.find((r) => r.receiptNo === 'DOC-OLD')?.status, 'invalidated', '未核/不符回执失效')
console.log('✓ 换版仅失效依赖待审批步骤与未核回执')

// 重算 → 恢复步骤并刷新冻结
recomputeBatch(state, batchD.id, '测试员')
assert.notEqual(batchD.status, 'invalidated')
assert.equal(batchD.frozenFiles.find((f) => f.fileId === targetFile.id)!.versionId, 'file-version-new-x')
console.log('✓ 重算续办成功')

// ---- 5. 两人同时确认只放行一个（CAS） ----
const active = batchD.route.find((s) => s.status === 'active')!
const token = active.confirmToken!
decideBatchStep(state, {
  batchId: batchD.id,
  stepId: active.id,
  decision: 'approve',
  comment: '终端A',
  confirmToken: token,
  operator: 'A',
})
let casBlocked = false
try {
  decideBatchStep(state, {
    batchId: batchD.id,
    stepId: active.id,
    decision: 'approve',
    comment: '终端B',
    confirmToken: token, // 同一张过期令牌
    operator: 'B',
  })
} catch {
  casBlocked = true
}
assert.ok(casBlocked, '持旧令牌的第二次确认必须被拒')
console.log('✓ 两人同时确认只放行一个（CAS）')

// ---- 6. 放行全流程：补齐审批 + 新版本一致回执 ----
// 当前第二个步骤已 approved（刚 CAS A 通过），后续步骤继续
for (const step of batchD.route) {
  const current = batchD.route.find((s) => s.status === 'active')
  if (!current) break
  decideBatchStep(state, {
    batchId: batchD.id,
    stepId: current.id,
    decision: 'approve',
    comment: 'ok',
    confirmToken: current.confirmToken!,
    operator: '审批人',
  })
}
// 失效的旧回执 DOC-OLD 不参与；再收一份新版本一致回执并核验
ingestReceipt(
  state,
  'pkg-003',
  {
    receiptNo: 'DOC-2',
    platform: 'P',
    amount: 1,
    packageVersionId: batchD.packageVersionId,
    fileRefs: state.files
      .filter((f) => f.packageId === 'pkg-003')
      .map((f) => ({ fileId: f.id, versionId: f.referencedVersionId })),
  },
  '平台',
)
verifyReceipt(state, batchD.id, batchD.receipts.find((r) => r.receiptNo === 'DOC-2')!.id, '核验员')
const pkg3 = state.packages.find((p) => p.id === 'pkg-003')!
const before = pkg3.quotaUsed
releaseBatch(state, batchD.id, '测试员')
assert.equal(batchD.status, 'released')
assert.equal(pkg3.status, 'licensed')
assert.equal(pkg3.quotaUsed, before + 2, '两份已核验回执（DOC-1、DOC-2 各 1）额度写回')
assert.ok(batchD.quotaUsedAfter === pkg3.quotaUsed)
console.log('✓ 批次放行并保留许可记录, quotaUsedAfter =', batchD.quotaUsedAfter)

// 放行后再换版不回滚
invalidateBatchForFileChange(state, 'pkg-003', targetFile.id, '放行后换版')
assert.equal(batchD.status, 'released', '已放行批次不受换版影响')
console.log('✓ 已放行许可记录永久保留')

// ---- 7. 写入失败 → 完整批次重试（revision 幂等闸门） ----
// pkg-004 无开放批次（C 是 blocked，仍算开放？findOpenBatch 排除 released；blocked 也在内 → 不能送审）
// 手工制造一个可重试场景：用 pkg-001 的开放批次 A 模拟“写入失败前”的新版本
const snapshotBefore = JSON.stringify(batchA)
const entry = buildOutboxEntry(batchA, '/batch/receipt', '模拟写入失败')
assert.equal(entry.expectedRevision, batchA.revision)
assert.equal(JSON.stringify(entry.batch), snapshotBefore, 'outbox 保存完整批次快照')

// 当前 revision 与期望一致 → 整批覆盖重放成功
const replayed = retryBatchFromOutbox(state, entry, '测试员')
assert.equal(replayed.id, batchA.id)
assert.ok(replayed.events.some((e) => e.type === 'retry'), '重试写入 retry 事件')
console.log('✓ 写入失败后从完整批次重试成功（revision 一致）')

// 失败后批次又被其他操作推进 → 同一条 outbox 不能再覆盖
replayed.revision += 1
let retryConflict = false
try {
  retryBatchFromOutbox(state, { ...entry, attempts: 1 }, '测试员')
} catch {
  retryConflict = true
}
assert.ok(retryConflict, 'revision 不一致时拒绝覆盖重试')
replayed.revision -= 1
console.log('✓ revision 冲突时拒绝覆盖写入')

console.log('\n全部引擎行为断言通过 ✅')
