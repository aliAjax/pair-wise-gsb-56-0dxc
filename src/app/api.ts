import { createApi } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn } from '@reduxjs/toolkit/query/react'
import type {
  MaterialFile,
  MaterialPackage,
  PageReview,
  ReviewComment,
  ReconcileBatch,
  WorkspaceResponse,
  WorkspaceState,
} from '@/types/domain'
import {
  armFailNext,
  clearOutbox,
  consumeFailNext,
  loadOutbox,
  loadWorkspace,
  resetWorkspace,
  saveOutbox,
  saveWorkspace,
} from '@/services/storage'
import { findApplicableRule, validatePackage } from '@/services/rules'
import {
  buildOutboxEntry,
  decideBatchStep,
  ingestReceipt,
  invalidateBatchForFileChange,
  recomputeBatch,
  releaseBatch,
  retryBatchFromOutbox,
  submitBatch,
  verifyReceipt,
} from '@/services/reconcile'

type MockRequest = {
  url: string
  method: 'GET' | 'POST'
  body?: unknown
}

type MockError = { status: number; error: string }

const wait = (ms = 180) => new Promise((resolve) => window.setTimeout(resolve, ms))
const now = () => new Date().toISOString()

const mockBaseQuery: BaseQueryFn<MockRequest, unknown, MockError> = async ({
  url,
  body,
}) => {
  await wait()
  let state = loadWorkspace()
  const payload = (body ?? {}) as Record<string, unknown>
  const audit = (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>) => {
    state.audit.unshift({ ...entry, id: `audit-${crypto.randomUUID()}`, createdAt: now() })
  }
  /** 批次写入失败：完整批次落入续办箱。引擎已把 revision +1 但未落库，库里停留在 revision-1 */
  const failAndStore = (
    batch: ReconcileBatch,
    failedUrl: string,
    reason: string,
  ): never => {
    const entries = loadOutbox()
    entries.push(buildOutboxEntry(batch, failedUrl, reason, undefined, batch.revision - 1))
    saveOutbox(entries)
    throw new Error(`${reason}：完整批次已存入续办箱，可整批重试`)
  }
  const respond = (): { data: WorkspaceResponse } => ({
    data: { ...state, outbox: loadOutbox() },
  })

  try {
    if (url === '/workspace') return respond()

    if (url === '/package/save') {
      const packageId = String(payload.packageId)
      const patch = payload.patch as Partial<MaterialPackage>
      const current = state.packages.find((item) => item.id === packageId)
      if (!current) throw new Error('资料包不存在')
      Object.assign(current, patch, { updatedAt: now() })
      current.matchedRuleId = findApplicableRule(current, state.rules)?.id
      audit({
        packageId,
        action: '更新资料包',
        target: current.code,
        operator: '当前用户',
        detail: '更新收件方、最终用途、声明或技术参数。',
      })
    } else if (url === '/package/create') {
      const draft = payload.package as Omit<
        MaterialPackage,
        'id' | 'approvalRoute' | 'versions' | 'currentRound' | 'createdAt' | 'updatedAt'
      >
      const rule = findApplicableRule(
        { ...draft, id: 'temp', approvalRoute: [], versions: [], currentRound: 0, createdAt: '', updatedAt: '' },
        state.rules,
      )
      const packageItem: MaterialPackage = {
        ...draft,
        id: `pkg-${crypto.randomUUID()}`,
        matchedRuleId: rule?.id,
        approvalRoute: [],
        currentRound: 0,
        createdAt: now(),
        updatedAt: now(),
        versions: [],
      }
      packageItem.versions.push({
        id: `version-${crypto.randomUUID()}`,
        label: 'V1.0',
        createdAt: now(),
        createdBy: packageItem.applicant,
        summary: '创建资料包初始版本。',
        snapshot: {
          title: packageItem.title,
          category: packageItem.category,
          destination: packageItem.destination,
          endUse: packageItem.endUse,
          technologyTags: [...packageItem.technologyTags],
          personnelScopes: [...packageItem.personnelScopes],
          declarations: [...packageItem.declarations],
          activeFileVersions: {},
        },
      })
      state.packages.unshift(packageItem)
      audit({
        packageId: packageItem.id,
        action: '创建资料包',
        target: packageItem.code,
        operator: packageItem.applicant,
        detail: `目的地：${packageItem.destination}，资料类型：${packageItem.category}。`,
      })
    } else if (url === '/file/save') {
      const file = payload.file as MaterialFile
      const index = state.files.findIndex((item) => item.id === file.id)
      if (index >= 0) state.files[index] = file
      else state.files.push(file)
    } else if (url === '/file/version/add') {
      const packageId = String(payload.packageId)
      const fileId = String(payload.fileId)
      const file = state.files.find((item) => item.id === fileId && item.packageId === packageId)
      if (!file) throw new Error('文件不存在')
      const pageCount = Number(payload.pageCount)
      const label = String(payload.label)
      const summary = String(payload.summary)
      const newVersion = {
        id: `file-version-${crypto.randomUUID()}`,
        label,
        uploadedAt: now(),
        hash: crypto.randomUUID().slice(0, 8).toUpperCase(),
        sizeKb: pageCount * 96 + 720,
        pages: Array.from({ length: pageCount }, (_, index) => ({
          id: `page-${crypto.randomUUID()}`,
          page: index + 1,
          category: file.kind,
          controlled: false,
          desensitized: false,
          note: '',
          reviewer: '',
        })),
        changeSummary: summary,
      }
      file.versions.push(newVersion)
      file.activeVersionId = newVersion.id
      file.referencedVersionId = newVersion.id
      const affected = invalidateBatchForFileChange(
        state,
        packageId,
        fileId,
        `${file.name} ${label}`,
      )
      audit({
        packageId,
        action: '上传文件版本',
        target: `${file.name} ${label}`,
        operator: '当前用户',
        detail:
          summary +
          (affected.length
            ? `；${affected.length} 个对账批次的依赖审批步骤与未核回执已失效，已确认意见与许可记录保留。`
            : ''),
      })
      // 写入失败：整份待写入工作区（含文件新版本与全部失效批次）落入 outbox，重试时整体提交
      if (consumeFailNext(url)) {
        const entries = loadOutbox()
        const requestId = `req-${crypto.randomUUID()}`
        // 即使没有步骤/回执失效，开放批次也因冻结版本漂移需要重算，照样整批落箱
        const openBatches = state.batches.filter(
          (batch) =>
            batch.packageId === packageId &&
            batch.status !== 'released' &&
            batch.frozenFiles.some((frozen) => frozen.fileId === fileId),
        )
        const targets = affected.length ? affected : openBatches
        if (!targets.length) {
          // 没有任何相关开放批次：失败写入不落库，文件版本随回滚丢弃，平台可重试
          throw new Error('写入失败：无关联开放批次，本次文件版本未落库，请重新上传')
        }
        targets.forEach((batch) => {
          entries.push(
            buildOutboxEntry(
              batch,
              url,
              '写入失败（文件换版）',
              state,
              batch.revision - 1,
              requestId,
            ),
          )
        })
        saveOutbox(entries)
        throw new Error('写入失败：完整批次与文件换版结果已存入续办箱，可整批重试')
      }
    } else if (url === '/file/reference') {
      const fileId = String(payload.fileId)
      const versionId = String(payload.versionId)
      const file = state.files.find((item) => item.id === fileId)
      if (!file) throw new Error('文件不存在')
      const previousVersionId = file.referencedVersionId
      file.referencedVersionId = versionId
      const affected =
        previousVersionId !== versionId
          ? invalidateBatchForFileChange(
              state,
              file.packageId,
              fileId,
              `${file.name} 引用版本切换`,
            )
          : []
      audit({
        packageId: file.packageId,
        action: '选择引用版本',
        target: file.name,
        operator: '当前用户',
        detail: `引用版本调整为 ${file.versions.find((item) => item.id === versionId)?.label ?? versionId}。${
          affected.length ? `相关 ${affected.length} 个批次待重算。` : ''
        }`,
      })
      if (consumeFailNext(url)) {
        const entries = loadOutbox()
        const requestId = `req-${crypto.randomUUID()}`
        const openBatches = state.batches.filter(
          (batch) =>
            batch.packageId === file.packageId &&
            batch.status !== 'released' &&
            batch.frozenFiles.some((frozen) => frozen.fileId === fileId),
        )
        const targets = affected.length ? affected : openBatches
        if (targets.length) {
          targets.forEach((batch) => {
            entries.push(
              buildOutboxEntry(
                batch,
                url,
                '写入失败（引用版本切换）',
                state,
                batch.revision - 1,
                requestId,
              ),
            )
          })
          saveOutbox(entries)
          throw new Error('写入失败：批次与引用版本已存入续办箱，可整批重试')
        }
        throw new Error('写入失败：无关联开放批次，引用版本未落库，请重新选择')
      }
    } else if (url === '/page/save') {
      const file = state.files.find((item) => item.id === String(payload.fileId))
      const version = file?.versions.find((item) => item.id === String(payload.versionId))
      if (!file || !version) throw new Error('文件版本不存在')
      const page = payload.page as PageReview
      const index = version.pages.findIndex((item) => item.id === page.id)
      if (index >= 0) version.pages[index] = page
      else version.pages.push(page)
      audit({
        packageId: file.packageId,
        action: '逐页分类核对',
        target: `${file.name} 第 ${page.page} 页`,
        operator: page.reviewer || '当前用户',
        detail: page.controlled ? `标记受控，脱敏状态：${page.desensitized ? '已脱敏' : '待脱敏'}` : '标记为一般资料',
      })
    } else if (url === '/package/validate') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      state.findings = [
        ...state.findings.filter((item) => item.packageId !== packageId),
        ...validatePackage(packageItem, state.files, state.rules),
      ]
      audit({
        packageId,
        action: '执行许可校验',
        target: packageItem.code,
        operator: '当前用户',
        detail: `生成 ${state.findings.filter((item) => item.packageId === packageId).length} 条核对结果。`,
      })
    } else if (url === '/package/version') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const summary = String(payload.summary)
      const label = String(payload.label)
      packageItem.versions.push({
        id: `package-version-${crypto.randomUUID()}`,
        label,
        createdAt: now(),
        createdBy: '当前用户',
        summary,
        snapshot: {
          title: packageItem.title,
          category: packageItem.category,
          destination: packageItem.destination,
          endUse: packageItem.endUse,
          technologyTags: [...packageItem.technologyTags],
          personnelScopes: [...packageItem.personnelScopes],
          declarations: [...packageItem.declarations],
          activeFileVersions: Object.fromEntries(
            state.files
              .filter((file) => file.packageId === packageId)
              .map((file) => [file.id, file.activeVersionId]),
          ),
        },
      })
      audit({
        packageId,
        action: '创建资料包版本',
        target: `${packageItem.code} ${label}`,
        operator: '当前用户',
        detail: summary,
      })
    } else if (url === '/batch/submit') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const batch = submitBatch(state, packageId, '当前用户')
      audit({
        packageId,
        action: '送审固化批次',
        target: batch.code,
        operator: '当前用户',
        detail: `固化资料包 ${batch.packageVersionLabel}、${batch.frozenFiles.length} 个文件引用版本与逐页脱敏摘要，revision ${batch.revision}。`,
      })
      if (consumeFailNext(url)) {
        // 送审会创建新批次与新资料包版本：整份工作区落箱，保证重试可完整重放
        const entries = loadOutbox()
        entries.push(buildOutboxEntry(batch, url, '写入失败（送审）', state, batch.revision - 1))
        saveOutbox(entries)
        throw new Error('写入失败：送审完整批次已存入续办箱，可整批重试')
      }
    } else if (url === '/batch/receipt') {
      const packageId = String(payload.packageId)
      const receiptInput = payload.receipt as {
        receiptNo: string
        platform: string
        amount: number
        packageVersionId?: string
        fileRefs: { fileId: string; versionId: string }[]
      }
      const batch = ingestReceipt(state, packageId, receiptInput)
      const duplicate = batch.receipts.find(
        (receipt) => receipt.receiptNo === receiptInput.receiptNo,
      )
      if (duplicate && duplicate.duplicateCount > 0 && batch.events.at(-1)?.type === 'duplicate') {
        audit({
          packageId,
          action: '回执重复忽略',
          target: receiptInput.receiptNo,
          operator: '许可平台',
          detail: `重复回执只入一次（第 ${duplicate.duplicateCount + 1} 次收到），批次 ${batch.code} 不重复放行。`,
        })
      } else {
        const latest = batch.receipts.find((item) => item.receiptNo === receiptInput.receiptNo)
        audit({
          packageId,
          action: '许可回执入账',
          target: receiptInput.receiptNo,
          operator: '许可平台',
          detail:
            latest?.status === 'mismatch'
              ? `回执版本与送审固化版本不一致，批次 ${batch.code} 停在待核。`
              : `回执已入账待核验，批次 ${batch.code} 停在待核。`,
        })
      }
      if (consumeFailNext(url)) failAndStore(batch, url, '写入失败（回执入账）')
    } else if (url === '/batch/verify') {
      const batchId = String(payload.batchId)
      const receiptId = String(payload.receiptId)
      const batch = verifyReceipt(state, batchId, receiptId, '当前用户')
      const receipt = batch.receipts.find((item) => item.id === receiptId)
      audit({
        packageId: batch.packageId,
        action: '核验许可回执',
        target: receipt?.receiptNo ?? receiptId,
        operator: '当前用户',
        detail: `批次 ${batch.code} 回执核验通过，许可记录保留。`,
      })
      if (consumeFailNext(url)) failAndStore(batch, url, '写入失败（回执核验）')
    } else if (url === '/batch/recompute') {
      const batchId = String(payload.batchId)
      const batch = recomputeBatch(state, batchId, '当前用户')
      audit({
        packageId: batch.packageId,
        action: '批次重算续办',
        target: batch.code,
        operator: '当前用户',
        detail: '按当前引用版本重算冻结摘要与失效步骤，已确认意见与已核验回执保留。',
      })
      if (consumeFailNext(url)) failAndStore(batch, url, '写入失败（批次重算）')
    } else if (url === '/batch/decide') {
      const batchId = String(payload.batchId)
      const batch = decideBatchStep(state, {
        batchId,
        stepId: String(payload.stepId),
        decision: String(payload.decision) as 'approve' | 'return',
        comment: String(payload.comment ?? ''),
        confirmToken: String(payload.confirmToken ?? ''),
        operator: String(payload.operator ?? '当前用户'),
      })
      audit({
        packageId: batch.packageId,
        action: payload.decision === 'return' ? '批次审批退回' : '批次审批确认',
        target: `${batch.code} / ${batch.route.find((step) => step.id === payload.stepId)?.role ?? ''}`,
        operator: String(payload.operator ?? '当前用户'),
        detail: String(payload.comment ?? '') || '无补充意见。',
      })
      if (consumeFailNext(url)) failAndStore(batch, url, '写入失败（审批确认）')
    } else if (url === '/batch/release') {
      const batchId = String(payload.batchId)
      const batch = releaseBatch(state, batchId, '当前用户')
      audit({
        packageId: batch.packageId,
        action: '批次放行许可',
        target: batch.code,
        operator: '当前用户',
        detail: `资料包版本 ${batch.packageVersionLabel} 与逐页脱敏摘要对账一致，批次放行，许可记录永久保留。`,
      })
      if (consumeFailNext(url)) failAndStore(batch, url, '写入失败（批次放行）')
    } else if (url === '/batch/retry') {
      const outboxId = String(payload.outboxId)
      const entries = loadOutbox()
      const entry = entries.find((item) => item.id === outboxId)
      if (!entry) throw new Error('续办箱中没有该失败批次')
      entry.attempts += 1
      let batch: ReconcileBatch
      if (entry.pendingStateSnapshot) {
        // 文件换版 / 送审等伴随修改随完整工作区一起重放
        const current = state.batches.find((item) => item.id === entry.batchId)
        if (current && current.revision !== entry.expectedRevision) {
          throw new Error('批次在写入失败后已被其他操作更新，不能覆盖重试，请刷新后续办')
        }
        const snapshot = entry.pendingStateSnapshot
        const replayed = snapshot.batches.find((item) => item.id === entry.batchId)
        if (!replayed) throw new Error('快照中缺少失败批次')
        replayed.events.push({
          id: `batch-event-${crypto.randomUUID()}`,
          at: now(),
          type: 'retry',
          operator: '当前用户',
          detail: `第 ${entry.attempts} 次从完整批次重试写入成功（${entry.failedUrl}，含伴随修改的整份工作区）。`,
        })
        // 整体提交失败时的工作区（重试事件已并入快照批次）
        state = snapshot
        batch = replayed
      } else {
        batch = retryBatchFromOutbox(state, entry, '当前用户')
      }
      // 同一次请求产生的多个失败批次整组完成，一并移除
      const clearIds = new Set(
        entries
          .filter((item) => entry.requestId && item.requestId === entry.requestId)
          .map((item) => item.id),
      )
      clearIds.add(outboxId)
      saveOutbox(entries.filter((item) => !clearIds.has(item.id)))
      audit({
        packageId: entry.packageId,
        action: '完整批次重试',
        target: batch.code,
        operator: '当前用户',
        detail: `从写入失败点整批重放成功（第 ${entry.attempts} 次尝试，${entry.failedUrl}${
          clearIds.size > 1 ? `，同请求 ${clearIds.size} 条记录一起完成` : ''
        }）。`,
      })
    } else if (url === '/dev/fail-next') {
      armFailNext()
      return respond()
    } else if (url === '/approval/submit') {
      // 兼容旧入口：统一走批次送审
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const batch = submitBatch(state, packageId, '当前用户')
      audit({
        packageId,
        action: '送审固化批次',
        target: batch.code,
        operator: '当前用户',
        detail: `经审批页发起送审，固化资料包 ${batch.packageVersionLabel} 与逐页脱敏摘要。`,
      })
    } else if (url === '/approval/decide') {
      // 兼容旧入口：无令牌时按当前活动步骤签发（单人路径仍受 CAS 保护）
      const packageId = String(payload.packageId)
      const open = [...state.batches]
        .reverse()
        .find((batch) => batch.packageId === packageId && batch.status !== 'released')
      if (!open) throw new Error('没有进行中的对账批次，请先送审')
      const stepId = String(payload.stepId)
      const step = open.route.find((item) => item.id === stepId)
      if (!step || step.status !== 'active') throw new Error('当前步骤不可审批')
      const batch = decideBatchStep(state, {
        batchId: open.id,
        stepId,
        decision: String(payload.decision) as 'approve' | 'return',
        comment: String(payload.comment ?? ''),
        confirmToken: step.confirmToken ?? '',
        operator: '当前用户',
      })
      audit({
        packageId,
        action: payload.decision === 'return' ? '批次审批退回' : '批次审批确认',
        target: `${batch.code} / ${step.role}`,
        operator: '当前用户',
        detail: String(payload.comment ?? '') || '无补充意见。',
      })
    } else if (url === '/license/deduct') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const open = state.batches.find(
        (batch) => batch.packageId === packageId && batch.status !== 'released',
      )
      if (open) throw new Error('存在未放行的对账批次，请在回执对账中核验回执并放行批次')
      const amount = Number(payload.amount)
      if (packageItem.quotaUsed + amount > packageItem.quotaLimit) {
        throw new Error('许可额度不足')
      }
      packageItem.quotaUsed += amount
      audit({
        packageId,
        action: '扣减许可额度',
        target: packageItem.code,
        operator: '当前用户',
        detail: `无开放批次的兼容扣减 ${amount}，剩余 ${packageItem.quotaLimit - packageItem.quotaUsed}。`,
      })
    } else if (url === '/comment/add') {
      state.comments.unshift({
        ...(payload.comment as Omit<ReviewComment, 'id' | 'createdAt'>),
        id: `comment-${crypto.randomUUID()}`,
        createdAt: now(),
      })
    } else if (url === '/audit/add') {
      audit(payload.entry as Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>)
    } else if (url === '/workspace/reset') {
      state = resetWorkspace()
      clearOutbox()
      return { data: { ...state, outbox: [] } }
    } else {
      throw new Error(`未实现的本地接口：${url}`)
    }

    saveWorkspace(state)
    return respond()
  } catch (error) {
    return {
      error: {
        status: 400,
        error: error instanceof Error ? error.message : '本地操作失败',
      },
    }
  }
}

export const workspaceApi = createApi({
  reducerPath: 'workspaceApi',
  baseQuery: mockBaseQuery,
  tagTypes: ['Workspace'],
  endpoints: (builder) => ({
    getWorkspace: builder.query<WorkspaceResponse, void>({
      query: () => ({ url: '/workspace', method: 'GET' }),
      providesTags: ['Workspace'],
    }),
    savePackage: builder.mutation<
      WorkspaceResponse,
      { packageId: string; patch: Partial<MaterialPackage> }
    >({
      query: (body) => ({ url: '/package/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackage: builder.mutation<
      WorkspaceResponse,
      {
        package: Omit<
          MaterialPackage,
          'id' | 'approvalRoute' | 'versions' | 'currentRound' | 'createdAt' | 'updatedAt'
        >
      }
    >({
      query: (body) => ({ url: '/package/create', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    saveFile: builder.mutation<WorkspaceResponse, { file: MaterialFile }>({
      query: (body) => ({ url: '/file/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addFileVersion: builder.mutation<
      WorkspaceResponse,
      { packageId: string; fileId: string; label: string; pageCount: number; summary: string }
    >({
      query: (body) => ({ url: '/file/version/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    setReferenceVersion: builder.mutation<
      WorkspaceResponse,
      { fileId: string; versionId: string }
    >({
      query: (body) => ({ url: '/file/reference', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    savePageReview: builder.mutation<
      WorkspaceResponse,
      { fileId: string; versionId: string; page: PageReview }
    >({
      query: (body) => ({ url: '/page/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    validatePackage: builder.mutation<WorkspaceResponse, { packageId: string }>({
      query: (body) => ({ url: '/package/validate', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackageVersion: builder.mutation<
      WorkspaceResponse,
      { packageId: string; label: string; summary: string }
    >({
      query: (body) => ({ url: '/package/version', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    submitApproval: builder.mutation<WorkspaceResponse, { packageId: string }>({
      query: (body) => ({ url: '/approval/submit', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    decideApproval: builder.mutation<
      WorkspaceResponse,
      { packageId: string; stepId: string; decision: 'approve' | 'return'; comment: string }
    >({
      query: (body) => ({ url: '/approval/decide', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    deductQuota: builder.mutation<WorkspaceResponse, { packageId: string; amount: number }>({
      query: (body) => ({ url: '/license/deduct', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    // ===== 对账批次 =====
    submitBatch: builder.mutation<WorkspaceResponse, { packageId: string }>({
      query: (body) => ({ url: '/batch/submit', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    ingestReceipt: builder.mutation<
      WorkspaceResponse,
      {
        packageId: string
        receipt: {
          receiptNo: string
          platform: string
          amount: number
          packageVersionId?: string
          fileRefs: { fileId: string; versionId: string }[]
        }
      }
    >({
      query: (body) => ({ url: '/batch/receipt', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    verifyReceipt: builder.mutation<
      WorkspaceResponse,
      { batchId: string; receiptId: string }
    >({
      query: (body) => ({ url: '/batch/verify', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    recomputeBatch: builder.mutation<WorkspaceResponse, { batchId: string }>({
      query: (body) => ({ url: '/batch/recompute', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    decideBatch: builder.mutation<
      WorkspaceResponse,
      {
        batchId: string
        stepId: string
        decision: 'approve' | 'return'
        comment: string
        confirmToken: string
        operator: string
      }
    >({
      query: (body) => ({ url: '/batch/decide', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    releaseBatch: builder.mutation<WorkspaceResponse, { batchId: string }>({
      query: (body) => ({ url: '/batch/release', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    retryBatch: builder.mutation<WorkspaceResponse, { outboxId: string }>({
      query: (body) => ({ url: '/batch/retry', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    armFailNext: builder.mutation<WorkspaceResponse, void>({
      query: () => ({ url: '/dev/fail-next', method: 'POST' }),
    }),
    addComment: builder.mutation<
      WorkspaceResponse,
      { comment: Omit<ReviewComment, 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/comment/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addAudit: builder.mutation<
      WorkspaceResponse,
      { entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/audit/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    resetWorkspace: builder.mutation<WorkspaceResponse, void>({
      query: () => ({ url: '/workspace/reset', method: 'POST' }),
      invalidatesTags: ['Workspace'],
    }),
  }),
})

export type { ReconcileBatch }

export const {
  useGetWorkspaceQuery,
  useSavePackageMutation,
  useCreatePackageMutation,
  useSaveFileMutation,
  useAddFileVersionMutation,
  useSetReferenceVersionMutation,
  useSavePageReviewMutation,
  useValidatePackageMutation,
  useCreatePackageVersionMutation,
  useSubmitApprovalMutation,
  useDecideApprovalMutation,
  useDeductQuotaMutation,
  useSubmitBatchMutation,
  useIngestReceiptMutation,
  useVerifyReceiptMutation,
  useRecomputeBatchMutation,
  useDecideBatchMutation,
  useReleaseBatchMutation,
  useRetryBatchMutation,
  useArmFailNextMutation,
  useAddCommentMutation,
  useAddAuditMutation,
  useResetWorkspaceMutation,
} = workspaceApi
