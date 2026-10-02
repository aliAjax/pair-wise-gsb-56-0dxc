// 端到端：故障下放行 → 写失败入 outbox → 关故障 → 从完整批次重试成功
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { tsImport } from 'tsx/esm/api'

const root = path.resolve(import.meta.dirname, '..')

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
globalThis.window = { localStorage: storage, setTimeout, clearTimeout }

const api: typeof import('../src/app/api') = await tsImport(
  '../src/app/api.ts',
  pathToFileURL(import.meta.filename).pathname,
)
const rec: typeof import('../src/services/reconciliation') = await tsImport(
  '../src/services/reconciliation.ts',
  pathToFileURL(import.meta.filename).pathname,
)
const storageSvc: typeof import('../src/services/storage') = await tsImport(
  '../src/services/storage.ts',
  pathToFileURL(import.meta.filename).pathname,
)

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

// 直接取已放行种子批次，回退为待放行状态，准备一张干净的在途批次
const seed = storageSvc.loadWorkspace()
const released = seed.batches.find((b) => b.id === 'batch-002')!
const inFlight: typeof released = {
  ...released,
  id: `batch-e2e-${Math.random()}`,
  batchNo: 'B-E2E-01',
  status: 'pending_receipt',
  releasedAt: undefined,
  releasedBy: undefined,
  rev: 5,
}
seed.batches = seed.batches.filter((b) => b.id !== 'batch-002')
seed.licenses = seed.licenses.filter((l) => l.batchId !== 'batch-002')
seed.batches.unshift(inFlight)
window.localStorage.setItem('export-control-review-v2', JSON.stringify(seed))

console.log('A) 故障开启，执行放行：业务态就绪但落盘失败')
storageSvc.setWriteFault(true)
const failResult = await api.mockBaseQuery({
  url: '/batch/release',
  method: 'POST',
  body: { batchId: inFlight.id, expectedRev: 5, actor: '许可管理员' },
})
check('返回 503 写失败', 'error' in failResult && failResult.error?.status === 503)
storageSvc.setWriteFault(false)

console.log('B) 主库未落盘（批次仍 pending_receipt，rev=5），outbox 留存完整快照')
const afterFail = storageSvc.loadWorkspace()
const stillPending = afterFail.batches.find((b) => b.id === inFlight.id)!
check('主库批次未被放行', stillPending.status === 'pending_receipt' && stillPending.rev === 5)
check('主库没有许可记录', !afterFail.licenses.some((l) => l.batchId === inFlight.id))
const outbox = storageSvc.loadOutbox()
check('outbox 有 1 条待办（含完整批次快照）', outbox.length === 1)
check(
  '快照为写失败时的完整批次（status=write_failed）',
  outbox[0]?.fullBatchSnapshot.status === 'write_failed',
)

console.log('C) 关闭故障后从完整批次重试')
const retryResult = await api.mockBaseQuery({
  url: '/batch/retry',
  method: 'POST',
  body: { actionId: outbox[0]!.id, actor: '许可管理员' },
})
if ('error' in retryResult) console.log('  retry error:', JSON.stringify(retryResult.error))
check('重试成功', 'data' in retryResult)
const afterRetry = storageSvc.loadWorkspace()
const retried = afterRetry.batches.find((b) => b.id === inFlight.id)!
check('批次已放行', retried.status === 'released', retried.status)
check('生成且仅生成一条许可记录', afterRetry.licenses.filter((l) => l.batchId === inFlight.id).length === 1)
check('outbox 已清空', storageSvc.loadOutbox().length === 0)
check('审计含重试成功事件', afterRetry.audit.some((a) => a.action === '失败动作重试成功'))

console.log('D) 重放入账等非放行动作也不产生重复许可')
const dupRelease = await api.mockBaseQuery({
  url: '/batch/release',
  method: 'POST',
  body: { batchId: inFlight.id, expectedRev: retried.rev, actor: '许可管理员乙' },
})
check('再次放行被乐观锁/终态拒绝', 'error' in dupRelease)
const finalDb = storageSvc.loadWorkspace()
check('许可记录仍只有一条', finalDb.licenses.filter((l) => l.batchId === inFlight.id).length === 1)

void rec // 模块加载即副作用校验（类型可用）
if (failures > 0) {
  console.error(`\n${failures} 项断言失败`)
  process.exit(1)
}
console.log('\n端到端续办场景全部通过')
