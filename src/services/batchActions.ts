import type {
  BatchApprovalStep,
  BatchFileRef,
  LicenseRecord,
  MaterialPackage,
  PendingAction,
  ReconciliationBatch,
  WorkspaceState,
} from '@/types/domain'
import {
  backfillDigests,
  buildBatchRoute,
  buildFileRef,
  fingerprintOf,
  ingestInbox,
  invalidateForFileChange,
  liveRoute,
  now,
  recalcStatus,
  release as releaseBatchFn,
} from './reconciliation'
import { findApplicableRule } from './rules'

export interface AuditSink {
  (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>): void
}

export class ActionError extends Error {
  conflict?: boolean
  reasons?: string[]
  constructor(message: string, extra?: { conflict?: boolean; reasons?: string[] }) {
    super(message)
    this.conflict = extra?.conflict
    this.reasons = extra?.reasons
  }
}

const fileLevelsFor = (
  packageItem: MaterialPackage,
  packageFiles: WorkspaceState['files'],
  state: WorkspaceState,
): Record<string, BatchApprovalStep['level']> => {
  const level = findApplicableRule(packageItem, state.rules)?.approvalLevel ?? 'standard'
  return Object.fromEntries(packageFiles.map((file) => [file.id, level]))
}

/** 在给定 state 上执行一个批次动作；纯内存操作，落盘由调用方负责（便于失败重放） */
export function handleBatchMutation(
  url: string,
  payload: Record<string, unknown>,
  state: WorkspaceState,
  audit: AuditSink,
): { ok: true } | { ok: false; error: string; conflict?: boolean; reasons?: string[] } {
  try {
    const actor = String(payload.actor ?? '当前用户')

    if (url === '/batch/freeze') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new ActionError('资料包不存在')
      const packageFiles = state.files.filter((file) => file.packageId === packageId)
      if (!packageFiles.length) throw new ActionError('资料包尚未拆解文件，无法送审')

      const refs: BatchFileRef[] = []
      for (const file of packageFiles) {
        const ref = buildFileRef(file)
        if ('error' in ref) throw new ActionError(ref.error)
        refs.push(ref)
      }
      const activeBatch = state.batches.find(
        (batch) => batch.packageId === packageId && !['released', 'blocked'].includes(batch.status),
      )
      if (activeBatch) {
        throw new ActionError(
          `资料包已有在途对账批次 ${activeBatch.batchNo}，请勿重复送审；文件换版请在批次内重算`,
        )
      }

      const nextLabelNum = packageItem.versions.length + 1
      if (!packageItem.versions.some((version) => version.label === `V${nextLabelNum.toFixed(1)}`)) {
        packageItem.versions.push({
          id: `pkg-version-${crypto.randomUUID()}`,
          label: `V${nextLabelNum.toFixed(1)}`,
          createdAt: now(),
          createdBy: actor,
          summary: '送审固化：冻结当前文件引用版本与逐页脱敏摘要。',
          snapshot: {
            title: packageItem.title,
            category: packageItem.category,
            destination: packageItem.destination,
            endUse: packageItem.endUse,
            technologyTags: [...packageItem.technologyTags],
            personnelScopes: [...packageItem.personnelScopes],
            declarations: [...packageItem.declarations],
            activeFileVersions: Object.fromEntries(
              packageFiles.map((file) => [file.id, file.referencedVersionId]),
            ),
          },
        })
      }
      const frozenVersion = packageItem.versions.at(-1)!
      const batch: ReconciliationBatch = {
        id: `batch-${crypto.randomUUID()}`,
        batchNo: `B${now().slice(0, 10).replaceAll('-', '')}-${String(state.batches.length + 1).padStart(2, '0')}`,
        packageId,
        packageVersionId: frozenVersion.id,
        packageVersionLabel: frozenVersion.label,
        fingerprint: fingerprintOf(packageItem, refs, frozenVersion.id),
        status: 'in_approval',
        files: refs,
        route: buildBatchRoute(refs, fileLevelsFor(packageItem, packageFiles, state)),
        receipts: [],
        attempts: [
          { id: `attempt-${crypto.randomUUID()}`, action: 'freeze', at: now(), ok: true, attempt: 1, actor },
        ],
        rev: 1,
        frozenAt: now(),
        frozenBy: actor,
        blockReasons: [],
      }
      packageItem.status = 'reviewing'
      state.batches.unshift(batch)
      audit({
        packageId,
        action: '送审固化对账批次',
        target: batch.batchNo,
        operator: actor,
        detail: `冻结资料包 ${frozenVersion.label} 与 ${refs.length} 个文件引用版本、${refs.reduce(
          (sum, ref) => sum + ref.digests.length,
          0,
        )} 页脱敏摘要。`,
      })
      return { ok: true }
    }

    if (url === '/batch/decide') {
      const batch = state.batches.find((item) => item.id === String(payload.batchId))
      if (!batch) throw new ActionError('对账批次不存在')
      if (batch.status === 'released') throw new ActionError('批次已放行，审批节点锁定')
      const step = batch.route.find((item) => item.id === String(payload.stepId))
      if (!step || step.status !== 'active') throw new ActionError('当前步骤不可审批')
      const passed = Boolean(payload.passed)
      const comment = String(payload.comment ?? '')
      step.comment = comment
      step.decidedAt = now()
      step.decidedBy = actor
      step.history.push({ by: actor, passed, comment: comment || '无补充意见', at: step.decidedAt })
      if (!passed) {
        step.status = 'returned'
        batch.status = 'frozen'
      } else {
        step.status = 'approved'
        const next = liveRoute(batch).find((item) => item.status === 'waiting')
        if (next) next.status = 'active'
        batch.status = recalcStatus(batch)
      }
      batch.rev += 1
      batch.attempts.push({
        id: `attempt-${crypto.randomUUID()}`,
        action: 'approve',
        at: now(),
        ok: true,
        attempt: 1,
        actor,
      })
      audit({
        packageId: batch.packageId,
        action: passed ? '批次审批通过' : '批次审批退回',
        target: `${batch.batchNo} / ${step.role}`,
        operator: actor,
        detail: comment || (passed ? '确认固化版本与摘要无误。' : '退回补正。'),
      })
      return { ok: true }
    }

    if (url === '/batch/ingest') {
      const before = new Set(state.inbox.filter((item) => item.ingested).map((item) => item.id))
      const out = ingestInbox({ batches: state.batches, inbox: state.inbox }, actor)
      state.batches = out.batches
      state.inbox = out.inbox
      state.inbox
        .filter((item) => !before.has(item.id) && item.ingested)
        .forEach((mail) => {
          audit({
            packageId: mail.packageId,
            action: '许可回执入账',
            target: mail.receiptNo,
            operator: actor,
            detail:
              mail.result === 'duplicate'
                ? '重复回执，只入一次，不参与放行。'
                : mail.result === 'verified'
                  ? '回执版本与固化引用一致，核对通过。'
                  : '回执声称版本与固化引用不一致，批次停在待核。',
          })
        })
      return { ok: true }
    }

    if (url === '/batch/receipt/check') {
      const batch = state.batches.find((item) => item.id === String(payload.batchId))
      if (!batch) throw new ActionError('对账批次不存在')
      const receipt = batch.receipts.find((item) => item.id === String(payload.receiptId))
      if (!receipt || receipt.state !== 'pending_check') throw new ActionError('该回执不在待核状态')
      const resolution = String(payload.resolution ?? 'confirm')
      const ref = batch.files.find((item) => item.fileId === receipt.fileId)
      if (resolution === 'confirm') {
        if (!ref || ref.versionId !== receipt.claimedVersionId) {
          throw new ActionError('版本仍对不上，不能核对通过；请等待与固化引用同版的回执')
        }
        receipt.state = 'verified'
        receipt.checkedBy = actor
        receipt.checkedAt = now()
        receipt.note = '人工核对：回执版本与批次固化引用一致'
      } else {
        receipt.state = 'obsolete'
        receipt.previousState = 'pending_check'
        receipt.note = '人工判定回执作废，等待平台补发同版回执'
      }
      batch.status = recalcStatus(batch)
      batch.rev += 1
      audit({
        packageId: batch.packageId,
        action: resolution === 'confirm' ? '回执核对通过' : '回执作废',
        target: receipt.receiptNo,
        operator: actor,
        detail: receipt.note,
      })
      return { ok: true }
    }

    if (url === '/batch/file-version') {
      const packageId = String(payload.packageId)
      const fileId = String(payload.fileId)
      const label = String(payload.label)
      const summary = String(payload.summary)
      const file = state.files.find((item) => item.id === fileId && item.packageId === packageId)
      if (!file) throw new ActionError('文件不存在')
      const cloneSource = file.versions.find((version) => version.id === file.activeVersionId)
      const newVersion = {
        id: `file-version-${crypto.randomUUID()}`,
        label,
        uploadedAt: now(),
        hash: crypto.randomUUID().slice(0, 8).toUpperCase(),
        sizeKb: (cloneSource?.sizeKb ?? 1200) + 128,
        pages: (cloneSource?.pages ?? []).map((page) => ({
          ...page,
          id: `page-${crypto.randomUUID()}`,
          note: `${page.note}（${label} 修订）`,
          reviewedAt: page.reviewedAt ? now() : undefined,
        })),
        changeSummary: summary,
      }
      file.versions.push(newVersion)
      file.activeVersionId = newVersion.id
      file.referencedVersionId = newVersion.id
      audit({
        packageId,
        action: '文件换版',
        target: `${file.name} ${label}`,
        operator: actor,
        detail: `${summary}；仅依赖该文件的待审批步骤与未核回执失效重算，已确认意见与许可记录保留。`,
      })
      state.batches
        .filter(
          (batch) =>
            batch.packageId === packageId &&
            batch.status !== 'released' &&
            batch.files.some((ref) => ref.fileId === fileId),
        )
        .forEach((batch) => {
          const nextRef = buildFileRef(file)
          if ('error' in nextRef) throw new ActionError(nextRef.error)
          const updated = invalidateForFileChange(batch, fileId, nextRef, actor)
          Object.assign(batch, updated)
          audit({
            packageId,
            action: '批次失效重算',
            target: batch.batchNo,
            operator: actor,
            detail: `文件 ${file.name} 换版，重算受影响的待审批节点与未核回执；已放行许可不受影响。`,
          })
        })
      return { ok: true }
    }

    if (url === '/batch/backfill') {
      const batch = state.batches.find((item) => item.id === String(payload.batchId))
      if (!batch) throw new ActionError('对账批次不存在')
      const updated = backfillDigests(batch, state.files, actor)
      const unresolved = updated.files.reduce(
        (sum, ref) => sum + ref.digests.filter((digest) => digest.state === 'unresolvable').length,
        0,
      )
      updated.blockReasons = unresolved ? [`有 ${unresolved} 页首次送审内容已不可得，补不全，不放行`] : []
      Object.assign(batch, updated)
      audit({
        packageId: batch.packageId,
        action: '旧批次摘要回填',
        target: batch.batchNo,
        operator: actor,
        detail: unresolved
          ? `${unresolved} 页无法按首次送审内容回填，批次保持阻断。`
          : '按首次送审内容回填全部逐页脱敏摘要。',
      })
      return { ok: true }
    }

    if (url === '/batch/release' || url === '/batch/release-race') {
      const batch = state.batches.find((item) => item.id === String(payload.batchId))
      if (!batch) throw new ActionError('对账批次不存在')
      const expectedRev =
        url === '/batch/release-race' ? batch.rev : Number(payload.expectedRev)
      const outcome = releaseBatchFn(batch, expectedRev, actor)
      if (!outcome.ok) {
        throw new ActionError(outcome.reasons.join('；'), {
          conflict: outcome.conflict,
          reasons: outcome.reasons,
        })
      }
      Object.assign(batch, outcome.batch)
      const packageItem = state.packages.find((item) => item.id === batch.packageId)
      const license: LicenseRecord = {
        ...outcome.license,
        code: packageItem?.code ?? batch.packageId,
        title: packageItem?.title ?? '',
        destination: packageItem?.destination ?? '',
      }
      state.licenses.unshift(license)
      if (packageItem) {
        packageItem.status = 'licensed'
        packageItem.updatedAt = now()
      }
      audit({
        packageId: batch.packageId,
        action: url === '/batch/release-race' ? '批次放行（并发胜出）' : '批次放行',
        target: batch.batchNo,
        operator: actor,
        detail: `乐观锁 rev=${expectedRev} 胜出；生成许可记录，回执 ${license.receiptNos.length} 张，指纹 ${batch.fingerprint}。`,
      })
      if (url === '/batch/release-race') {
        const otherActor = actor === '许可管理员甲' ? '许可管理员乙' : '许可管理员甲'
        const second = releaseBatchFn(
          state.batches.find((item) => item.id === batch.id)!,
          expectedRev,
          otherActor,
        )
        audit({
          packageId: batch.packageId,
          action: '批次放行（并发被拒）',
          target: batch.batchNo,
          operator: otherActor,
          detail: second.ok
            ? '异常：第二个确认也成功了'
            : `第 2 个确认基于过期 rev=${expectedRev}，已拒绝（只放行一个）。`,
        })
        if (second.ok) throw new ActionError('并发断言失败：两个确认都被放行')
      }
      return { ok: true }
    }

    return { ok: false, error: `未实现的批次动作：${url}` }
  } catch (error) {
    if (error instanceof ActionError) {
      return { ok: false, error: error.message, conflict: error.conflict, reasons: error.reasons }
    }
    return { ok: false, error: error instanceof Error ? error.message : '批次动作失败' }
  }
}

/** 从 outbox 待办恢复并重放（返回新的待办列表） */
export function restoreFromSnapshot(
  state: WorkspaceState,
  pending: PendingAction,
): ReconciliationBatch {
  const restored: ReconciliationBatch = {
    ...pending.fullBatchSnapshot,
    status: recalcStatus(pending.fullBatchSnapshot),
    note: undefined,
  }
  const index = state.batches.findIndex((item) => item.id === pending.batchId)
  if (index < 0) state.batches.unshift(restored)
  else state.batches[index] = restored
  return state.batches[index < 0 ? 0 : index]
}
