// api.ts 端到端（mockBaseQuery + localStorage + 失败重试）验证
import assert from 'node:assert'
import { configureStore } from '@reduxjs/toolkit'

let counter = 0
const storage = new Map<string, string>()
const g = globalThis as unknown as Record<string, unknown>
void counter
g.structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown

class LocalStorageShim {
  getItem(key: string) {
    return storage.has(key) ? storage.get(key)! : null
  }
  setItem(key: string, value: string) {
    storage.set(key, value)
  }
  removeItem(key: string) {
    storage.delete(key)
  }
}
g.window = {
  localStorage: new LocalStorageShim(),
  setTimeout: (fn: () => void) => {
    fn()
    return 0
  },
}
g.localStorage = g.window.localStorage

const { workspaceApi } = await import('../src/app/api')

const store = configureStore({
  reducer: { [workspaceApi.reducerPath]: workspaceApi.reducer },
  middleware: (getDefault) => getDefault().concat(workspaceApi.middleware),
})

function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error) throw (result.error as { error: Error }).error ?? result.error
  return result.data as T
}

async function mutate<K extends keyof typeof workspaceApi.endpoints>(
  name: K,
  arg: Parameters<ReturnType<typeof workspaceApi.endpoints[K]['initiate']>>[0],
) {
  const req = store.dispatch((workspaceApi.endpoints[name] as never as { initiate: (a: unknown) => unknown }).initiate(arg) as never) as Promise<{
    data?: unknown
    error?: unknown
  }>
  return req
}

// 1. 初始加载（触发迁移：B 回填 / C blocked）
{
  const data = unwrap<{ batches: { id: string; status: string; legacyBackfilled?: boolean }[]; outbox: unknown[] }>(
    await store.dispatch(workspaceApi.endpoints.getWorkspace.initiate(undefined)),
  )
  const b = data.batches.find((x) => x.id === 'batch-pkg-002-r1')!
  const c = data.batches.find((x) => x.id === 'batch-pkg-004-r1')!
  assert.equal(b.legacyBackfilled, true)
  assert.equal(c.status, 'blocked')
  assert.deepEqual(data.outbox, [])
  console.log('✓ 初始迁移与 outbox 空')
}

// 2. 武装“下一次写入失败”，给 pkg-001 收一份正确回执 → 失败入箱
await store.dispatch(workspaceApi.endpoints.armFailNext.initiate(undefined))
const failResult = await mutate('ingestReceipt', {
  packageId: 'pkg-001',
  receipt: {
    receiptNo: 'JTC-2026-2000',
    platform: '新加坡贸易信息化平台',
    amount: 3,
    packageVersionId: 'pkg-version-pkg-001-v2-0',
    fileRefs: [],
  },
})
assert.ok(failResult.error, '武装后写入必须失败')
const failed = unwrap<{ outbox: { id: string; batchId: string; expectedRevision: number; batch: { receipts: { receiptNo: string }[] } }[]; batches: { id: string; receipts: { receiptNo: string }[] }[] }>(
  await store.dispatch(workspaceApi.endpoints.getWorkspace.initiate(undefined)),
)
assert.equal(failed.outbox.length, 1, '失败批次进入续办箱')
assert.equal(failed.outbox[0].batchId, 'batch-pkg-001-r1')
assert.ok(
  failed.outbox[0].batch.receipts.some((r) => r.receiptNo === 'JTC-2026-2000'),
  '完整批次快照包含未落库回执',
)
assert.ok(
  !failed.batches
    .find((b) => b.id === 'batch-pkg-001-r1')!
    .receipts.some((r) => r.receiptNo === 'JTC-2026-2000'),
  '失败写入没有落库',
)
console.log('✓ 写入失败未落库，完整批次进入续办箱')

// 3. 整批重试 → 成功落库，outbox 清空
const retryResult = await mutate('retryBatch', { outboxId: failed.outbox[0].id })
assert.ok(retryResult.data, '重试应成功')
const afterRetry = unwrap<{ outbox: unknown[]; batches: { id: string; receipts: { receiptNo: string; status: string }[] }[] }>(retryResult as never)
assert.equal(afterRetry.outbox.length, 0)
const batchA = afterRetry.batches.find((b) => b.id === 'batch-pkg-001-r1')!
const newReceipt = batchA.receipts.find((r) => r.receiptNo === 'JTC-2026-2000')!
assert.equal(newReceipt.status, 'received')
console.log('✓ 从完整批次重试成功，回执落库，续办箱清空')

// 4. 同一回执编号再推一次（平台重发）→ 只入一次
await mutate('ingestReceipt', {
  packageId: 'pkg-001',
  receipt: {
    receiptNo: 'JTC-2026-2000',
    platform: '新加坡贸易信息化平台',
    amount: 3,
    fileRefs: [],
  },
})
const ws = unwrap<{ batches: { id: string; receipts: { receiptNo: string; duplicateCount: number }[] }[] }>(
  await store.dispatch(workspaceApi.endpoints.getWorkspace.initiate(undefined)),
)
const again = ws.batches
  .find((b) => b.id === 'batch-pkg-001-r1')!
  .receipts.filter((r) => r.receiptNo === 'JTC-2026-2000')
assert.equal(again.length, 1)
assert.equal(again[0].duplicateCount, 1)
console.log('✓ 平台重发回执只入一次')

// 5. 双人 CAS：对 batch A 的活动步骤同时确认，只成功一个
const detail = unwrap<{ batches: { id: string; route: { id: string; status: string; confirmToken?: string }[] }[] }>(
  await store.dispatch(workspaceApi.endpoints.getWorkspace.initiate(undefined)),
)
const batchADetail = detail.batches.find((b) => b.id === 'batch-pkg-001-r1')!
const active = batchADetail.route.find((s) => s.status === 'active')!
const [r1, r2] = await Promise.all([
  mutate('decideBatch', {
    batchId: batchADetail.id,
    stepId: active.id,
    decision: 'approve',
    comment: 'A',
    confirmToken: active.confirmToken!,
    operator: '终端A',
  }),
  mutate('decideBatch', {
    batchId: batchADetail.id,
    stepId: active.id,
    decision: 'approve',
    comment: 'B',
    confirmToken: active.confirmToken!,
    operator: '终端B',
  }),
])
const winners = [r1, r2].filter((r) => r.data).length
assert.equal(winners, 1, '并发确认只能有一个成功')
console.log('✓ API 层并发确认仅一个成功')

// 6. 文件换版失败 → outbox 快照包含新文件版本；重试后恢复
await store.dispatch(workspaceApi.endpoints.armFailNext.initiate(undefined))
const beforeFiles = unwrap<{ files: { id: string; versions: unknown[] }[] }>(
  await store.dispatch(workspaceApi.endpoints.getWorkspace.initiate(undefined)),
)
const beforeCount = beforeFiles.files.find((f) => f.id === 'file-001-a')!.versions.length
const vfail = await mutate('addFileVersion', {
  packageId: 'pkg-001',
  fileId: 'file-001-a',
  label: 'V3.0',
  pageCount: 3,
  summary: '换版失败测试',
})
assert.ok(vfail.error)
const during = unwrap<{ files: { id: string; versions: unknown[] }[]; outbox: { pendingStateSnapshot: { files: { id: string; versions: unknown[] }[] } }[] }>(
  await store.dispatch(workspaceApi.endpoints.getWorkspace.initiate(undefined)),
)
assert.equal(during.files.find((f) => f.id === 'file-001-a')!.versions.length, beforeCount, '失败后新文件版本未落库')
assert.ok(during.outbox.length >= 1)
const snapFile = during.outbox[0].pendingStateSnapshot.files.find((f) => f.id === 'file-001-a')!
assert.equal(snapFile.versions.length, beforeCount + 1, '快照含新版本')
const retry2 = await mutate('retryBatch', { outboxId: during.outbox[0].id })
assert.ok(retry2.data)
const after = unwrap<{ files: { id: string; versions: unknown[] }[]; outbox: unknown[]; batches: { id: string; status: string }[] }>(retry2 as never)
assert.equal(after.files.find((f) => f.id === 'file-001-a')!.versions.length, beforeCount + 1, '重试后新版本落库')
assert.equal(after.outbox.length, 0)
assert.equal(after.batches.find((b) => b.id === 'batch-pkg-001-r1')!.status, 'invalidated', '换版后批次失效待重算')
console.log('✓ 换版写入失败 → 整份工作区快照重试一致')

console.log('\nAPI 层端到端断言全部通过 ✅')
