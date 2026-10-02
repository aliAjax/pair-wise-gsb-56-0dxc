import { createApi } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn } from '@reduxjs/toolkit/query/react'
import type {
  MaterialFile,
  MaterialPackage,
  PageReview,
  PendingAction,
  ReconciliationBatch,
  ReviewComment,
  WorkspaceState,
} from '@/types/domain'
import {
  loadOutbox,
  loadWorkspace,
  resetWorkspace,
  saveOutbox,
  saveWorkspace,
  setWriteFault,
} from '@/services/storage'
import { now } from '@/services/reconciliation'
import { createApprovalRoute, findApplicableRule, validatePackage } from '@/services/rules'
import { handleBatchMutation, restoreFromSnapshot } from '@/services/batchActions'

type MockRequest = {
  url: string
  method: 'GET' | 'POST'
  body?: unknown
}

type MockError = {
  status: number
  error: string
  conflict?: boolean
  reasons?: string[]
  data?: { writeFailed?: boolean; batchId?: string }
}

const wait = (ms = 180) => new Promise((resolve) => window.setTimeout(resolve, ms))

export const mockBaseQuery: BaseQueryFn<MockRequest, unknown, MockError> = async ({
  url,
  body,
}) => {
  await wait()
  let state = loadWorkspace()
  // 动作执行前的深拷贝：写失败时据此生成"动作前完整批次快照"
  const beforeState: WorkspaceState = JSON.parse(JSON.stringify(state))
  const payload = (body ?? {}) as Record<string, unknown>
  const audit = (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>) => {
    state.audit.unshift({ ...entry, id: `audit-${crypto.randomUUID()}`, createdAt: now() })
  }

  try {
    if (url === '/workspace') return { data: state }

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
      audit({
        packageId,
        action: '上传文件版本',
        target: `${file.name} ${label}`,
        operator: '当前用户',
        detail: summary,
      })
    } else if (url === '/file/reference') {
      const fileId = String(payload.fileId)
      const versionId = String(payload.versionId)
      const file = state.files.find((item) => item.id === fileId)
      if (!file) throw new Error('文件不存在')
      file.referencedVersionId = versionId
      audit({
        packageId: file.packageId,
        action: '选择引用版本',
        target: file.name,
        operator: '当前用户',
        detail: `引用版本调整为 ${file.versions.find((item) => item.id === versionId)?.label ?? versionId}。`,
      })
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
    } else if (url === '/approval/submit') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const rule = findApplicableRule(packageItem, state.rules)
      if (!rule) throw new Error('未匹配到许可规则')
      packageItem.approvalRoute = createApprovalRoute(rule.approvalLevel)
      packageItem.matchedRuleId = rule.id
      packageItem.status = 'reviewing'
      packageItem.currentRound += 1
      audit({
        packageId,
        action: '提交审批',
        target: packageItem.code,
        operator: '当前用户',
        detail: `按 ${rule.name} 生成审批路线，第 ${packageItem.currentRound} 轮。`,
      })
    } else if (url === '/approval/decide') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const step = packageItem.approvalRoute.find((item) => item.id === String(payload.stepId))
      if (!step || step.status !== 'active') throw new Error('当前步骤不可审批')
      const decision = String(payload.decision)
      step.comment = String(payload.comment ?? '')
      step.decidedAt = now()
      if (decision === 'return') {
        step.status = 'returned'
        packageItem.status = 'returned'
      } else {
        step.status = 'approved'
        const next = packageItem.approvalRoute.find((item) => item.order === step.order + 1)
        if (next) next.status = 'active'
        else packageItem.status = 'approved'
      }
      audit({
        packageId,
        action: decision === 'return' ? '审批退回' : '审批通过',
        target: `${packageItem.code} / ${step.role}`,
        operator: step.assignee,
        detail: step.comment || '无补充意见。',
      })
    } else if (url === '/license/deduct') {
      const packageId = String(payload.packageId)
      const amount = Number(payload.amount)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      if (packageItem.quotaUsed + amount > packageItem.quotaLimit) {
        throw new Error('许可额度不足')
      }
      packageItem.quotaUsed += amount
      packageItem.status = 'licensed'
      audit({
        packageId,
        action: '扣减许可额度',
        target: packageItem.code,
        operator: '当前用户',
        detail: `扣减 ${amount}，剩余 ${packageItem.quotaLimit - packageItem.quotaUsed}。`,
      })
    } else if (url.startsWith('/batch/') && url !== '/batch/retry') {
      const result = handleBatchMutation(url, payload, state, audit)
      if (!result.ok) {
        throw Object.assign(new Error(result.error), {
          conflict: result.conflict,
          reasons: result.reasons,
        })
      }
    } else if (url === '/batch/retry') {
      const actionId = String(payload.actionId)
      const actor = String(payload.actor ?? '当前用户')
      const outbox = loadOutbox()
      const pending = outbox.find((item) => item.id === actionId)
      if (!pending) throw new Error('待重试动作不存在或已办结')
      const batch = restoreFromSnapshot(state, pending)
      const replay = handleBatchMutation(
        pending.action,
        { ...pending.payload, actor },
        state,
        audit,
      )
      if (!replay.ok) throw new Error(replay.error)
      const nextOutbox = outbox.filter((item) => item.id !== actionId)
      saveOutbox(nextOutbox)
      state.pendingActions = nextOutbox
      audit({
        packageId: batch.packageId,
        action: '失败动作重试成功',
        target: batch.batchNo,
        operator: actor,
        detail: `从动作前完整批次快照重放「${pending.action}」，此前失败 ${pending.attempts} 次。`,
      })
    } else if (url === '/fault/toggle') {
      setWriteFault(Boolean(payload.on))
      audit({
        action: payload.on ? '开启写入故障注入' : '关闭写入故障注入',
        target: '本地存储通道',
        operator: '当前用户',
        detail: payload.on
          ? '后续写入将失败并转入待重试（outbox）。'
          : '写入通道恢复，可从完整批次重试。',
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
      return { data: state }
    } else {
      throw new Error(`未实现的本地接口：${url}`)
    }

    try {
      saveWorkspace(state)
      // 写入成功后清理 outbox：批次已推进（rev 超过快照或已放行）的待办作废
      const outbox = loadOutbox()
      if (outbox.length) {
        const kept = outbox.filter((item) => {
          const batch = state.batches.find((b) => b.id === item.batchId)
          if (!batch) return true
          if (batch.status === 'released') return false
          // 快照动作已体现在更新的批次中（rev 已超过快照）则作废
          return batch.rev <= item.fullBatchSnapshot.rev
        })
        if (kept.length !== outbox.length) {
          saveOutbox(kept)
          state.pendingActions = kept
          persistAgain(state)
        } else {
          state.pendingActions = outbox
        }
      }
      return { data: state }
    } catch (writeError) {
      // 写入失败：把动作与动作前的完整批次快照转入 outbox（重试时按原 payload 重放）
      const outbox = loadOutbox()
      const canEnqueue = url.startsWith('/batch/') && url !== '/batch/retry'
      const payloadBatchId = String(
        payload.batchId ??
          payload.packageId ??
          (payload.fullBatchSnapshot as { batchId?: string } | undefined)?.batchId ??
          '',
      )
      // 动作后被修改的批次 = 与动作前内容不同者；优先使用请求指定的批次
      const changedBatches = state.batches
        .map((after, index) => ({
          after,
          before: beforeState.batches.find((item) => item.id === after.id) ?? beforeState.batches[index],
        }))
        .filter(({ after, before }) => before && JSON.stringify(before) !== JSON.stringify(after))
      const target =
        changedBatches.find((item) => item.after.id === payloadBatchId) ?? changedBatches[0]
      if (target && canEnqueue) {
        const preAction: ReconciliationBatch = {
          ...target.before,
          status: 'write_failed',
          note: writeError instanceof Error ? writeError.message : '写入失败',
        }
        const previous = outbox.find((item) => item.batchId === target.after.id)
        const pending: PendingAction = {
          id: previous?.id ?? `pending-${crypto.randomUUID()}`,
          batchId: target.after.id,
          action: url,
          actor: String(payload.actor ?? '当前用户'),
          payload: payload as Record<string, unknown>,
          fullBatchSnapshot: preAction,
          createdAt: previous?.createdAt ?? now(),
          attempts: (previous?.attempts ?? 0) + 1,
          lastError: writeError instanceof Error ? writeError.message : '写入失败',
        }
        const deduped = [pending, ...outbox.filter((item) => item.batchId !== target.after.id)]
        saveOutbox(deduped)
        state.pendingActions = deduped
      }
      // 内存中的主库变更不落盘即丢弃；outbox 已独立持久化，可从完整批次重试
      return {
        error: {
          status: 503,
          error:
            writeError instanceof Error
              ? `${writeError.message}（可从完整批次重试）`
              : '写入失败，可从完整批次重试',
          data: { writeFailed: canEnqueue, batchId: target?.after.id },
        },
      }
    }
  } catch (error) {
    return {
      error: {
        status: 400,
        error: error instanceof Error ? error.message : '本地操作失败',
        conflict: Boolean((error as { conflict?: boolean }).conflict),
        reasons: (error as { reasons?: string[] }).reasons,
      } as MockError,
    }
  }
}

function persistAgain(state: WorkspaceState) {
  window.localStorage.setItem('export-control-review-v2', JSON.stringify(state))
}

export const workspaceApi = createApi({
  reducerPath: 'workspaceApi',
  baseQuery: mockBaseQuery,
  tagTypes: ['Workspace'],
  endpoints: (builder) => ({
    getWorkspace: builder.query<WorkspaceState, void>({
      query: () => ({ url: '/workspace', method: 'GET' }),
      providesTags: ['Workspace'],
    }),
    savePackage: builder.mutation<
      WorkspaceState,
      { packageId: string; patch: Partial<MaterialPackage> }
    >({
      query: (body) => ({ url: '/package/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackage: builder.mutation<
      WorkspaceState,
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
    saveFile: builder.mutation<WorkspaceState, { file: MaterialFile }>({
      query: (body) => ({ url: '/file/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addFileVersion: builder.mutation<
      WorkspaceState,
      { packageId: string; fileId: string; label: string; pageCount: number; summary: string }
    >({
      query: (body) => ({ url: '/file/version/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    setReferenceVersion: builder.mutation<
      WorkspaceState,
      { fileId: string; versionId: string }
    >({
      query: (body) => ({ url: '/file/reference', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    savePageReview: builder.mutation<
      WorkspaceState,
      { fileId: string; versionId: string; page: PageReview }
    >({
      query: (body) => ({ url: '/page/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    validatePackage: builder.mutation<WorkspaceState, { packageId: string }>({
      query: (body) => ({ url: '/package/validate', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackageVersion: builder.mutation<
      WorkspaceState,
      { packageId: string; label: string; summary: string }
    >({
      query: (body) => ({ url: '/package/version', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    submitApproval: builder.mutation<WorkspaceState, { packageId: string }>({
      query: (body) => ({ url: '/approval/submit', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    decideApproval: builder.mutation<
      WorkspaceState,
      { packageId: string; stepId: string; decision: 'approve' | 'return'; comment: string }
    >({
      query: (body) => ({ url: '/approval/decide', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    deductQuota: builder.mutation<WorkspaceState, { packageId: string; amount: number }>({
      query: (body) => ({ url: '/license/deduct', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addComment: builder.mutation<
      WorkspaceState,
      { comment: Omit<ReviewComment, 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/comment/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addAudit: builder.mutation<
      WorkspaceState,
      { entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/audit/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    resetWorkspace: builder.mutation<WorkspaceState, void>({
      query: () => ({ url: '/workspace/reset', method: 'POST' }),
      invalidatesTags: ['Workspace'],
    }),
    freezeBatch: builder.mutation<
      WorkspaceState,
      { packageId: string; actor?: string }
    >({
      query: (body) => ({ url: '/batch/freeze', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    decideBatch: builder.mutation<
      WorkspaceState,
      { batchId: string; stepId: string; passed: boolean; comment: string; actor?: string }
    >({
      query: (body) => ({ url: '/batch/decide', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    ingestInbox: builder.mutation<WorkspaceState, { actor?: string }>({
      query: (body) => ({ url: '/batch/ingest', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    checkReceipt: builder.mutation<
      WorkspaceState,
      { batchId: string; receiptId: string; resolution: 'confirm' | 'reject'; actor?: string }
    >({
      query: (body) => ({ url: '/batch/receipt/check', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    changeFileVersion: builder.mutation<
      WorkspaceState,
      { packageId: string; fileId: string; label: string; summary: string; actor?: string }
    >({
      query: (body) => ({ url: '/batch/file-version', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    backfillBatch: builder.mutation<WorkspaceState, { batchId: string; actor?: string }>({
      query: (body) => ({ url: '/batch/backfill', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    releaseBatch: builder.mutation<
      WorkspaceState,
      { batchId: string; expectedRev: number; actor?: string }
    >({
      query: (body) => ({ url: '/batch/release', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    releaseRace: builder.mutation<WorkspaceState, { batchId: string; actor: string }>({
      query: (body) => ({ url: '/batch/release-race', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    retryPending: builder.mutation<WorkspaceState, { actionId: string; actor?: string }>({
      query: (body) => ({ url: '/batch/retry', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    toggleFault: builder.mutation<WorkspaceState, { on: boolean }>({
      query: (body) => ({ url: '/fault/toggle', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
  }),
})

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
  useAddCommentMutation,
  useAddAuditMutation,
  useResetWorkspaceMutation,
  useFreezeBatchMutation,
  useDecideBatchMutation,
  useIngestInboxMutation,
  useCheckReceiptMutation,
  useChangeFileVersionMutation,
  useBackfillBatchMutation,
  useReleaseBatchMutation,
  useReleaseRaceMutation,
  useRetryPendingMutation,
  useToggleFaultMutation,
} = workspaceApi
