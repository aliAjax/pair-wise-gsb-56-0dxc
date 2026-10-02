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

export type ApprovalStepStatus =
  | 'waiting'
  | 'active'
  | 'approved'
  | 'returned'
  | 'invalidated'

export interface ApprovalStep {
  id: string
  order: number
  role: string
  assignee: string
  level: ApprovalLevel
  status: ApprovalStepStatus
  comment: string
  decidedAt?: string
  /** 依赖的文件版本（固化于对账批次），换版据此只失效相关步骤 */
  dependsOnFileIds?: string[]
  /** 乐观锁令牌：两人同时确认时只有持有效令牌的一次能放行 */
  confirmToken?: string
  /** 已确认意见归属的送审轮次，已确认意见在换版后保留 */
  decidedRound?: number
  /** 失效原因，供审批页面解释为何需要重算 */
  invalidatedReason?: string
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
  batches: ReconcileBatch[]
}

export interface VersionDiff {
  id: string
  field: string
  before: string
  after: string
  kind: 'package' | 'file' | 'batch'
  batchId?: string
}

// ===== 续办对账批次 =====

/**
 * 批次生命周期：
 * submitted   已送审（许可平台回执晚到、在途，可续办）
 * pending     待核（回执版本对不上、或有未核回执，人工核对前不放行）
 * invalidated 文件换版后依赖步骤与未核回执被失效，等待重算
 * returned    审批退回，补正后重新发起
 * released    已放行（许可记录永久保留，之后任何换版都不回滚）
 * blocked     旧批次逐页脱敏摘要补不全，禁止放行
 */
export type BatchStatus =
  | 'submitted'
  | 'pending'
  | 'invalidated'
  | 'returned'
  | 'released'
  | 'blocked'

export type ReceiptStatus = 'received' | 'verified' | 'mismatch' | 'invalidated'

/** 固化在批次中的逐页脱敏摘要 */
export interface FrozenPageDigest {
  pageId: string
  page: number
  category: MaterialCategory
  controlled: boolean
  desensitized: boolean
  /** 逐页内容指纹，用于识别“旧回执仍放行旧版”的情形 */
  contentDigest: string
  /** 旧数据迁移回填的摘要无原始内容时为 false，补不全则批次 blocked */
  digestComplete: boolean
  backfilled?: boolean
}

/** 固化在批次中的文件引用版本及其逐页摘要 */
export interface FrozenFileRef {
  fileId: string
  name: string
  kind: MaterialCategory
  versionId: string
  versionLabel: string
  versionHash: string
  pages: FrozenPageDigest[]
  digestComplete: boolean
}

export type LicenseReceipt = {
  id: string
  /** 许可平台回执编号，全局唯一：重复回执只入一次 */
  receiptNo: string
  platform: string
  amount: number
  receivedAt: string
  status: ReceiptStatus
  /** 回执声明引用的资料包版本与文件版本，用于和固化版本对账 */
  packageVersionId?: string
  fileRefs: { fileId: string; versionId: string }[]
  duplicateCount: number
  verifiedAt?: string
  verifiedBy?: string
  note?: string
}

export interface BatchEvent {
  id: string
  at: string
  type:
    | 'submit'
    | 'receipt'
    | 'duplicate'
    | 'verify'
    | 'mismatch'
    | 'invalidate'
    | 'recompute'
    | 'decide'
    | 'return'
    | 'release'
    | 'block'
    | 'retry'
    | 'backfill'
  operator: string
  detail: string
}

export interface ReconcileBatch {
  id: string
  code: string
  packageId: string
  round: number
  status: BatchStatus
  packageVersionId: string
  packageVersionLabel: string
  ruleId?: string
  createdAt: string
  submittedBy: string
  /** 乐观锁版本号：每次成功写入 +1，写入失败的整批重放靠它做幂等闸门 */
  revision: number
  frozenFiles: FrozenFileRef[]
  frozenDigestComplete: boolean
  route: ApprovalStep[]
  receipts: LicenseReceipt[]
  events: BatchEvent[]
  releasedAt?: string
  /** 放行时的额度占用，整批重试时据此同步许可记录 */
  quotaUsedAfter?: number
  /** 旧数据缺摘要、按首次送审内容回填的标记 */
  legacyBackfilled?: boolean
  backfilledAt?: string
  pendingReason?: string
}

/** 写入失败后留存的完整批次（可续办的离线重放箱） */
export interface BatchOutboxEntry {
  id: string
  batchId: string
  packageId: string
  failedAt: string
  failedUrl: string
  reason: string
  /** 失败时批次的完整快照，重试时整批提交 */
  batch: ReconcileBatch
  /** 期望的前置 revision，与当前批次不一致时不允许覆盖写入 */
  expectedRevision: number
  attempts: number
  /** 失败时尚未落库的整份工作区，重试时整体提交，保证批次与文件版本不分裂 */
  pendingStateSnapshot?: WorkspaceState
  /** 同一次写入请求产生的多条失败记录（如一次换版影响多个批次）共享，任一条重放成功即整组移除 */
  requestId?: string
}

/** getWorkspace 实际返回：工作区 + 写入失败待重试箱 */
export interface WorkspaceResponse extends WorkspaceState {
  outbox: BatchOutboxEntry[]
}
