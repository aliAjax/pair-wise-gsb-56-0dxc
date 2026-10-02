export type MaterialCategory = 'drawing' | 'technical' | 'software'
export type PackageStatus =
  | 'draft'
  | 'validating'
  | 'reviewing'
  | 'returned'
  | 'approved'
  | 'licensed'
  | 'locked'
export type ApprovalLevel = 'standard' | 'enhanced' | 'senior'
export type FindingLevel = 'high' | 'medium' | 'low'
export type FindingType = 'missing-declaration' | 'escalation' | 'version-mismatch' | 'unclassified-page' | 'quota'

export interface PageReview {
  id: string
  page: number
  category: MaterialCategory
  controlled: boolean
  desensitized: boolean
  note: string
  reviewer: string
  reviewedAt?: string
}

export interface FileVersion {
  id: string
  label: string
  uploadedAt: string
  hash: string
  sizeKb: number
  pages: PageReview[]
  changeSummary: string
}

export interface MaterialFile {
  id: string
  packageId: string
  name: string
  kind: MaterialCategory
  activeVersionId: string
  referencedVersionId: string
  versions: FileVersion[]
}

export interface ApprovalStep {
  id: string
  order: number
  role: string
  assignee: string
  level: ApprovalLevel
  status: 'waiting' | 'active' | 'approved' | 'returned'
  comment: string
  decidedAt?: string
}

export interface PackageVersion {
  id: string
  label: string
  createdAt: string
  createdBy: string
  summary: string
  snapshot: {
    title: string
    category: MaterialCategory
    destination: string
    endUse: string
    technologyTags: string[]
    personnelScopes: string[]
    declarations: string[]
    activeFileVersions: Record<string, string>
  }
}

export interface ReviewComment {
  id: string
  packageId: string
  author: string
  content: string
  createdAt: string
  round: number
}

export interface MaterialPackage {
  id: string
  code: string
  title: string
  category: MaterialCategory
  applicant: string
  recipient: string
  destination: string
  endUse: string
  technologyTags: string[]
  personnelScopes: string[]
  declarations: string[]
  status: PackageStatus
  matchedRuleId?: string
  approvalRoute: ApprovalStep[]
  currentRound: number
  quotaUsed: number
  quotaLimit: number
  createdAt: string
  updatedAt: string
  versions: PackageVersion[]
}

export interface LicenseRule {
  id: string
  name: string
  categories: MaterialCategory[]
  destinations: string[]
  technologyTags: string[]
  personnelScopes: string[]
  requiredDeclarations: string[]
  approvalLevel: ApprovalLevel
  quotaLimit: number
  explanation: string
}

export interface ValidationFinding {
  id: string
  packageId: string
  type: FindingType
  level: FindingLevel
  message: string
  action: string
  ruleId?: string
}

export interface AuditEntry {
  id: string
  packageId?: string
  action: string
  target: string
  operator: string
  detail: string
  createdAt: string
}

export interface WorkspaceState {
  packages: MaterialPackage[]
  files: MaterialFile[]
  rules: LicenseRule[]
  findings: ValidationFinding[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  batches: ReconciliationBatch[]
  inbox: PlatformReceipt[]
  pendingActions: PendingAction[]
  licenses: LicenseRecord[]
}

export interface VersionDiff {
  id: string
  field: string
  before: string
  after: string
  kind: 'package' | 'file'
}

// ============ 许可回执对账批次 ============

export type BatchStatus =
  | 'frozen' // 已固化送审（首批审批步骤未开始或未完成时的基础态）
  | 'in_approval' // 审批中
  | 'pending_receipt' // 审批通过，等待/核对许可回执
  | 'pending_check' // 回执版本对不上，停在待核
  | 'released' // 已放行（许可记录生效）
  | 'blocked' // 阻断：摘要补不全等
  | 'write_failed' // 动作写入失败，待从完整批次重试

export type PageDigestState = 'ok' | 'backfilled' | 'unresolvable'

/** 送审时固化的逐页脱敏摘要 */
export interface PageDigest {
  pageId: string
  page: number
  category: MaterialCategory
  controlled: boolean
  /** 脱敏摘要内容指纹（哈希） */
  hash: string
  /** 脱敏摘要原文，便于展示与旧数据回填 */
  redactedSummary: string
  /** ok=送审时固化；backfilled=按首次送审内容回填；unresolvable=补不全 */
  state: PageDigestState
}

export interface BatchFileRef {
  fileId: string
  fileName: string
  /** 固化的文件引用版本 */
  versionId: string
  versionLabel: string
  versionHash: string
  digests: PageDigest[]
}

export type BatchStepStatus = 'waiting' | 'active' | 'approved' | 'returned' | 'invalidated'

/** 批次审批路线节点；与资料包审批路线是两套账，节点携带文件依赖 */
export interface BatchApprovalStep {
  id: string
  order: number
  role: string
  assignee: string
  level: ApprovalLevel
  status: BatchStepStatus
  /** 依赖的文件版本 fileId#versionId；只重算受文件换版影响的待审批节点 */
  dependsOn: string[]
  comment: string
  decidedAt?: string
  decidedBy?: string
  /** 历史意见（含换版重算前的意见，永久保留） */
  history: { by: string; passed: boolean; comment: string; at: string }[]
  invalidatedNote?: string
}

export type ReceiptState =
  | 'pending_check' // 已入账，但声称版本与批次引用对不上
  | 'verified' // 已核对通过：版本逐页摘要一致
  | 'obsolete' // 引用文件换版后，未核回执被失效重算
  | 'duplicate' // 重复回执，只入一次账，不参与放行

export interface ReceiptRecord {
  id: string
  /** 许可平台回执单号，重复判定键 */
  receiptNo: string
  fileId: string
  fileName: string
  /** 回执声称的文件版本 */
  claimedVersionId: string
  claimedVersionLabel: string
  issuedAt: string
  receivedAt: string
  state: ReceiptState
  checkedBy?: string
  checkedAt?: string
  note?: string
  /** duplicate：重复于哪张账单；obsolete：失效前状态 */
  duplicateOf?: string
  previousState?: ReceiptState
}

/** 平台收件箱原始来件 */
export interface PlatformReceipt {
  id: string
  receiptNo: string
  packageId: string
  fileId: string
  claimedVersionId: string
  issuedAt: string
  ingested: boolean
  /** duplicate / pending_check / verified 入账结果 */
  result?: ReceiptState
  batchId?: string
}

export interface BatchWriteAttempt {
  id: string
  action: string
  at: string
  ok: boolean
  error?: string
  attempt: number
  actor: string
}

export interface ReconciliationBatch {
  id: string
  batchNo: string
  packageId: string
  /** 送审时资料包版本（PackageVersion id）与版本号 */
  packageVersionId: string
  packageVersionLabel: string
  /** 送审时资料包整体指纹 */
  fingerprint: string
  status: BatchStatus
  files: BatchFileRef[]
  route: BatchApprovalStep[]
  receipts: ReceiptRecord[]
  attempts: BatchWriteAttempt[]
  /** 乐观并发修订号，两人同时确认只放行一个 */
  rev: number
  frozenAt: string
  frozenBy: string
  releasedAt?: string
  releasedBy?: string
  /** 旧数据（缺摘要）已按首次送审内容回填 */
  backfilled?: boolean
  blockReasons: string[]
  note?: string
}

/** 待重试动作：动作 + 动作发生时的完整批次快照 */
export interface PendingAction {
  id: string
  batchId: string
  action: string
  actor: string
  payload: Record<string, unknown>
  fullBatchSnapshot: ReconciliationBatch
  createdAt: string
  attempts: number
  lastError?: string
}

export interface LicenseRecord {
  id: string
  batchId: string
  batchNo: string
  packageId: string
  code: string
  title: string
  destination: string
  receiptNos: string[]
  releasedAt: string
  releasedBy: string
  fingerprint: string
  /** 放行后文件换版，许可记录保留 */
  retained: boolean
}
