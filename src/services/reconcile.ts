import type {
  ApprovalStep,
  BatchEvent,
  BatchOutboxEntry,
  BatchStatus,
  FrozenFileRef,
  FrozenPageDigest,
  LicenseReceipt,
  MaterialFile,
  MaterialPackage,
  PageReview,
  ReconcileBatch,
  WorkspaceState,
} from '@/types/domain'
import { createApprovalRoute } from './rules'

const now = () => new Date().toISOString()
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

export function event(
  type: BatchEvent['type'],
  detail: string,
  operator = '当前用户',
): BatchEvent {
  return { id: uid('batch-event'), at: now(), type, operator, detail }
}

/** FNV-1a 32 位逐页内容指纹：版本、页码、分类、受控与脱敏状态共同决定 */
export function pageDigest(versionHash: string, page: PageReview): string {
  const source = [
    versionHash,
    `p${page.page}`,
    page.category,
    page.controlled ? 'controlled' : 'normal',
    page.desensitized ? 'desensitized' : 'raw',
    page.note,
  ].join('|')
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `sha-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/** 审批步骤对文件的依赖关系：换版只让依赖它的待审批步骤失效 */
function stepDependsOnFile(step: ApprovalStep, file: MaterialFile): boolean {
  if (step.role.includes('业务复核')) return true
  if (step.role.includes('技术安全')) return file.kind === 'technical' || file.kind === 'drawing'
  if (step.role.includes('高级出口管制')) return true
  // 合规审批只核对声明与规则，不依赖具体文件版本
  return false
}

export function annotateRouteDependencies(
  route: ApprovalStep[],
  files: MaterialFile[],
): ApprovalStep[] {
  return route.map((step) => ({
    ...step,
    dependsOnFileIds: files.filter((file) => stepDependsOnFile(step, file)).map((file) => file.id),
  }))
}

function freezeFile(file: MaterialFile): FrozenFileRef {
  const version = file.versions.find((item) => item.id === file.referencedVersionId)
  if (!version) {
    return {
      fileId: file.id,
      name: file.name,
      kind: file.kind,
      versionId: file.referencedVersionId,
      versionLabel: '引用版本已缺失',
      versionHash: '',
      pages: [],
      digestComplete: false,
    }
  }
  const pages: FrozenPageDigest[] = version.pages.map((page) => ({
    pageId: page.id,
    page: page.page,
    category: page.category,
    controlled: page.controlled,
    desensitized: page.desensitized,
    contentDigest: pageDigest(version.hash, page),
    digestComplete: true,
  }))
  return {
    fileId: file.id,
    name: file.name,
    kind: file.kind,
    versionId: version.id,
    versionLabel: version.label,
    versionHash: version.hash,
    pages,
    digestComplete: pages.length > 0 && pages.every((page) => page.digestComplete),
  }
}

/** 送审时按各文件“引用版本”固化逐页脱敏摘要 */
export function buildFrozenFiles(files: MaterialFile[]): FrozenFileRef[] {
  return files.map(freezeFile)
}

export function deriveOpenStatus(batch: ReconcileBatch): {
  status: BatchStatus
  reason?: string
} {
  if (!batch.frozenDigestComplete) {
    return { status: 'blocked', reason: '逐页脱敏摘要不完整，旧数据无法回填，禁止放行。' }
  }
  const mismatch = batch.receipts.find((receipt) => receipt.status === 'mismatch')
  if (mismatch) {
    return {
      status: 'pending',
      reason: `回执 ${mismatch.receiptNo} 引用版本与送审固化版本不一致，停在待核。`,
    }
  }
  const unverified = batch.receipts.filter((receipt) => receipt.status === 'received')
  if (unverified.length) {
    return {
      status: 'pending',
      reason: `${unverified.length} 份平台回执尚未核验：${unverified
        .map((receipt) => receipt.receiptNo)
        .join('、')}。`,
    }
  }
  return { status: 'submitted' }
}

export function isBatchStale(batch: ReconcileBatch, files: MaterialFile[]): boolean {
  return batch.frozenFiles.some((frozen) => {
    const file = files.find((item) => item.id === frozen.fileId)
    return !file || file.referencedVersionId !== frozen.versionId
  })
}

export function receiptVersionMatches(
  batch: ReconcileBatch,
  fileRefs: { fileId: string; versionId: string }[],
  packageVersionId?: string,
): boolean {
  if (packageVersionId && packageVersionId !== batch.packageVersionId) return false
  return fileRefs.every((ref) => {
    const frozen = batch.frozenFiles.find((item) => item.fileId === ref.fileId)
    return frozen?.versionId === ref.versionId
  })
}

function findOpenBatch(state: WorkspaceState, packageId: string): ReconcileBatch | undefined {
  return [...state.batches]
    .reverse()
    .find((batch) => batch.packageId === packageId && batch.status !== 'released')
}

function requireBatch(state: WorkspaceState, batchId: string): ReconcileBatch {
  const batch = state.batches.find((item) => item.id === batchId)
  if (!batch) throw new Error('对账批次不存在')
  return batch
}

/** 把批次路线与状态镜像回资料包，审批页展示同一条批次路线 */
export function syncPackageFromBatch(
  packageItem: MaterialPackage,
  batch: ReconcileBatch,
): void {
  packageItem.approvalRoute = batch.route.map((step) => ({ ...step }))
  if (batch.status === 'released') packageItem.status = 'licensed'
  else if (batch.status === 'returned') packageItem.status = 'returned'
  else packageItem.status = 'reviewing'
  packageItem.updatedAt = now()
}

function nextPackageVersionLabel(packageItem: MaterialPackage): string {
  return `V${(packageItem.versions.length + 1).toFixed(1)}`
}

/** 送审：固化资料包版本、文件引用版本与逐页脱敏摘要，生成可续办批次 */
export function submitBatch(
  state: WorkspaceState,
  packageId: string,
  operator: string,
): ReconcileBatch {
  const packageItem = state.packages.find((item) => item.id === packageId)
  if (!packageItem) throw new Error('资料包不存在')
  const open = findOpenBatch(state, packageId)
  if (open && ['submitted', 'pending', 'invalidated'].includes(open.status)) {
    throw new Error('已有未关闭的对账批次，请在回执对账中续办，不要重复送审')
  }
  const packageFiles = state.files.filter((file) => file.packageId === packageId)
  if (packageFiles.some((file) => file.activeVersionId !== file.referencedVersionId)) {
    throw new Error('存在文件现行版本与引用版本错配，禁止跨版本拼装送审')
  }
  if (!packageFiles.length) throw new Error('资料包尚未拆解文件，无法固化送审')
  const rule = state.rules.find((item) => item.id === packageItem.matchedRuleId)
  if (!rule) throw new Error('未匹配到许可规则，不能送审')

  const label = nextPackageVersionLabel(packageItem)
  const packageVersion = {
    id: uid('package-version'),
    label,
    createdAt: now(),
    createdBy: operator,
    summary: `第 ${packageItem.currentRound + 1} 轮送审自动固化资料包版本。`,
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
  }
  packageItem.versions.push(packageVersion)
  packageItem.currentRound += 1
  packageItem.matchedRuleId = rule.id

  const frozenFiles = buildFrozenFiles(packageFiles)
  const frozenDigestComplete = frozenFiles.every((file) => file.digestComplete)
  const route = activateFirstStep(
    annotateRouteDependencies(createApprovalRoute(rule.approvalLevel), packageFiles),
  )
  const batch: ReconcileBatch = {
    id: uid('batch'),
    code: `${packageItem.code}-R${packageItem.currentRound}`,
    packageId,
    round: packageItem.currentRound,
    status: frozenDigestComplete ? 'submitted' : 'blocked',
    packageVersionId: packageVersion.id,
    packageVersionLabel: label,
    ruleId: rule.id,
    createdAt: now(),
    submittedBy: operator,
    revision: 1,
    frozenFiles,
    frozenDigestComplete,
    route,
    receipts: [],
    events: [
      event(
        'submit',
        `第 ${packageItem.currentRound} 轮送审，固化资料包 ${label} 与 ${frozenFiles.length} 个文件引用版本、逐页脱敏摘要。`,
        operator,
      ),
    ],
    pendingReason: frozenDigestComplete
      ? undefined
      : '逐页脱敏摘要不完整，旧数据无法回填，禁止放行。',
  }
  state.batches.push(batch)
  syncPackageFromBatch(packageItem, batch)
  return batch
}

function activateFirstStep(route: ApprovalStep[]): ApprovalStep[] {
  let firstOpenFound = false
  return route.map((step) => {
    if (step.status === 'approved' || step.status === 'returned') return step
    if (!firstOpenFound) {
      firstOpenFound = true
      return { ...step, status: 'active', confirmToken: uid('token') }
    }
    return { ...step, status: 'waiting', confirmToken: undefined }
  })
}

/**
 * 文件换版（或引用版本切换）：
 * 仅让依赖该文件的待审批步骤、以及未核验回执失效重算；
 * 已确认意见、已核验回执（许可记录）原样保留。
 */
export function invalidateBatchForFileChange(
  state: WorkspaceState,
  packageId: string,
  fileId: string,
  detail: string,
  operator = '当前用户',
): ReconcileBatch[] {
  const affected: ReconcileBatch[] = []
  state.batches
    .filter(
      (batch) =>
        batch.packageId === packageId &&
        batch.status !== 'released' &&
        batch.frozenFiles.some((frozen) => frozen.fileId === fileId),
    )
    .forEach((batch) => {
      let changed = false
      batch.route = batch.route.map((step) => {
        const depends = step.dependsOnFileIds?.includes(fileId)
        if (depends && (step.status === 'active' || step.status === 'waiting')) {
          changed = true
          return {
            ...step,
            status: 'invalidated',
            confirmToken: undefined,
            invalidatedReason: `依赖文件换版（${detail}），步骤待重算。`,
          }
        }
        return step
      })
      batch.receipts = batch.receipts.map((receipt) => {
        const touchesFile = receipt.fileRefs.some((ref) => ref.fileId === fileId)
        if (touchesFile && (receipt.status === 'received' || receipt.status === 'mismatch')) {
          changed = true
          return {
            ...receipt,
            status: 'invalidated',
            note: `${receipt.note ?? ''} 文件换版后未核验回执失效，等待平台按新版本重发。`.trim(),
          }
        }
        return receipt
      })
      if (changed) {
        batch.status = 'invalidated'
        batch.pendingReason = `文件 ${detail} 换版，相关待审批步骤与未核回执已失效，重算后续办。`
        batch.revision += 1
        batch.events.push(event('invalidate', batch.pendingReason, operator))
        affected.push(batch)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (packageItem) syncPackageFromBatch(packageItem, batch)
      }
    })
  return affected
}

/** 失效后按当前引用版本重算冻结内容，恢复被失效的步骤；已确认意见与许可记录不动 */
export function recomputeBatch(
  state: WorkspaceState,
  batchId: string,
  operator: string,
): ReconcileBatch {
  const batch = requireBatch(state, batchId)
  const packageItem = state.packages.find((item) => item.id === batch.packageId)
  if (!packageItem) throw new Error('资料包不存在')
  if (batch.status === 'released') throw new Error('已放行批次为许可记录，不允许重算')
  const packageFiles = state.files.filter((file) => file.packageId === batch.packageId)
  if (packageFiles.some((file) => file.activeVersionId !== file.referencedVersionId)) {
    throw new Error('仍有文件版本错配，请先在版本差异页确定唯一引用版本')
  }
  batch.frozenFiles = buildFrozenFiles(packageFiles)
  batch.frozenDigestComplete = batch.frozenFiles.every((file) => file.digestComplete)
  batch.route = annotateRouteDependencies(
    batch.route.map((step) =>
      step.status === 'invalidated'
        ? { ...step, status: 'waiting', invalidatedReason: undefined }
        : step,
    ),
    packageFiles,
  )
  batch.route = activateFirstStep(batch.route)
  // 已失效回执属于旧版本平台回执，保留记录但不参与新版本放行
  const derived = deriveOpenStatus(batch)
  batch.status = batch.frozenDigestComplete ? derived.status : 'blocked'
  batch.pendingReason = batch.frozenDigestComplete ? derived.reason : undefined
  batch.revision += 1
  batch.events.push(
    event(
      'recompute',
      `按当前引用版本重算冻结摘要与审批路线，已确认意见和已核验回执保留。`,
      operator,
    ),
  )
  syncPackageFromBatch(packageItem, batch)
  return batch
}

export interface ReceiptInput {
  receiptNo: string
  platform: string
  amount: number
  packageVersionId?: string
  fileRefs: { fileId: string; versionId: string }[]
}

/** 平台回执入账：重复回执只入一次；版本对不上批次停在待核 */
export function ingestReceipt(
  state: WorkspaceState,
  packageId: string,
  input: ReceiptInput,
  operator = '许可平台',
): ReconcileBatch {
  const batch = findOpenBatch(state, packageId)
  if (!batch) throw new Error('该资料包没有可续办的对账批次')
  const duplicated = state.batches.find((item) =>
    item.receipts.some((receipt) => receipt.receiptNo === input.receiptNo),
  )
  if (duplicated) {
    const existing = duplicated.receipts.find(
      (receipt) => receipt.receiptNo === input.receiptNo,
    )!
    existing.duplicateCount += 1
    duplicated.revision += 1
    duplicated.events.push(
      event(
        'duplicate',
        `平台重复推送回执 ${input.receiptNo}，仅保留首次入账（第 ${existing.duplicateCount} 次重复，已忽略）。`,
        operator,
      ),
    )
    return duplicated
  }
  const matches = receiptVersionMatches(batch, input.fileRefs, input.packageVersionId)
  const receipt: LicenseReceipt = {
    id: uid('receipt'),
    receiptNo: input.receiptNo,
    platform: input.platform,
    amount: input.amount,
    receivedAt: now(),
    status: matches ? 'received' : 'mismatch',
    packageVersionId: input.packageVersionId,
    fileRefs: input.fileRefs,
    duplicateCount: 0,
    note: matches
      ? undefined
      : '回执引用版本与送审固化版本不一致，必须人工核对，批次停在待核。',
  }
  batch.receipts.push(receipt)
  batch.revision += 1
  if (matches) {
    batch.status = 'pending'
    batch.pendingReason = `回执 ${input.receiptNo} 已到账待核验。`
    batch.events.push(event('receipt', `收到平台回执 ${input.receiptNo}，额度 ${input.amount}，版本一致，待人工核验。`, operator))
  } else {
    batch.status = 'pending'
    batch.pendingReason = `回执 ${input.receiptNo} 引用版本与送审固化版本不一致，停在待核。`
    batch.events.push(event('mismatch', batch.pendingReason, operator))
  }
  const packageItem = state.packages.find((item) => item.id === packageId)
  if (packageItem) syncPackageFromBatch(packageItem, batch)
  return batch
}

/** 人工核验回执：只有版本一致的未核回执可以核验通过 */
export function verifyReceipt(
  state: WorkspaceState,
  batchId: string,
  receiptId: string,
  operator: string,
): ReconcileBatch {
  const batch = requireBatch(state, batchId)
  const receipt = batch.receipts.find((item) => item.id === receiptId)
  if (!receipt) throw new Error('回执不存在')
  if (receipt.status === 'verified') throw new Error('该回执已核验，无需重复操作')
  if (receipt.status === 'invalidated') throw new Error('该回执已随文件换版失效，不能核验')
  if (receipt.status === 'mismatch') {
    throw new Error('版本不符的回执不得核验放行，请重算批次或等待平台按送审版本重发回执')
  }
  receipt.status = 'verified'
  receipt.verifiedAt = now()
  receipt.verifiedBy = operator
  batch.revision += 1
  batch.events.push(event('verify', `回执 ${receipt.receiptNo} 核验通过，许可记录保留。`, operator))
  const derived = deriveOpenStatus(batch)
  if (batch.status === 'pending' && derived.status === 'submitted') {
    batch.status = 'submitted'
    batch.pendingReason = undefined
  }
  const packageItem = state.packages.find((item) => item.id === batch.packageId)
  if (packageItem) syncPackageFromBatch(packageItem, batch)
  return batch
}

export interface DecideInput {
  batchId: string
  stepId: string
  decision: 'approve' | 'return'
  comment: string
  /** CAS 令牌：两人同时确认时，只有持当前有效令牌的一次写入成功 */
  confirmToken: string
  operator: string
}

/** 审批确认（乐观锁）：令牌过期/被他人先用即拒绝，保证两人同时确认只放行一个 */
export function decideBatchStep(state: WorkspaceState, input: DecideInput): ReconcileBatch {
  const batch = requireBatch(state, input.batchId)
  if (batch.status === 'released') throw new Error('批次已放行，审批步骤锁定')
  if (batch.status === 'invalidated') throw new Error('批次已因文件换版失效，请先重算再审批')
  if (batch.status === 'blocked') throw new Error('批次缺少脱敏摘要被阻断，不能审批')
  const step = batch.route.find((item) => item.id === input.stepId)
  if (!step) throw new Error('审批步骤不存在')
  if (step.status === 'approved') {
    throw new Error('该步骤已确认（可能由另一处理人同时操作），本次确认未放行')
  }
  if (step.status !== 'active') throw new Error('当前步骤不可审批')
  if (!step.confirmToken || step.confirmToken !== input.confirmToken) {
    throw new Error('审批令牌已失效或已被其他处理人使用：两人同时确认只放行一个，请刷新后重试')
  }

  step.comment = input.comment
  step.decidedAt = now()
  step.decidedRound = batch.round
  step.confirmToken = undefined
  if (input.decision === 'return') {
    step.status = 'returned'
    batch.status = 'returned'
    batch.pendingReason = '审批退回，补正后重新发起新一轮送审。'
    batch.events.push(event('return', `${step.role} 退回：${input.comment || '无补充意见'}`, input.operator))
  } else {
    step.status = 'approved'
    const next = batch.route.find((item) => item.order === step.order + 1)
    if (next && next.status !== 'approved') {
      next.status = 'active'
      next.confirmToken = uid('token')
    }
    batch.events.push(event('decide', `${step.role} 确认通过：${input.comment || '无补充意见'}`, input.operator))
  }
  batch.revision += 1
  const packageItem = state.packages.find((item) => item.id === batch.packageId)
  if (packageItem) syncPackageFromBatch(packageItem, batch)
  return batch
}

/** 放行：审批全部完成、回执全部核验且版本一致、摘要齐全且额度充足 */
export function releaseBatch(
  state: WorkspaceState,
  batchId: string,
  operator: string,
): ReconcileBatch {
  const batch = requireBatch(state, batchId)
  const packageItem = state.packages.find((item) => item.id === batch.packageId)
  if (!packageItem) throw new Error('资料包不存在')
  if (batch.status === 'released') throw new Error('批次已放行，许可记录不可重复写入')
  const problems: string[] = []
  if (!batch.frozenDigestComplete) problems.push('逐页脱敏摘要不完整')
  const pendingStep = batch.route.find((step) => step.status !== 'approved')
  if (pendingStep) problems.push(`审批步骤未全部完成（${pendingStep.role}）`)
  const badReceipts = batch.receipts.filter(
    (receipt) => receipt.status === 'received' || receipt.status === 'mismatch',
  )
  if (badReceipts.length) {
    problems.push(`存在未核/版本不符回执：${badReceipts.map((item) => item.receiptNo).join('、')}`)
  }
  if (!batch.receipts.some((receipt) => receipt.status === 'verified')) {
    problems.push('没有任何已核验的许可回执')
  }
  const packageFiles = state.files.filter((file) => file.packageId === batch.packageId)
  if (isBatchStale(batch, packageFiles)) problems.push('冻结版本与当前引用版本不一致，请先重算')
  const granted = batch.receipts
    .filter((receipt) => receipt.status === 'verified')
    .reduce((sum, receipt) => sum + receipt.amount, 0)
  if (packageItem.quotaUsed + granted > packageItem.quotaLimit) {
    problems.push(
      `额度不足：已用 ${packageItem.quotaUsed} + 回执额度 ${granted} 超过上限 ${packageItem.quotaLimit}`,
    )
  }
  if (problems.length) throw new Error(`批次不能放行：${problems.join('；')}`)

  packageItem.quotaUsed += granted
  batch.quotaUsedAfter = packageItem.quotaUsed
  batch.status = 'released'
  batch.releasedAt = now()
  batch.pendingReason = undefined
  batch.revision += 1
  batch.events.push(
    event('release', `全部审批与回执对账完成，扣减额度 ${granted}，批次放行并形成许可记录。`, operator),
  )
  syncPackageFromBatch(packageItem, batch)
  return batch
}

/**
 * 写入失败后留存完整批次，供整批重试。
 * expectedRevision：失败时库里实际停留的 revision（操作已把内存批次 +1，但未落库，
 * 因此常规写入失败处传 batch.revision - 1）。
 * pendingStateSnapshot：文件换版等伴随修改随整份工作区一起重放。
 */
export function buildOutboxEntry(
  batch: ReconcileBatch,
  failedUrl: string,
  reason: string,
  pendingStateSnapshot?: WorkspaceState,
  expectedRevision: number = batch.revision,
  requestId?: string,
): BatchOutboxEntry {
  return {
    id: uid('outbox'),
    batchId: batch.id,
    packageId: batch.packageId,
    failedAt: now(),
    failedUrl,
    reason,
    batch: structuredClone(batch),
    expectedRevision,
    attempts: 0,
    pendingStateSnapshot: pendingStateSnapshot
      ? structuredClone(pendingStateSnapshot)
      : undefined,
    requestId,
  }
}

/** 从完整批次重试：revision 一致才整批覆盖写入，保证幂等 */
export function retryBatchFromOutbox(
  state: WorkspaceState,
  entry: BatchOutboxEntry,
  operator: string,
): ReconcileBatch {
  const index = state.batches.findIndex((item) => item.id === entry.batchId)
  const current = index >= 0 ? state.batches[index] : undefined
  if (!current) throw new Error('原批次已不存在，无法整批重试')
  if (current.revision !== entry.expectedRevision) {
    throw new Error('批次在写入失败后已被其他操作更新，不能覆盖重试，请刷新后按最新批次续办')
  }
  const replayed = structuredClone(entry.batch)
  // 整批覆盖写入；重试事件不改变 revision（落库内容与失败时的完整批次一致）
  replayed.events.push(
    event(
      'retry',
      `第 ${entry.attempts + 1} 次从完整批次重试写入成功（${entry.failedUrl}）。`,
      operator,
    ),
  )
  state.batches[index] = replayed
  const packageItem = state.packages.find((item) => item.id === entry.packageId)
  if (packageItem) {
    syncPackageFromBatch(packageItem, replayed)
    if (typeof replayed.quotaUsedAfter === 'number') {
      packageItem.quotaUsed = replayed.quotaUsedAfter
    }
  }
  return replayed
}

/**
 * 旧数据迁移：批次缺逐页摘要时，按首次送审内容（冻结的引用版本当前页内容）回填；
 * 引用版本已不存在、补不全的批次保持 blocked，绝不放行。
 */
export function migrateWorkspace(state: WorkspaceState): WorkspaceState {
  state.batches.forEach((batch) => {
    let backfilled = false
    batch.frozenFiles.forEach((frozen) => {
      const file = state.files.find((item) => item.id === frozen.fileId)
      const version = file?.versions.find((item) => item.id === frozen.versionId)
      if (!version) {
        frozen.digestComplete = false
        return
      }
      const existingPageIds = new Set(frozen.pages.map((page) => page.pageId))
      version.pages.forEach((page) => {
        if (existingPageIds.has(page.id)) return
        frozen.pages.push({
          pageId: page.id,
          page: page.page,
          category: page.category,
          controlled: page.controlled,
          desensitized: page.desensitized,
          contentDigest: pageDigest(version.hash, page),
          digestComplete: true,
          backfilled: true,
        })
        backfilled = true
      })
      // 旧摘要为空也按首次送审内容重算回填
      frozen.pages.forEach((page) => {
        if (!page.contentDigest) {
          const source = version.pages.find((item) => item.id === page.pageId)
          if (source) {
            page.contentDigest = pageDigest(version.hash, source)
            page.digestComplete = true
            page.backfilled = true
            backfilled = true
          } else {
            page.digestComplete = false
          }
        }
      })
      frozen.versionHash = frozen.versionHash || version.hash
      frozen.versionLabel = frozen.versionLabel === '引用版本已缺失' ? version.label : frozen.versionLabel
      frozen.digestComplete = frozen.pages.length > 0 && frozen.pages.every((page) => page.digestComplete)
    })
    batch.frozenDigestComplete = batch.frozenFiles.every((file) => file.digestComplete)
    batch.events ??= []
    batch.receipts ??= []
    batch.route ??= []
    if (typeof batch.revision !== 'number') batch.revision = 1
    // 回填旧路线步骤的文件依赖与有效令牌
    if (batch.status !== 'released' && batch.status !== 'returned') {
      const packageFiles = state.files.filter((file) => file.packageId === batch.packageId)
      batch.route = annotateRouteDependencies(batch.route, packageFiles)
      const activeWithoutToken = batch.route.find(
        (step) => step.status === 'active' && !step.confirmToken,
      )
      if (activeWithoutToken) activeWithoutToken.confirmToken = uid('token')
    }
    if (backfilled) {
      batch.legacyBackfilled = true
      batch.backfilledAt = now()
      batch.events.push(
        event(
          'backfill',
          '检测到旧批次缺少逐页脱敏摘要，已按首次送审内容回填，可继续续办。',
          '系统迁移',
        ),
      )
    }
    if (!batch.frozenDigestComplete && batch.status !== 'released' && batch.status !== 'blocked') {
      batch.status = 'blocked'
      batch.pendingReason = '旧批次引用版本内容缺失，脱敏摘要补不全，禁止放行。'
      batch.events.push(event('block', batch.pendingReason, '系统迁移'))
    }
    // 批次与资料包镜像对齐（仅在不一致时，避免每次加载都改 updatedAt）
    const packageItem = state.packages.find((item) => item.id === batch.packageId)
    if (packageItem) {
      const expectedStatus =
        batch.status === 'released'
          ? 'licensed'
          : batch.status === 'returned'
            ? 'returned'
            : 'reviewing'
      const routeDiffers =
        packageItem.approvalRoute.length !== batch.route.length ||
        packageItem.approvalRoute.some(
          (step, index) => step.status !== batch.route[index]?.status,
        )
      if (packageItem.status !== expectedStatus || routeDiffers) {
        syncPackageFromBatch(packageItem, batch)
      }
    }
  })
  return state
}
