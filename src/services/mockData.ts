import type {
  BatchEvent,
  FileVersion,
  FrozenFileRef,
  LicenseReceipt,
  LicenseRule,
  MaterialFile,
  MaterialPackage,
  PageReview,
  ReconcileBatch,
  WorkspaceState,
} from '@/types/domain'
import { createApprovalRoute, validatePackage } from './rules'
import { pageDigest } from './reconcile'

function pages(
  count: number,
  reviewed: boolean,
  overrides: Partial<PageReview> = {},
): PageReview[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `page-${crypto.randomUUID()}`,
    page: index + 1,
    category: 'technical',
    controlled: false,
    desensitized: false,
    note: '',
    reviewer: reviewed ? '王合规' : '',
    reviewedAt: reviewed ? '2026-09-27T04:00:00.000Z' : undefined,
    ...overrides,
  }))
}

function version(
  label: string,
  pageCount: number,
  reviewed: boolean,
  hash: string,
  summary: string,
  overrides: Partial<PageReview> = {},
): FileVersion {
  return {
    id: `version-${crypto.randomUUID()}`,
    label,
    uploadedAt: '2026-09-27T02:20:00.000Z',
    hash,
    sizeKb: 1280 + pageCount * 96,
    pages: pages(pageCount, reviewed, overrides),
    changeSummary: summary,
  }
}

const rules: LicenseRule[] = [
  {
    id: 'rule-sg-composite',
    name: '新加坡复合材料工艺资料许可规则',
    categories: ['drawing', 'technical'],
    destinations: ['新加坡'],
    technologyTags: ['复合材料', '工艺参数'],
    personnelScopes: [],
    requiredDeclarations: ['最终用户声明', '最终用途声明', '不扩散声明'],
    approvalLevel: 'enhanced',
    quotaLimit: 80,
    explanation: '涉及复合材料铺层、固化参数及模具资料，适用升级审批和额度扣减。',
  },
  {
    id: 'rule-de-software',
    name: '德国工业软件出口许可规则',
    categories: ['software'],
    destinations: ['德国'],
    technologyTags: ['工业控制', '加密算法'],
    personnelScopes: [],
    requiredDeclarations: ['最终用户声明', '软件用途声明'],
    approvalLevel: 'standard',
    quotaLimit: 120,
    explanation: '工业控制软件用于民用生产，不涉及特别人员范围时按标准审批。',
  },
  {
    id: 'rule-us-lithography',
    name: '美国半导体光刻技术高级审批规则',
    categories: ['drawing', 'technical', 'software'],
    destinations: ['美国'],
    technologyTags: ['半导体', '光刻', '精密运动控制'],
    personnelScopes: ['外籍人员', '第三方承包商'],
    requiredDeclarations: ['最终用户声明', '最终用途声明', '人员接触清单', '技术转移声明'],
    approvalLevel: 'senior',
    quotaLimit: 30,
    explanation: '技术参数和人员范围均触发高级审批，需核对第三方接触和最终用途。',
  },
  {
    id: 'rule-my-general',
    name: '马来西亚一般技术资料许可规则',
    categories: ['drawing', 'technical', 'software'],
    destinations: ['马来西亚'],
    technologyTags: [],
    personnelScopes: [],
    requiredDeclarations: ['最终用户声明', '最终用途声明'],
    approvalLevel: 'standard',
    quotaLimit: 100,
    explanation: '一般民用技术资料按标准路线审批，仍需逐页完成受控属性核对。',
  },
  {
    id: 'rule-global-default',
    name: '全球兜底出口管制规则',
    categories: ['drawing', 'technical', 'software'],
    destinations: ['*'],
    technologyTags: [],
    personnelScopes: [],
    requiredDeclarations: ['最终用户声明'],
    approvalLevel: 'enhanced',
    quotaLimit: 20,
    explanation: '未命中特定国家规则时使用兜底路线，并要求人工确认科技参数。',
  },
]

const v1 = version('V1.0', 8, true, 'A41C-90D2', '初始工艺规程')
const v2 = version('V1.1', 9, false, 'D9F2-114A', '新增铺层顺序与固化曲线', {
  controlled: true,
})
const sw1 = version('V2.0', 5, true, '7EA2-319F', '标准控制器软件包')
const sw2 = version('V2.1', 6, true, '52CC-8D10', '修复通信模块并更新校验文件')
const us1 = version('V3.2', 12, false, 'E11A-77B4', '光刻设备参数说明', { controlled: true })
const my1 = version('V1.0', 4, false, '88AB-3411', '厂房布置示意')

export function createInitialState(): WorkspaceState {
  const now = '2026-09-28T06:00:00.000Z'
  const packages: MaterialPackage[] = [
    {
      id: 'pkg-001',
      code: 'EC-2026-001',
      title: '复材机翼铺层工艺资料包',
      category: 'technical',
      applicant: '周明',
      recipient: 'Asia Aero Manufacturing Pte. Ltd.',
      destination: '新加坡',
      endUse: '民用航空结构件试制',
      technologyTags: ['复合材料', '工艺参数'],
      personnelScopes: ['第三方承包商'],
      declarations: ['最终用户声明', '最终用途声明'],
      status: 'reviewing',
      matchedRuleId: 'rule-sg-composite',
      approvalRoute: createApprovalRoute('enhanced'),
      currentRound: 1,
      quotaUsed: 36,
      quotaLimit: 80,
      createdAt: '2026-09-20T02:10:00.000Z',
      updatedAt: now,
      versions: [],
    },
    {
      id: 'pkg-002',
      code: 'EC-2026-002',
      title: '工业控制器基础软件包',
      category: 'software',
      applicant: '赵敏',
      recipient: 'Rhein Automation GmbH',
      destination: '德国',
      endUse: '民用生产线控制器维护',
      technologyTags: ['工业控制', '加密算法'],
      personnelScopes: [],
      declarations: ['最终用户声明', '软件用途声明'],
      status: 'approved',
      matchedRuleId: 'rule-de-software',
      approvalRoute: createApprovalRoute('standard').map((step) => ({
        ...step,
        status: 'approved',
        comment: '资料范围和声明完整。',
        decidedAt: '2026-09-27T03:20:00.000Z',
      })),
      currentRound: 1,
      quotaUsed: 42,
      quotaLimit: 120,
      createdAt: '2026-09-18T04:30:00.000Z',
      updatedAt: '2026-09-27T03:20:00.000Z',
      versions: [],
    },
    {
      id: 'pkg-003',
      code: 'EC-2026-003',
      title: '精密光刻运动控制技术说明',
      category: 'technical',
      applicant: '林越',
      recipient: 'Pacific Semiconductor Research Inc.',
      destination: '美国',
      endUse: '半导体工艺联合研究',
      technologyTags: ['半导体', '光刻', '精密运动控制'],
      personnelScopes: ['外籍人员', '第三方承包商'],
      declarations: ['最终用户声明', '最终用途声明', '技术转移声明'],
      status: 'returned',
      matchedRuleId: 'rule-us-lithography',
      approvalRoute: createApprovalRoute('senior').map((step, index) =>
        index === 0
          ? {
              ...step,
              status: 'returned' as const,
              comment: '缺少人员接触清单。',
              decidedAt: '2026-09-26T08:10:00.000Z',
            }
          : { ...step },
      ),
      currentRound: 2,
      quotaUsed: 27,
      quotaLimit: 30,
      createdAt: '2026-09-16T01:15:00.000Z',
      updatedAt: '2026-09-26T08:10:00.000Z',
      versions: [],
    },
    {
      id: 'pkg-004',
      code: 'EC-2026-004',
      title: '联合厂房电气布置图',
      category: 'drawing',
      applicant: '许航',
      recipient: 'Kuala Engineering Sdn. Bhd.',
      destination: '马来西亚',
      endUse: '厂房施工布置',
      technologyTags: ['通用电气'],
      personnelScopes: [],
      declarations: ['最终用户声明'],
      status: 'draft',
      matchedRuleId: 'rule-my-general',
      approvalRoute: [],
      currentRound: 0,
      quotaUsed: 8,
      quotaLimit: 100,
      createdAt: '2026-09-28T00:20:00.000Z',
      updatedAt: now,
      versions: [],
    },
  ]

  const files: MaterialFile[] = [
    {
      id: 'file-001-a',
      packageId: 'pkg-001',
      name: '铺层工艺规程.pdf',
      kind: 'technical',
      activeVersionId: v2.id,
      referencedVersionId: v2.id,
      versions: [v1, v2],
    },
    {
      id: 'file-001-b',
      packageId: 'pkg-001',
      name: '模具装配图.dwg',
      kind: 'drawing',
      activeVersionId: v1.id,
      referencedVersionId: v1.id,
      versions: [v1],
    },
    {
      id: 'file-002-a',
      packageId: 'pkg-002',
      name: 'controller-runtime.zip',
      kind: 'software',
      activeVersionId: sw2.id,
      referencedVersionId: sw2.id,
      versions: [sw1, sw2],
    },
    {
      id: 'file-003-a',
      packageId: 'pkg-003',
      name: '光刻平台运动控制说明.pdf',
      kind: 'technical',
      activeVersionId: us1.id,
      referencedVersionId: us1.id,
      versions: [us1],
    },
    {
      id: 'file-004-a',
      packageId: 'pkg-004',
      name: '厂房电气总平面图.dwg',
      kind: 'drawing',
      activeVersionId: my1.id,
      referencedVersionId: my1.id,
      versions: [my1],
    },
  ]

  packages.forEach((packageItem) => {
    const summary =
      packageItem.status === 'draft'
        ? '初始创建资料包。'
        : '完成申报资料汇总并进入审批。'
    packageItem.versions.push({
      id: `pkg-version-${crypto.randomUUID()}`,
      label: 'V1.0',
      createdAt: packageItem.createdAt,
      createdBy: packageItem.applicant,
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
          files
            .filter((file) => file.packageId === packageItem.id)
            .map((file) => [file.id, file.activeVersionId]),
        ),
      },
    })
    if (packageItem.id === 'pkg-001') {
      packageItem.versions.push({
        id: 'pkg-version-pkg-001-v1-1',
        label: 'V1.1',
        createdAt: '2026-09-27T05:30:00.000Z',
        createdBy: '周明',
        summary: '新增最终用途声明要求，并调整工艺参数资料范围。',
        snapshot: {
          title: packageItem.title,
          category: packageItem.category,
          destination: packageItem.destination,
          endUse: '民用航空结构件试制',
          technologyTags: [...packageItem.technologyTags],
          personnelScopes: [...packageItem.personnelScopes],
          declarations: ['最终用户声明'],
          activeFileVersions: {
            'file-001-a': v1.id,
            'file-001-b': v1.id,
          },
        },
      })
      packageItem.versions.push({
        id: 'pkg-version-pkg-001-v2-0',
        label: 'V2.0',
        createdAt: '2026-09-28T01:00:00.000Z',
        createdBy: '周明',
        summary: '第 1 轮送审自动固化资料包版本。',
        snapshot: {
          title: packageItem.title,
          category: packageItem.category,
          destination: packageItem.destination,
          endUse: packageItem.endUse,
          technologyTags: [...packageItem.technologyTags],
          personnelScopes: [...packageItem.personnelScopes],
          declarations: [...packageItem.declarations],
          activeFileVersions: {
            'file-001-a': v2.id,
            'file-001-b': v1.id,
          },
        },
      })
    }
  })

  // ===== 续办对账批次种子 =====

  function seedEvent(
    type: BatchEvent['type'],
    detail: string,
    at: string,
    operator = '当前用户',
  ): BatchEvent {
    return { id: `batch-event-${crypto.randomUUID()}`, at, type, operator, detail }
  }

  /** 旧批次风格的冻结引用：逐页摘要留空，由迁移逻辑按首次送审内容回填 */
  function legacyFrozen(file: MaterialFile, version: FileVersion): FrozenFileRef {
    return {
      fileId: file.id,
      name: file.name,
      kind: file.kind,
      versionId: version.id,
      versionLabel: version.label,
      versionHash: version.hash,
      pages: [],
      digestComplete: false,
    }
  }

  function fullFrozen(file: MaterialFile, version: FileVersion): FrozenFileRef {
    return {
      fileId: file.id,
      name: file.name,
      kind: file.kind,
      versionId: version.id,
      versionLabel: version.label,
      versionHash: version.hash,
      pages: version.pages.map((page) => ({
        pageId: page.id,
        page: page.page,
        category: page.category,
        controlled: page.controlled,
        desensitized: page.desensitized,
        contentDigest: pageDigest(version.hash, page),
        digestComplete: true,
      })),
      digestComplete: true,
    }
  }

  const pkg001 = packages.find((item) => item.id === 'pkg-001')!
  const file001a = files.find((item) => item.id === 'file-001-a')!
  const file001b = files.find((item) => item.id === 'file-001-b')!
  const file002a = files.find((item) => item.id === 'file-002-a')!
  const file004a = files.find((item) => item.id === 'file-004-a')!

  const batchARoute = createApprovalRoute('enhanced').map((step, index) => {
    const depends = [file001a.id, file001b.id].filter(() => step.role !== '合规审批')
    if (index === 0) {
      return {
        ...step,
        status: 'approved' as const,
        comment: '资料范围与送审固化版本一致。',
        decidedAt: '2026-09-28T07:10:00.000Z',
        decidedRound: 1,
        dependsOnFileIds: depends,
      }
    }
    if (index === 1) {
      return {
        ...step,
        status: 'approved' as const,
        comment: '第 7 页受控参数已按脱敏版本核对。',
        decidedAt: '2026-09-28T08:05:00.000Z',
        decidedRound: 1,
        dependsOnFileIds: [file001a.id, file001b.id],
      }
    }
    return {
      ...step,
      status: 'active' as const,
      confirmToken: 'seed-token-batch-a-compliance',
      dependsOnFileIds: [],
    }
  })
  pkg001.approvalRoute = batchARoute

  const receiptA1: LicenseReceipt = {
    id: 'receipt-a1',
    receiptNo: 'JTC-2026-1041',
    platform: '新加坡贸易信息化平台',
    amount: 20,
    receivedAt: '2026-09-28T09:00:00.000Z',
    status: 'verified',
    packageVersionId: 'pkg-version-pkg-001-v2-0',
    fileRefs: [
      { fileId: 'file-001-a', versionId: v2.id },
      { fileId: 'file-001-b', versionId: v1.id },
    ],
    duplicateCount: 1,
    verifiedAt: '2026-09-28T09:40:00.000Z',
    verifiedBy: '合规专员',
    note: '平台曾重复推送一次，系统仅入账首次。',
  }
  const receiptA2: LicenseReceipt = {
    id: 'receipt-a2',
    receiptNo: 'JTC-2026-1042',
    platform: '新加坡贸易信息化平台',
    amount: 10,
    receivedAt: '2026-09-30T02:15:00.000Z',
    status: 'received',
    packageVersionId: 'pkg-version-pkg-001-v2-0',
    fileRefs: [
      { fileId: 'file-001-a', versionId: v2.id },
      { fileId: 'file-001-b', versionId: v1.id },
    ],
    duplicateCount: 0,
  }
  // 旧版回执（引用已失效的 V1.0），文件换版后旧回执不得放行 → 待核
  const receiptA3: LicenseReceipt = {
    id: 'receipt-a3',
    receiptNo: 'JTC-2026-0999',
    platform: '新加坡贸易信息化平台',
    amount: 6,
    receivedAt: '2026-10-01T11:30:00.000Z',
    status: 'mismatch',
    packageVersionId: 'pkg-version-pkg-001-v1-1',
    fileRefs: [
      { fileId: 'file-001-a', versionId: v1.id },
      { fileId: 'file-001-b', versionId: v1.id },
    ],
    duplicateCount: 0,
    note: '回执引用版本与送审固化版本不一致，必须人工核对，批次停在待核。',
  }

  const batchA: ReconcileBatch = {
    id: 'batch-pkg-001-r1',
    code: 'EC-2026-001-R1',
    packageId: 'pkg-001',
    round: 1,
    status: 'pending',
    packageVersionId: 'pkg-version-pkg-001-v2-0',
    packageVersionLabel: 'V2.0',
    ruleId: 'rule-sg-composite',
    createdAt: '2026-09-28T06:30:00.000Z',
    submittedBy: '周明',
    revision: 4,
    frozenFiles: [fullFrozen(file001a, v2), fullFrozen(file001b, v1)],
    frozenDigestComplete: true,
    route: batchARoute,
    receipts: [receiptA1, receiptA2, receiptA3],
    events: [
      seedEvent('submit', '第 1 轮送审，固化资料包 V2.0 与 2 个文件引用版本、逐页脱敏摘要。', '2026-09-28T06:30:00.000Z', '周明'),
      seedEvent('receipt', '收到平台回执 JTC-2026-1041，额度 20，版本一致，待人工核验。', '2026-09-28T09:00:00.000Z'),
      seedEvent('duplicate', '平台重复推送回执 JTC-2026-1041，仅保留首次入账（第 1 次重复，已忽略）。', '2026-09-28T09:05:00.000Z'),
      seedEvent('verify', '回执 JTC-2026-1041 核验通过，许可记录保留。', '2026-09-28T09:40:00.000Z'),
      seedEvent('receipt', '收到平台回执 JTC-2026-1042，额度 10，版本一致，待人工核验。', '2026-09-30T02:15:00.000Z'),
      seedEvent('mismatch', '回执 JTC-2026-0999 引用版本与送审固化版本不一致，停在待核。', '2026-10-01T11:30:00.000Z'),
    ],
    pendingReason: '回执 JTC-2026-1042 已到账待核验；回执 JTC-2026-0999 引用旧版本 V1.0，版本不符。',
  }

  const pkg002 = packages.find((item) => item.id === 'pkg-002')!
  const batchB: ReconcileBatch = {
    id: 'batch-pkg-002-r1',
    code: 'EC-2026-002-R1',
    packageId: 'pkg-002',
    round: 1,
    status: 'released',
    packageVersionId: pkg002.versions[0].id,
    packageVersionLabel: 'V1.0',
    ruleId: 'rule-de-software',
    createdAt: '2026-09-24T03:00:00.000Z',
    submittedBy: '赵敏',
    revision: 3,
    // 旧数据：逐页脱敏摘要缺失，迁移时按首次送审内容回填
    frozenFiles: [legacyFrozen(file002a, sw2)],
    frozenDigestComplete: false,
    route: pkg002.approvalRoute.map((step) => ({
      ...step,
      decidedRound: 1,
      dependsOnFileIds: step.role.includes('业务复核') ? [file002a.id] : [],
    })),
    receipts: [
      {
        id: 'receipt-b1',
        receiptNo: 'BAFA-2026-7720',
        platform: '德国联邦经济与出口管制局',
        amount: 42,
        receivedAt: '2026-09-27T02:30:00.000Z',
        status: 'verified',
        packageVersionId: pkg002.versions[0].id,
        fileRefs: [{ fileId: 'file-002-a', versionId: sw2.id }],
        duplicateCount: 0,
        verifiedAt: '2026-09-27T03:05:00.000Z',
        verifiedBy: '合规专员',
      },
    ],
    events: [
      seedEvent('submit', '第 1 轮送审，固化资料包 V1.0 与文件引用版本。', '2026-09-24T03:00:00.000Z', '赵敏'),
      seedEvent('release', '全部审批与回执对账完成，扣减额度 42，批次放行并形成许可记录。', '2026-09-27T03:20:00.000Z'),
    ],
    releasedAt: '2026-09-27T03:20:00.000Z',
    quotaUsedAfter: 42,
  }

  const pkg004 = packages.find((item) => item.id === 'pkg-004')!
  const batchC: ReconcileBatch = {
    id: 'batch-pkg-004-r1',
    code: 'EC-2026-004-R1',
    packageId: 'pkg-004',
    round: 1,
    status: 'submitted',
    packageVersionId: pkg004.versions[0].id,
    packageVersionLabel: 'V1.0',
    ruleId: 'rule-my-general',
    createdAt: '2026-09-28T03:00:00.000Z',
    submittedBy: '许航',
    revision: 1,
    // 引用一个已不存在的文件版本：旧数据摘要补不全，迁移后 blocked
    frozenFiles: [
      {
        fileId: 'file-004-a',
        name: '厂房电气总平面图.dwg',
        kind: 'drawing',
        versionId: 'file-version-removed-legacy',
        versionLabel: '引用版本已缺失',
        versionHash: '',
        pages: [],
        digestComplete: false,
      },
    ],
    frozenDigestComplete: false,
    route: createApprovalRoute('standard').map((step) => ({
      ...step,
      dependsOnFileIds: [file004a.id],
    })),
    receipts: [],
    events: [
      seedEvent('submit', '第 1 轮送审，固化资料包 V1.0。', '2026-09-28T03:00:00.000Z', '许航'),
    ],
  }

  const batches: ReconcileBatch[] = [batchA, batchB, batchC]

  const findings = packages.flatMap((packageItem) =>
    validatePackage(packageItem, files, rules),
  )
  return {
    packages,
    files,
    rules,
    findings,
    batches,
    comments: [
      {
        id: 'comment-1',
        packageId: 'pkg-001',
        author: '合规专员',
        content: '第 7 页固化温度属于受控技术参数，请校核脱敏后版本是否已替换。',
        createdAt: '2026-09-27T07:30:00.000Z',
        round: 1,
      },
      {
        id: 'comment-2',
        packageId: 'pkg-003',
        author: '技术安全负责人',
        content: '本轮退回原因：人员接触清单缺失，且外籍人员范围未在最终用户证明中说明。',
        createdAt: '2026-09-26T08:10:00.000Z',
        round: 2,
      },
    ],
    audit: [
      {
        id: 'audit-1',
        packageId: 'pkg-001',
        action: '拆解资料包',
        target: '复材机翼铺层工艺资料包',
        operator: '合规专员',
        detail: '拆分为 2 个文件，共 17 页。',
        createdAt: '2026-09-27T02:30:00.000Z',
      },
      {
        id: 'audit-2',
        packageId: 'pkg-003',
        action: '审批退回',
        target: '精密光刻运动控制技术说明',
        operator: '技术安全负责人',
        detail: '需要补充人员接触清单并重新核对最终用途。',
        createdAt: '2026-09-26T08:10:00.000Z',
      },
      {
        id: 'audit-3',
        packageId: 'pkg-002',
        action: '批准资料包',
        target: '工业控制器基础软件包',
        operator: '合规专员',
        detail: '全部审批步骤完成，等待许可额度扣减。',
        createdAt: '2026-09-27T03:20:00.000Z',
      },
    ],
  }
}

export const categoryLabels = {
  drawing: '图纸',
  technical: '技术说明',
  software: '软件包',
} as const

export const packageStatusLabels: Record<MaterialPackage['status'], string> = {
  draft: '草稿',
  validating: '校验中',
  reviewing: '审批中',
  returned: '已退回',
  approved: '已批准',
  licensed: '已许可',
  locked: '已归档',
}
