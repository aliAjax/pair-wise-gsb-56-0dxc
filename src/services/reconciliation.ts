import type {
  BatchApprovalStep,
  BatchFileRef,
  BatchStatus,
  LicenseRecord,
  MaterialFile,
  MaterialPackage,
  PageDigest,
  PageReview,
  PlatformReceipt,
  ReceiptRecord,
  ReceiptState,
  ReconciliationBatch,
} from '@/types/domain'

// ---------- 工具 ----------

export function now() {
  return new Date().toISOString()
}

/** 32 位稳定哈希（FNV-1a），同内容同哈希、不同内容基本不碰撞 */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 逐页脱敏摘要：把受控关键词与数字参数以 ■ 替换后留存指纹 */
export function redactPage(page: PageReview): string {
  const controlledMarker = page.controlled ? '[受控]' : '[一般]'
  const base = page.note?.trim() || `第${page.page}页`
  const redacted = page.desensitized
    ? base.replace(/[A-Za-z0-9.\-_]+(?=\s*(℃|°C|GPa|MPa|mm|kV|%))/g, '■')
    : base
  return `${controlledMarker} P${page.page} ${redacted}`
}

export function digestOf(page: PageReview, state: PageDigest['state'] = 'ok'): PageDigest {
  const summary = redactPage(page)
  return {
    pageId: page.id,
    page: page.page,
    category: page.category,
    controlled: page.controlled,
    redactedSummary: summary,
    hash: fnv1a(summary),
    state,
  }
}

export const batchStatusLabels: Record<BatchStatus, string> = {
  frozen: '已固化送审',
  in_approval: '审批中',
  pending_receipt: '待回执核对',
  pending_check: '待核(版本不符)',
  released: '已放行',
  blocked: '阻断',
  write_failed: '写入失败待重试',
}

export const receiptStateLabels: Record<ReceiptState, string> = {
  pending_check: '待核',
  verified: '已核对',
  obsolete: '已失效',
  duplicate: '重复',
}

export function batchStatusColor(status: BatchStatus): string {
  switch (status) {
    case 'released':
      return 'success'
    case 'in_approval':
      return 'processing'
    case 'pending_receipt':
      return 'gold'
    case 'pending_check':
      return 'warning'
    case 'blocked':
      return 'error'
    case 'write_failed':
      return 'magenta'
    default:
      return 'default'
  }
}

export function receiptStateColor(state: ReceiptState): string {
  switch (state) {
    case 'verified':
      return 'success'
    case 'pending_check':
      return 'warning'
    case 'obsolete':
      return 'default'
    case 'duplicate':
      return 'magenta'
  }
}

// ---------- 送审固化 ----------

/** 取文件当前引用版本（送审固化的对象；引用错配时禁止送审） */
export function referencedFile(file: MaterialFile) {
  return file.versions.find((version) => version.id === file.referencedVersionId)
}

export function buildFileRef(file: MaterialFile): BatchFileRef | { error: string } {
  const version = referencedFile(file)
  if (!version) return { error: `${file.name} 的引用版本已不存在` }
  if (file.referencedVersionId !== file.activeVersionId) {
    return { error: `${file.name} 引用版本与现行版本不一致，禁止跨版本送审` }
  }
  const pending = version.pages.filter((page) => !page.reviewedAt)
  if (pending.length) {
    return { error: `${file.name} 尚有 ${pending.length} 页未完成逐页核对` }
  }
  return {
    fileId: file.id,
    fileName: file.name,
    versionId: version.id,
    versionLabel: version.label,
    versionHash: version.hash,
    digests: version.pages.map((page) => digestOf(page)),
  }
}

/** 资料包整体指纹：资料包版本快照 + 每个引用版本的逐页摘要哈希 */
export function fingerprintOf(
  packageItem: MaterialPackage,
  refs: BatchFileRef[],
  packageVersionId: string,
): string {
  const parts = [
    packageVersionId,
    packageItem.code,
    ...refs.map((ref) => `${ref.fileId}@${ref.versionId}:${ref.digests.map((d) => d.hash).join('.')}`),
  ]
  return fnv1a(parts.join('|'))
}

// ---------- 审批路线 ----------

const ROLE_BY_LEVEL: { level: BatchApprovalStep['level']; role: string; assignee: string }[] = [
  { level: 'standard', role: '业务复核', assignee: '业务负责人' },
  { level: 'enhanced', role: '技术安全审查', assignee: '技术安全负责人' },
  { level: 'senior', role: '高级出口管制审批', assignee: '出口管制委员会' },
]

/**
 * 按批次内文件命中的规则生成路线；每个节点显式携带依赖文件，
 * 文件换版时只重算依赖它且尚未定论的节点。
 */
export function buildBatchRoute(
  refs: BatchFileRef[],
  fileLevels: Record<string, BatchApprovalStep['level']>,
): BatchApprovalStep[] {
  const rank: Record<BatchApprovalStep['level'], number> = { standard: 1, enhanced: 2, senior: 3 }
  const maxRank = Math.max(1, ...refs.map((ref) => rank[fileLevels[ref.fileId] ?? 'standard']))
  const used = ROLE_BY_LEVEL.filter((item) => rank[item.level] <= maxRank)
  const compliance = { level: 'standard' as const, role: '合规审批', assignee: '合规专员' }
  // 顺序：业务复核 -> （技术安全） -> （高级管制） -> 合规审批
  const nodes: BatchApprovalStep[] = [used[0], ...used.slice(1), compliance].map((item, index) => ({
    id: `bstep-${crypto.randomUUID()}`,
    order: index + 1,
    role: item.role,
    assignee: item.assignee,
    level: item.level,
    status: 'waiting' as BatchApprovalStep['status'],
    dependsOn: refs.map((ref) => ref.fileId),
    comment: '',
    history: [],
  }))
  if (nodes[0]) nodes[0].status = 'active'
  return nodes
}

// ---------- 批次状态推演 ----------

export function unresolvedDigestCount(batch: ReconciliationBatch): number {
  return batch.files.reduce(
    (sum, ref) => sum + ref.digests.filter((digest) => digest.state === 'unresolvable').length,
    0,
  )
}

export function requiredReceipts(batch: ReconciliationBatch): ReceiptRecord[] {
  // 每个文件恰好一张有效（已核对、现行）回执即可；duplicate/obsolete 不计
  return batch.receipts.filter((receipt) => receipt.state !== 'duplicate' && receipt.state !== 'obsolete')
}

/** 当前有效路线（失效留痕节点除外） */
export function liveRoute(batch: ReconciliationBatch): BatchApprovalStep[] {
  return batch.route
    .filter((step) => step.status !== 'invalidated')
    .sort((a, b) => a.order - b.order)
}

export function recalcStatus(batch: ReconciliationBatch): BatchStatus {
  if (batch.status === 'released') return 'released'
  const unresolved = unresolvedDigestCount(batch)
  if (unresolved > 0) return 'blocked'

  const route = liveRoute(batch)
  const approved = route.length > 0 && route.every((step) => step.status === 'approved')
  if (!approved) {
    return route.some((step) => step.status === 'returned') ? 'frozen' : 'in_approval'
  }

  const live = requiredReceipts(batch)
  if (live.some((receipt) => receipt.state === 'pending_check')) return 'pending_check'

  const byFile = new Map(live.filter((r) => r.state === 'verified').map((r) => [r.fileId, r]))
  const allVerified = batch.files.every(
    (ref) => byFile.get(ref.fileId)?.claimedVersionId === ref.versionId,
  )
  return allVerified ? 'pending_receipt' : 'pending_receipt'
}

/** 放行闸门：摘要齐全 + 有效路线全部通过 + 每文件一张版本一致的已核回执 */
export function releaseGate(batch: ReconciliationBatch): string[] {
  const reasons: string[] = []
  const unresolved = unresolvedDigestCount(batch)
  if (unresolved) reasons.push(`有 ${unresolved} 页脱敏摘要无法回填，补不全不放行`)

  const route = liveRoute(batch)
  const pendingStep = route.find((step) => step.status !== 'approved')
  if (!route.length) reasons.push('审批路线为空，不能放行')
  else if (pendingStep) reasons.push(`审批路线未完成：${pendingStep.role}`)

  const live = requiredReceipts(batch)
  if (live.some((receipt) => receipt.state === 'pending_check')) {
    reasons.push('存在版本对不上、停在待核的回执')
  }
  batch.files.forEach((ref) => {
    const match = live.find(
      (receipt) =>
        receipt.fileId === ref.fileId &&
        receipt.state === 'verified' &&
        receipt.claimedVersionId === ref.versionId,
    )
    if (!match) reasons.push(`${ref.fileName} 缺少与引用版本 ${ref.versionLabel} 一致的已核回执`)
  })
  return reasons
}

// ---------- 平台收件入账（晚到 / 重复 / 错版） ----------

export interface IngestResult {
  ingested: number
  duplicates: number
  mismatched: number
}

/**
 * 将平台收件箱来件归入批次账：
 * - 同一回执单号全局只入一次，晚到的重复件只标记 duplicate；
 * - 版本与批次固化引用一致 → 已核对（仍要求逐页摘要指纹一致）；
 * - 版本对不上 → pending_check，批次停在待核。
 */
export function ingestInbox(
  state: { batches: ReconciliationBatch[]; inbox: PlatformReceipt[] },
  actor: string,
): { batches: ReconciliationBatch[]; inbox: PlatformReceipt[]; result: IngestResult } {
  const batches = state.batches.map((batch) => ({
    ...batch,
    files: batch.files.map((ref) => ({ ...ref, digests: [...ref.digests] })),
    route: batch.route.map((step) => ({ ...step, history: [...step.history] })),
    receipts: batch.receipts.map((receipt) => ({ ...receipt })),
    attempts: [...batch.attempts],
    blockReasons: [...batch.blockReasons],
  }))
  const inbox = state.inbox.map((item) => ({ ...item }))
  const result: IngestResult = { ingested: 0, duplicates: 0, mismatched: 0 }

  for (const mail of inbox) {
    if (mail.ingested) continue
    const batch = batches
      .filter(
        (item) =>
          item.packageId === mail.packageId &&
          item.status !== 'released' &&
          item.files.some((ref) => ref.fileId === mail.fileId),
      )
      .sort((a, b) => b.rev - a.rev)[0]
    mail.ingested = true
    mail.batchId = batch?.id
    if (!batch) {
      // 无可续办批次（已放行 / 无此文件）：不进批次账，收件箱标记为待核来件
      mail.result = 'pending_check'
      result.mismatched += 1
      continue
    }

    // 重复判定：本批次或历史批次已入过同一平台单号
    const existing = batches.find((item) =>
      item.receipts.some((receipt) => receipt.receiptNo === mail.receiptNo),
    )
    const prior = existing?.receipts.find((receipt) => receipt.receiptNo === mail.receiptNo)
    const file = batch.files.find((ref) => ref.fileId === mail.fileId)

    if (prior && prior.state !== 'duplicate') {
      const dup: ReceiptRecord = {
        id: `receipt-${crypto.randomUUID()}`,
        receiptNo: mail.receiptNo,
        fileId: mail.fileId,
        fileName: file?.fileName ?? mail.fileId,
        claimedVersionId: mail.claimedVersionId,
        claimedVersionLabel: file?.versionLabel ?? '未知版本',
        issuedAt: mail.issuedAt,
        receivedAt: now(),
        state: 'duplicate',
        duplicateOf: prior.id,
        note: `重复回执，只入一次；正本批次 ${existing?.batchNo}`,
      }
      batch.receipts.push(dup)
      mail.result = 'duplicate'
      result.duplicates += 1
      continue
    }

    const matched = file && file.versionId === mail.claimedVersionId
    const claimLabel = matched
      ? file!.versionLabel
      : mail.claimedVersionId.startsWith('version-stale')
        ? '平台声称旧版(V1.0)'
        : '未知版本'
    const record: ReceiptRecord = {
      id: `receipt-${crypto.randomUUID()}`,
      receiptNo: mail.receiptNo,
      fileId: mail.fileId,
      fileName: file?.fileName ?? mail.fileId,
      claimedVersionId: mail.claimedVersionId,
      claimedVersionLabel: claimLabel,
      issuedAt: mail.issuedAt,
      receivedAt: now(),
      state: matched ? 'verified' : 'pending_check',
      ...(matched ? { checkedBy: actor, checkedAt: now() } : {}),
      note: matched ? '回执版本与批次固化引用一致，自动核对通过' : '回执声称版本与固化引用不一致',
    }
    batch.receipts.push(record)
    mail.result = record.state
    if (matched) result.ingested += 1
    else result.mismatched += 1
  }

  batches.forEach((batch) => {
    batch.status = recalcStatus(batch)
    batch.rev += 1
  })
  return { batches, inbox, result }
}

// ---------- 文件换版：只失效受影响的待审批节点与未核回执 ----------

const ROLE_ORDER: Record<string, number> = {
  业务复核: 1,
  技术安全审查: 2,
  高级出口管制审批: 3,
  合规审批: 4,
}

function invalidateNote(fileName: string, label: string) {
  return `文件 ${fileName} 换版至 ${label}，本节点失效重算`
}

/**
 * 依赖某文件的待审批（waiting/active/returned）步骤失效重算；
 * 已确认意见（approved）永久保留。旧节点以 invalidated 留痕、意见搬入 history，
 * 并按角色顺序追加一轮新的待办节点（首个 active）。
 * 未核（pending_check）回执置 obsolete；已核回执保留记录但不再满足新引用，
 * 必须等新版本回执重新核对。已放行批次的许可记录不受影响。
 */
export function invalidateForFileChange(
  batch: ReconciliationBatch,
  fileId: string,
  nextRef: BatchFileRef,
  actor: string,
): ReconciliationBatch {
  const rank: Record<BatchApprovalStep['level'], number> = { standard: 1, enhanced: 2, senior: 3 }

  // 1) 需要重签的角色：该文件依赖节点中所有未定论节点的角色（去重、保序）
  const resignedRoles: { role: string; assignee: string; level: BatchApprovalStep['level'] }[] = []
  batch.route.forEach((step) => {
    if (
      step.dependsOn.includes(fileId) &&
      step.status !== 'approved' &&
      step.status !== 'invalidated' &&
      !resignedRoles.some((item) => item.role === step.role)
    ) {
      resignedRoles.push({ role: step.role, assignee: step.assignee, level: step.level })
    }
  })
  resignedRoles.sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9))

  // 2) 旧节点留痕：受影响且未定论的节点置 invalidated，意见搬入 history
  const route: BatchApprovalStep[] = batch.route.map((step) => {
    if (!step.dependsOn.includes(fileId)) return { ...step, history: [...step.history] }
    if (step.status === 'approved') return { ...step, history: [...step.history] }
    if (step.status === 'invalidated') return { ...step, history: [...step.history] }
    return {
      ...step,
      status: 'invalidated' as const,
      invalidatedNote: invalidateNote(nextRef.fileName, nextRef.versionLabel),
      comment: '',
      decidedAt: undefined,
      decidedBy: undefined,
      history: [
        ...step.history,
        {
          by: step.decidedBy ?? step.assignee,
          passed: false,
          comment: `换版前意见（已失效）：${step.comment || '无补充意见'}`,
          at: step.decidedAt ?? now(),
        },
      ],
    }
  })

  // 3) 追加新一轮待办节点（按角色顺序），首个 active
  resignedRoles.forEach((item, index) => {
    route.push({
      id: `bstep-${crypto.randomUUID()}`,
      order: 0,
      role: item.role,
      assignee: item.assignee,
      level: item.level,
      status: index === 0 ? 'active' : 'waiting',
      dependsOn: Array.from(
        new Set([
          ...(batch.route.find((step) => step.role === item.role)?.dependsOn ?? []),
          fileId,
        ]),
      ),
      comment: '',
      history: [],
    })
  })

  route
    .sort((a, b) => {
      if (a.status === 'invalidated' && b.status !== 'invalidated') return 1
      if (b.status === 'invalidated' && a.status !== 'invalidated') return -1
      const diff = (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9)
      if (diff !== 0) return diff
      return rank[a.level] - rank[b.level]
    })
    .forEach((step, index) => {
      if (step.status !== 'invalidated') step.order = index + 1
    })

  // 4) 回执：未核失效，已核留痕
  const receipts = batch.receipts.map((receipt) => {
    if (receipt.fileId !== fileId) return { ...receipt }
    if (receipt.state === 'pending_check' || receipt.state === 'obsolete') {
      return {
        ...receipt,
        state: 'obsolete' as ReceiptState,
        previousState: receipt.state,
        note: `引用文件换版为 ${nextRef.versionLabel}，未核回执失效重算`,
      }
    }
    if (receipt.state === 'verified') {
      return {
        ...receipt,
        note: `${receipt.note ?? ''}（文件已换版，该回执对应旧版，仅供追溯；许可记录保留）`.trim(),
      }
    }
    return { ...receipt }
  })

  const next: ReconciliationBatch = {
    ...batch,
    files: batch.files.map((ref) =>
      ref.fileId === fileId
        ? { ...nextRef, digests: nextRef.digests.map((d) => ({ ...d })) }
        : { ...ref, digests: ref.digests.map((d) => ({ ...d })) },
    ),
    route,
    receipts,
    attempts: [
      ...batch.attempts,
      {
        id: `attempt-${crypto.randomUUID()}`,
        action: 'recompute',
        at: now(),
        ok: true,
        attempt: 1,
        actor,
      },
    ],
    blockReasons: [],
  }
  next.status = recalcStatus(next)
  next.rev += 1
  return next
}

// ---------- 旧数据回填 ----------

/**
 * 旧批次缺逐页摘要时，按首次送审内容（固化的文件引用版本，在现行文件版本链中
 * 仍可取回的）回填；引用版本已不可得的页标记 unresolvable，补不全不放行。
 */
export function backfillDigests(
  batch: ReconciliationBatch,
  files: MaterialFile[],
  actor: string,
): ReconciliationBatch {
  const next: ReconciliationBatch = {
    ...batch,
    files: batch.files.map((ref) => {
      const hasDigest = ref.digests.length > 0
      if (hasDigest && ref.digests.every((d) => d.state !== 'unresolvable')) return ref
      const file = files.find((item) => item.id === ref.fileId)
      const version = file?.versions.find((item) => item.id === ref.versionId)
      if (!version) {
        return {
          ...ref,
          digests:
            ref.digests.length > 0
              ? ref.digests
              : [
                  {
                    pageId: 'missing',
                    page: 0,
                    category: 'technical',
                    controlled: false,
                    hash: fnv1a(`unresolvable:${ref.fileId}:${ref.versionId}`),
                    redactedSummary: '首次送审版本已不可得，无法回填',
                    state: 'unresolvable',
                  },
                ],
        }
      }
      return {
        ...ref,
        digests: version.pages.map((page) => digestOf(page, 'backfilled')),
      }
    }),
    route: batch.route.map((step) => ({ ...step, history: [...step.history] })),
    receipts: batch.receipts.map((receipt) => ({ ...receipt })),
    attempts: [...batch.attempts],
    blockReasons: [...batch.blockReasons],
  }
  next.backfilled = true
  next.status = recalcStatus(next)
  next.rev += 1
  next.attempts.push({
    id: `attempt-${crypto.randomUUID()}`,
    action: 'backfill',
    at: now(),
    ok: true,
    attempt: 1,
    actor,
  })
  return next
}

// ---------- 放行 ----------

/** 两人同时确认只放行一个：以 rev 做乐观并发，先提交者成功 */
export function release(
  batch: ReconciliationBatch,
  expectedRev: number,
  actor: string,
):
  | { ok: true; batch: ReconciliationBatch; license: LicenseRecord }
  | { ok: false; conflict: boolean; reasons: string[] } {
  if (batch.rev !== expectedRev) {
    return { ok: false, conflict: true, reasons: ['批次已被另一会话更新，刷新后以最新批次重试'] }
  }
  if (batch.status === 'released') {
    return { ok: false, conflict: true, reasons: ['该批次已放行，重复确认被拒绝'] }
  }
  const reasons = releaseGate(batch)
  if (reasons.length) return { ok: false, conflict: false, reasons }

  const next: ReconciliationBatch = {
    ...batch,
    status: 'released',
    releasedAt: now(),
    releasedBy: actor,
    rev: batch.rev + 1,
    blockReasons: [],
    attempts: [
      ...batch.attempts,
      {
        id: `attempt-${crypto.randomUUID()}`,
        action: 'release',
        at: now(),
        ok: true,
        attempt: 1,
        actor,
      },
    ],
  }
  const license: LicenseRecord = {
    id: `license-${crypto.randomUUID()}`,
    batchId: batch.id,
    batchNo: batch.batchNo,
    packageId: batch.packageId,
    code: '',
    title: '',
    destination: '',
    receiptNos: batch.receipts.filter((r) => r.state === 'verified').map((r) => r.receiptNo),
    releasedAt: next.releasedAt!,
    releasedBy: actor,
    fingerprint: batch.fingerprint,
    retained: true,
  }
  return { ok: true, batch: next, license }
}

/** 导出：同一批次的审批 / 版本差异 / 回执 / 许可记录 */
export function buildBatchExport(
  batch: ReconciliationBatch,
  packageItem: MaterialPackage | undefined,
) {
  return {
    batchNo: batch.batchNo,
    packageCode: packageItem?.code,
    packageTitle: packageItem?.title,
    packageVersion: batch.packageVersionLabel,
    fingerprint: batch.fingerprint,
    status: batch.status,
    frozenAt: batch.frozenAt,
    releasedAt: batch.releasedAt,
    releasedBy: batch.releasedBy,
    files: batch.files.map((ref) => ({
      file: ref.fileName,
      version: ref.versionLabel,
      versionHash: ref.versionHash,
      pages: ref.digests.length,
      digests: ref.digests.map((digest) => ({
        page: digest.page,
        hash: digest.hash,
        state: digest.state,
        summary: digest.redactedSummary,
      })),
    })),
    approvalRoute: batch.route.map((step) => ({
      order: step.order,
      role: step.role,
      assignee: step.assignee,
      status: step.status,
      comment: step.comment,
      history: step.history,
    })),
    receipts: batch.receipts.map((receipt) => ({
      receiptNo: receipt.receiptNo,
      file: receipt.fileName,
      claimedVersion: receipt.claimedVersionLabel,
      state: receipt.state,
      receivedAt: receipt.receivedAt,
      checkedBy: receipt.checkedBy,
      note: receipt.note,
    })),
    attempts: batch.attempts,
  }
}
