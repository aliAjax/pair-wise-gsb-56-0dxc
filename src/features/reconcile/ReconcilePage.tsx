import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Collapse,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Steps,
  Switch,
  Table,
  Tag,
  Timeline,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import {
  CloudUploadOutlined,
  RedoOutlined,
  RetweetOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { PageHeader } from '@/components/PageHeader'
import { BatchStatusTag, ReceiptStatusTag } from '@/components/BatchTags'
import {
  useArmFailNextMutation,
  useDecideBatchMutation,
  useGetWorkspaceQuery,
  useIngestReceiptMutation,
  useRecomputeBatchMutation,
  useReleaseBatchMutation,
  useRetryBatchMutation,
  useSubmitBatchMutation,
  useVerifyReceiptMutation,
} from '@/app/api'
import type {
  BatchOutboxEntry,
  LicenseReceipt,
  ReconcileBatch,
} from '@/types/domain'
import { approvalLevelLabels } from '@/services/rules'

const eventLabels: Record<string, string> = {
  submit: '送审固化',
  receipt: '回执入账',
  duplicate: '重复忽略',
  verify: '回执核验',
  mismatch: '版本不符',
  invalidate: '换版失效',
  recompute: '重算续办',
  decide: '审批确认',
  return: '审批退回',
  release: '批次放行',
  block: '阻断',
  retry: '整批重试',
  backfill: '摘要回填',
}

function unwrapError(error: unknown): string {
  if (typeof error === 'object' && error && 'data' in error) {
    return (error.data as { error?: string }).error ?? '操作失败'
  }
  return '操作失败'
}

export function ReconcilePage() {
  const { data, isLoading } = useGetWorkspaceQuery()
  const [submitBatch] = useSubmitBatchMutation()
  const [ingestReceipt] = useIngestReceiptMutation()
  const [verifyReceipt] = useVerifyReceiptMutation()
  const [recomputeBatch] = useRecomputeBatchMutation()
  const [decideBatch] = useDecideBatchMutation()
  const [releaseBatch] = useReleaseBatchMutation()
  const [retryBatch] = useRetryBatchMutation()
  const [armFailNext] = useArmFailNextMutation()

  const [selectedBatchId, setSelectedBatchId] = useState('')
  const [failArmed, setFailArmed] = useState(false)

  // 双人确认弹窗（模拟两个终端对同一活动步骤同时确认，持同一 CAS 令牌）
  const [terminal, setTerminal] = useState<'A' | 'B' | null>(null)
  const [racedStepId, setRacedStepId] = useState<string | undefined>()
  const [racedToken, setRacedToken] = useState<string | undefined>()
  const [commentA, setCommentA] = useState('')
  const [commentB, setCommentB] = useState('')

  const [receiptOpen, setReceiptOpen] = useState(false)
  const [receiptForm] = Form.useForm()

  const orderedBatches = useMemo(
    () => (data ? [...data.batches].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : []),
    [data],
  )

  useEffect(() => {
    if (!selectedBatchId && orderedBatches[0]) setSelectedBatchId(orderedBatches[0].id)
  }, [orderedBatches, selectedBatchId])

  const batch = data?.batches.find((item) => item.id === selectedBatchId)
  const packageItem = data?.packages.find((item) => item.id === batch?.packageId)
  const packageFiles = data?.files.filter((file) => file.packageId === batch?.packageId) ?? []
  const activeStep = batch?.route.find((step) => step.status === 'active')

  // 活动步骤变化时为“两个终端”固化同一张令牌快照
  useEffect(() => {
    setRacedStepId(activeStep?.id)
    setRacedToken(activeStep?.confirmToken)
  }, [activeStep?.id, activeStep?.confirmToken])

  if (isLoading || !data) return <div className="panel">正在加载对账批次...</div>

  const openBatchOf = (packageId: string) =>
    [...data.batches]
      .reverse()
      .find((item) => item.packageId === packageId && item.status !== 'released')

  async function handleSubmit(packageId: string) {
    try {
      const result = await submitBatch({ packageId }).unwrap()
      const created = result.batches.find((item) => item.packageId === packageId && item.status !== 'released')
      if (created) setSelectedBatchId(created.id)
      message.success('已固化当前资料包版本与逐页脱敏摘要，批次送审')
    } catch (error) {
      message.error(unwrapError(error))
    }
  }

  async function handleVerify(receiptId: string) {
    if (!batch) return
    try {
      await verifyReceipt({ batchId: batch.id, receiptId }).unwrap()
      message.success('回执核验通过，许可记录保留')
    } catch (error) {
      message.error(unwrapError(error))
    }
  }

  async function handleRecompute() {
    if (!batch) return
    try {
      await recomputeBatch({ batchId: batch.id }).unwrap()
      message.success('已按当前引用版本重算，已确认意见与已核验回执保留')
    } catch (error) {
      message.error(unwrapError(error))
    }
  }

  async function handleRelease() {
    if (!batch) return
    try {
      await releaseBatch({ batchId: batch.id }).unwrap()
      message.success('批次已放行，许可记录永久保留')
    } catch (error) {
      message.error(unwrapError(error))
    }
  }

  async function handleTerminalConfirm(which: 'A' | 'B') {
    if (!batch || !racedStepId || !racedToken) return
    const operator = which === 'A' ? '合规专员·终端A（张谨）' : '合规专员·终端B（李审）'
    try {
      await decideBatch({
        batchId: batch.id,
        stepId: racedStepId,
        decision: 'approve',
        comment: (which === 'A' ? commentA : commentB) || '同意',
        confirmToken: racedToken,
        operator,
      }).unwrap()
      message.success(`终端 ${which}（${operator}）确认成功并放行了该步骤`)
      setTerminal(null)
      setCommentA('')
      setCommentB('')
    } catch (error) {
      message.error(`终端 ${which} 未放行：${unwrapError(error)}`)
    }
  }

  /** 两个终端同时点确认：服务端 CAS 保证只有一个成功 */
  async function handleBothAtOnce() {
    if (!batch || !racedStepId || !racedToken) return
    setTerminal(null)
    const payload = {
      batchId: batch.id,
      stepId: racedStepId,
      decision: 'approve' as const,
      comment: '双人同时确认',
      confirmToken: racedToken,
    }
    const [resultA, resultB] = await Promise.allSettled([
      decideBatch({ ...payload, operator: '合规专员·终端A（张谨）' }).unwrap(),
      decideBatch({ ...payload, operator: '合规专员·终端B（李审）' }).unwrap(),
    ])
    const winners = [resultA, resultB].filter((item) => item.status === 'fulfilled').length
    if (winners === 1) {
      message.success('两个终端同时确认：仅一个写入成功，另一个被 CAS 令牌拒绝')
    } else {
      message.warning('两个终端都未成功，请刷新后重试')
    }
  }

  async function handleRetry(entry: BatchOutboxEntry) {
    try {
      const result = await retryBatch({ outboxId: entry.id }).unwrap()
      setSelectedBatchId(entry.batchId)
      message.success(`批次 ${result.batches.find((item) => item.id === entry.batchId)?.code} 整批重试成功`)
    } catch (error) {
      message.error(unwrapError(error))
    }
  }

  async function handleArmFail() {
    await armFailNext().unwrap()
    setFailArmed(true)
    message.warning('已设置：下一次批次/换版写入将失败，完整批次会进入续办箱')
  }

  function openReceiptModal() {
    if (!batch) return
    receiptForm.setFieldsValue({
      receiptNo: `JTC-2026-${Math.floor(1000 + Math.random() * 9000)}`,
      platform: '新加坡贸易信息化平台',
      amount: 5,
      packageVersionId: batch.packageVersionId,
      fileRefs: batch.frozenFiles.map((frozen) => ({
        fileId: frozen.fileId,
        versionId: frozen.versionId,
      })),
    })
    setReceiptOpen(true)
  }

  async function submitReceipt() {
    if (!batch || !packageItem) return
    const values = await receiptForm.validateFields()
    try {
      const result = await ingestReceipt({
        packageId: packageItem.id,
        receipt: {
          receiptNo: values.receiptNo,
          platform: values.platform,
          amount: values.amount,
          packageVersionId: values.packageVersionId,
          fileRefs: values.fileRefs,
        },
      }).unwrap()
      const updated = result.batches.find((item) => item.id === batch.id)
      const latest = updated?.receipts.find((item) => item.receiptNo === values.receiptNo)
      setReceiptOpen(false)
      if (latest?.duplicateCount) {
        message.info('重复回执：系统只入账第一次，本次重复推送已忽略')
      } else if (latest?.status === 'mismatch') {
        message.warning('回执版本与送审固化版本不一致，批次已停在待核')
      } else {
        message.success('平台回执已入账，批次等待人工核验')
      }
    } catch (error) {
      message.error(unwrapError(error))
    }
  }

  const batchColumns: TableColumnsType<ReconcileBatch> = [
    {
      title: '对账批次',
      width: 170,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <strong>{record.code}</strong>
          <span className="muted">第 {record.round} 轮 · rev {record.revision}</span>
        </Space>
      ),
    },
    {
      title: '资料包',
      render: (_, record) =>
        data.packages.find((item) => item.id === record.packageId)?.code ?? record.packageId,
    },
    {
      title: '固化资料包版本',
      width: 130,
      render: (_, record) => <Tag color="blue">{record.packageVersionLabel}</Tag>,
    },
    {
      title: '逐页摘要',
      width: 100,
      render: (_, record) => (
        <Tag color={record.frozenDigestComplete ? 'success' : 'error'}>
          {record.frozenDigestComplete ? '完整' : '缺失'}
        </Tag>
      ),
    },
    {
      title: '回执',
      width: 160,
      render: (_, record) => (
        <Space size={4} wrap>
          <Badge count={record.receipts.length} showZero color="#1677ff" text="总数" />
          <Badge
            count={record.receipts.filter((item) => item.status === 'verified').length}
            showZero
            color="#52c41a"
            text="已核"
          />
          <Badge
            count={record.receipts.filter((item) => item.status === 'mismatch').length}
            showZero
            color="#ff4d4f"
            text="不符"
          />
        </Space>
      ),
    },
    {
      title: '状态',
      width: 120,
      render: (_, record) => <BatchStatusTag status={record.status} />,
    },
    {
      title: '操作',
      width: 90,
      render: (_, record) => (
        <Button type="link" onClick={() => setSelectedBatchId(record.id)}>
          对账
        </Button>
      ),
    },
  ]

  const receiptColumns: TableColumnsType<LicenseReceipt> = [
    { title: '回执编号', dataIndex: 'receiptNo', width: 160 },
    { title: '许可平台', dataIndex: 'platform', width: 190 },
    {
      title: '额度',
      dataIndex: 'amount',
      width: 80,
      render: (value: number) => `${value}`,
    },
    {
      title: '版本对账',
      render: (_, receipt) => {
        const lines = receipt.fileRefs.map((ref) => {
          const frozen = batch?.frozenFiles.find((file) => file.fileId === ref.fileId)
          const file = packageFiles.find((item) => item.id === ref.fileId)
          const receiptLabel =
            file?.versions.find((version) => version.id === ref.versionId)?.label ?? ref.versionId
          const match = frozen?.versionId === ref.versionId
          return (
            <div key={ref.fileId}>
              {file?.name ?? ref.fileId}：
              <Tag color={match ? 'green' : 'red'} style={{ marginInline: 4 }}>
                回执 {receiptLabel}
              </Tag>
              vs 送审
              <Tag color="blue" style={{ marginInline: 4 }}>
                {frozen?.versionLabel ?? '—'}
              </Tag>
              {match ? '一致' : '不一致'}
            </div>
          )
        })
        const packageMatch =
          !receipt.packageVersionId || receipt.packageVersionId === batch?.packageVersionId
        return (
          <Space direction="vertical" size={2}>
            {!packageMatch ? (
              <Tag color="red">
                资料包版本：回执 {receipt.packageVersionId} ≠ 送审 {batch?.packageVersionLabel}
              </Tag>
            ) : null}
            {lines}
          </Space>
        )
      },
    },
    {
      title: '重复',
      dataIndex: 'duplicateCount',
      width: 70,
      render: (value: number) => (value ? <Tag color="orange">+{value}</Tag> : '—'),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: LicenseReceipt['status']) => <ReceiptStatusTag status={value} />,
    },
    {
      title: '操作',
      width: 110,
      render: (_, receipt) =>
        receipt.status === 'received' ? (
          <Button type="link" onClick={() => handleVerify(receipt.id)}>
            核验通过
          </Button>
        ) : receipt.status === 'mismatch' ? (
          <span className="muted">停在待核</span>
        ) : (
          <span className="muted">—</span>
        ),
    },
  ]

  const frozenColumns: TableColumnsType<ReconcileBatch['frozenFiles'][number]> = [
    { title: '文件', dataIndex: 'name' },
    {
      title: '固化引用版本',
      width: 150,
      render: (_, record) => (
        <Tag color="blue">
          {record.versionLabel} · {record.versionHash || '无哈希'}
        </Tag>
      ),
    },
    {
      title: '逐页脱敏摘要',
      width: 260,
      render: (_, record) => (
        <Space size={4} wrap>
          {record.pages.length ? (
            record.pages.slice(0, 6).map((page) => (
              <Tag
                key={page.pageId}
                color={page.digestComplete ? (page.controlled && !page.desensitized ? 'warning' : 'default') : 'error'}
                title={page.contentDigest}
              >
                P{page.page}
                {page.controlled ? (page.desensitized ? '·脱敏' : '·未脱敏') : ''}
                {page.backfilled ? '·回填' : ''}
              </Tag>
            ))
          ) : (
            <Tag color="error">无摘要</Tag>
          )}
          {record.pages.length > 6 ? <Tag>共 {record.pages.length} 页</Tag> : null}
        </Space>
      ),
    },
    {
      title: '完整性',
      width: 100,
      render: (_, record) => (
        <Tag color={record.digestComplete ? 'success' : 'error'}>
          {record.digestComplete ? '可对账' : '补不全'}
        </Tag>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="回执对账批次"
        description="送审时固化资料包版本、文件引用版本与逐页脱敏摘要；回执晚到可续办、重复只入一次、版本不符停在待核。"
      />

      {/* 写入失败与整批重试 */}
      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-title">
          <h3>续办箱（写入失败 → 完整批次重试）</h3>
          <Space>
            <Switch
              checked={failArmed}
              checkedChildren="下次写入将失败"
              unCheckedChildren="模拟写入失败"
              onChange={(checked) => {
                if (checked) handleArmFail()
                else setFailArmed(false)
              }}
            />
          </Space>
        </div>
        {data.outbox.length ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert
              type="error"
              showIcon
              icon={<WarningOutlined />}
              message={`有 ${data.outbox.length} 个批次写入失败，工作区未落库；可从完整批次重试，revision 一致才会覆盖写入。`}
            />
            {data.outbox.map((entry) => (
              <div key={entry.id} className="version-box">
                <Space wrap>
                  <BatchStatusTag status={entry.batch.status} />
                  <strong>{entry.batch.code}</strong>
                  <span className="muted">
                    失败于 {entry.failedUrl} · 期望 rev {entry.expectedRevision} · 已尝试{' '}
                    {entry.attempts} 次 · {new Date(entry.failedAt).toLocaleString('zh-CN')}
                  </span>
                  <span className="grow" />
                  <Button
                    type="primary"
                    icon={<RedoOutlined />}
                    onClick={() => handleRetry(entry)}
                  >
                    从完整批次重试
                  </Button>
                </Space>
                <div className="muted" style={{ marginTop: 6 }}>
                  {entry.reason}
                </div>
              </div>
            ))}
          </Space>
        ) : (
          <Alert
            type="info"
            showIcon
            message="没有待重试的失败批次。打开上方开关后再送审/录回执/换版，可演示写入失败与整批重试。"
          />
        )}
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>对账批次（审批、版本差异、导出均按同一批次展示）</h3>
        </div>
        <Table
          rowKey="id"
          columns={batchColumns}
          dataSource={orderedBatches}
          pagination={false}
          rowClassName={(record) => (record.id === selectedBatchId ? 'ant-table-row-selected' : '')}
          onRow={(record) => ({ onClick: () => setSelectedBatchId(record.id) })}
        />
      </section>

      {batch && packageItem ? (
        <>
          <div className="toolbar">
            <Space wrap>
              <BatchStatusTag status={batch.status} />
              <Tag color="blue">资料包版本 {batch.packageVersionLabel}</Tag>
              <Tag>第 {batch.round} 轮</Tag>
              <Tag color="purple">revision {batch.revision}</Tag>
              {batch.legacyBackfilled ? <Tag color="cyan">旧摘要已按首次送审回填</Tag> : null}
            </Space>
            <span className="grow" />
            <Space>
              {['invalidated', 'pending', 'submitted', 'blocked'].includes(batch.status) ? (
                <Button icon={<RetweetOutlined />} onClick={handleRecompute}>
                  重算续办
                </Button>
              ) : null}
              {batch.status !== 'released' && batch.status !== 'returned' ? (
                <Button icon={<CloudUploadOutlined />} onClick={openReceiptModal}>
                  模拟平台回执
                </Button>
              ) : null}
              <Button
                type="primary"
                icon={<SafetyCertificateOutlined />}
                disabled={batch.status === 'released'}
                onClick={handleRelease}
              >
                {batch.status === 'released' ? '已放行（许可记录保留）' : '对账放行'}
              </Button>
            </Space>
          </div>

          {batch.pendingReason ? (
            <Alert
              type={batch.status === 'blocked' ? 'error' : 'warning'}
              showIcon
              message={batch.pendingReason}
              style={{ marginBottom: 16 }}
            />
          ) : null}

          <div className="two-column">
            <section className="panel">
              <div className="panel-title">
                <h3>送审固化（版本 + 逐页脱敏摘要）</h3>
              </div>
              <Descriptions column={2} size="small" bordered style={{ marginBottom: 12 }}>
                <Descriptions.Item label="批次编号">{batch.code}</Descriptions.Item>
                <Descriptions.Item label="送审人">{batch.submittedBy}</Descriptions.Item>
                <Descriptions.Item label="资料包版本">
                  {batch.packageVersionLabel}
                </Descriptions.Item>
                <Descriptions.Item label="送审时间">
                  {new Date(batch.createdAt).toLocaleString('zh-CN')}
                </Descriptions.Item>
              </Descriptions>
              <Table
                rowKey="fileId"
                size="small"
                columns={frozenColumns}
                dataSource={batch.frozenFiles}
                pagination={false}
              />
            </section>

            <section className="panel">
              <div className="panel-title">
                <h3>审批路线（同一批次）</h3>
                {activeStep ? <Tag color="processing">{activeStep.role} 待确认</Tag> : null}
              </div>
              <Steps
                direction="vertical"
                current={batch.route.findIndex((step) => step.status === 'active')}
                items={batch.route.map((step) => ({
                  title: `${step.role} · ${approvalLevelLabels[step.level]}`,
                  description: (
                    <Space direction="vertical" size={2}>
                      <span className="muted">{step.assignee}</span>
                      {step.comment ? <span>意见：{step.comment}</span> : null}
                      {step.invalidatedReason ? (
                        <Tag color="orange">{step.invalidatedReason}</Tag>
                      ) : null}
                    </Space>
                  ),
                  status:
                    step.status === 'approved'
                      ? 'finish'
                      : step.status === 'returned'
                        ? 'error'
                        : step.status === 'invalidated'
                          ? 'error'
                          : step.status === 'active'
                            ? 'process'
                            : 'wait',
                }))}
              />
              {activeStep ? (
                <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
                  <Alert
                    type="info"
                    showIcon
                    message="两人同时确认只放行一个：两个终端持有同一张 CAS 令牌，先写入者成功，后写入者被拒。"
                  />
                  <Space wrap>
                    <Button
                      onClick={() => {
                        setTerminal('A')
                        setCommentA('')
                      }}
                    >
                      终端A · 张谨 确认
                    </Button>
                    <Button
                      onClick={() => {
                        setTerminal('B')
                        setCommentB('')
                      }}
                    >
                      终端B · 李审 确认
                    </Button>
                    <Button danger ghost icon={<ThunderboltOutlined />} onClick={handleBothAtOnce}>
                      两个终端同时确认
                    </Button>
                  </Space>
                  <span className="muted">
                    当前 CAS 令牌：{racedStepId === activeStep.id ? racedToken?.slice(0, 18) : '已刷新'}…
                  </span>
                </Space>
              ) : (
                <Alert
                  type={batch.status === 'released' ? 'success' : 'info'}
                  showIcon
                  message={
                    batch.status === 'released'
                      ? '全部步骤已确认并放行，意见作为许可记录保留。'
                      : batch.route.some((step) => step.status === 'invalidated')
                        ? '部分步骤因文件换版失效，重算后续办；已确认意见保留。'
                        : '没有待确认步骤。'
                  }
                  style={{ marginTop: 8 }}
                />
              )}
            </section>
          </div>

          <section className="panel">
            <div className="panel-title">
              <h3>许可回执（晚到可续办 · 重复只入一次 · 不符停待核）</h3>
              <Tag color={batch.receipts.length ? 'processing' : 'default'}>
                {batch.receipts.length} 份
              </Tag>
            </div>
            <Table
              rowKey="id"
              columns={receiptColumns}
              dataSource={batch.receipts}
              pagination={false}
              locale={{ emptyText: '许可平台尚未回执，批次可继续等待（已送审状态可续办）' }}
            />
          </section>

          <div className="two-column">
            <section className="panel">
              <div className="panel-title">
                <h3>批次事件流</h3>
              </div>
              <Timeline
                items={[...batch.events].reverse().map((item) => ({
                  color:
                    item.type === 'release'
                      ? 'green'
                      : item.type === 'mismatch' || item.type === 'block'
                        ? 'red'
                        : item.type === 'duplicate' || item.type === 'invalidate'
                          ? 'orange'
                          : 'blue',
                  children: (
                    <div>
                      <Space size={6}>
                        <Tag>{eventLabels[item.type] ?? item.type}</Tag>
                        <span className="muted">{new Date(item.at).toLocaleString('zh-CN')}</span>
                        <span className="muted">{item.operator}</span>
                      </Space>
                      <div>{item.detail}</div>
                    </div>
                  ),
                }))}
              />
            </section>

            <section className="panel">
              <div className="panel-title">
                <h3>放行检查</h3>
              </div>
              <Space direction="vertical" style={{ width: '100%' }}>
                <ReleaseCheck label="逐页脱敏摘要完整" pass={batch.frozenDigestComplete} />
                <ReleaseCheck
                  label="审批步骤全部确认"
                  pass={batch.route.every((step) => step.status === 'approved')}
                />
                <ReleaseCheck
                  label="至少一份已核验回执"
                  pass={batch.receipts.some((receipt) => receipt.status === 'verified')}
                />
                <ReleaseCheck
                  label="无版本不符 / 未核验回执"
                  pass={!batch.receipts.some(
                    (receipt) => receipt.status === 'mismatch' || receipt.status === 'received',
                  )}
                />
                <ReleaseCheck
                  label="冻结版本与当前引用一致"
                  pass={!batch.frozenFiles.some((frozen) => {
                    const file = packageFiles.find((item) => item.id === frozen.fileId)
                    return !file || file.referencedVersionId !== frozen.versionId
                  })}
                />
                <ReleaseCheck
                  label="额度充足"
                  pass={
                    packageItem.quotaUsed +
                      batch.receipts
                        .filter((receipt) => receipt.status === 'verified')
                        .reduce((sum, receipt) => sum + receipt.amount, 0) <=
                    packageItem.quotaLimit
                  }
                />
              </Space>
            </section>
          </div>
        </>
      ) : (
        <section className="panel" style={{ marginTop: 16 }}>
          <Alert type="info" showIcon message="请选择一个对账批次查看。" />
        </section>
      )}

      {/* 未送审资料包的送审入口 */}
      <Collapse
        style={{ marginTop: 16 }}
        items={[
          {
            key: 'submit',
            label: '为尚未送审的资料包发起对账批次',
            children: (
              <Space wrap>
                {data.packages
                  .filter((item) => !openBatchOf(item.id))
                  .map((item) => (
                    <Button key={item.id} onClick={() => handleSubmit(item.id)}>
                      送审 {item.code}
                    </Button>
                  ))}
                {!data.packages.some((item) => !openBatchOf(item.id)) ? (
                  <span className="muted">所有资料包都已有批次（含已放行批次，可重新送审开启新一轮）。</span>
                ) : null}
              </Space>
            ),
          },
        ]}
      />

      {/* 双人确认弹窗 */}
      <Modal
        title={terminal === 'A' ? '终端A · 张谨 确认当前步骤' : '终端B · 李审 确认当前步骤'}
        open={terminal !== null}
        onCancel={() => setTerminal(null)}
        onOk={() => terminal && handleTerminalConfirm(terminal)}
        okText="确认（CAS）"
        cancelText="取消"
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="若另一终端已先确认，本终端会收到“令牌已失效”错误而不会重复放行。"
        />
        <Input.TextArea
          rows={3}
          value={terminal === 'A' ? commentA : commentB}
          onChange={(event) =>
            terminal === 'A' ? setCommentA(event.target.value) : setCommentB(event.target.value)
          }
          placeholder="填写审批意见"
        />
      </Modal>

      {/* 模拟平台回执 */}
      <Modal
        title="模拟许可平台回执（可演示晚到、重复、旧版本回执）"
        open={receiptOpen}
        onCancel={() => setReceiptOpen(false)}
        onOk={submitReceipt}
        okText="回执入账"
        cancelText="取消"
        width={640}
      >
        <Form form={receiptForm} layout="vertical">
          <Space style={{ display: 'flex' }} align="start">
            <Form.Item name="receiptNo" label="回执编号" rules={[{ required: true }]}>
              <Input style={{ width: 200 }} />
            </Form.Item>
            <Form.Item name="platform" label="平台" rules={[{ required: true }]}>
              <Input style={{ width: 240 }} />
            </Form.Item>
            <Form.Item name="amount" label="额度" rules={[{ required: true }]}>
              <InputNumber min={1} style={{ width: 120 }} />
            </Form.Item>
          </Space>
          <Form.Item name="packageVersionId" label="回执引用资料包版本">
            <Select
              options={
                packageItem?.versions.map((version) => ({
                  value: version.id,
                  label: `${version.label}（${version.id === batch?.packageVersionId ? '送审固化' : '旧版本'}）`,
                })) ?? []
              }
            />
          </Form.Item>
          <Form.List name="fileRefs">
            {(fields) => (
              <Space direction="vertical" style={{ width: '100%' }}>
                {fields.map((field) => {
                  const fileId = receiptForm.getFieldValue(['fileRefs', field.name, 'fileId']) as string
                  const file = packageFiles.find((item) => item.id === fileId)
                  return (
                    <Space key={field.key} align="baseline">
                      <strong style={{ minWidth: 180 }}>{file?.name ?? fileId}</strong>
                      <Form.Item name={[field.name, 'versionId']} noStyle>
                        <Select
                          style={{ width: 280 }}
                          options={
                            file?.versions.map((version) => ({
                              value: version.id,
                              label: `${version.label} · ${version.hash}${
                                version.id ===
                                batch?.frozenFiles.find((frozen) => frozen.fileId === fileId)
                                  ?.versionId
                                  ? '（送审固化）'
                                  : '（旧版本）'
                              }`,
                            })) ?? []
                          }
                        />
                      </Form.Item>
                    </Space>
                  )
                })}
              </Space>
            )}
          </Form.List>
          <Alert
            style={{ marginTop: 12 }}
            type="info"
            showIcon
            message="选择旧版本即模拟“文件换版后旧回执仍放行”的场景：批次会停在待核；录入相同回执编号则演示重复回执只入一次。"
          />
        </Form>
      </Modal>
    </div>
  )
}

function ReleaseCheck({ label, pass }: { label: string; pass: boolean }) {
  return (
    <Space>
      <Tag color={pass ? 'success' : 'error'}>{pass ? '满足' : '未满足'}</Tag>
      <span className={pass ? '' : 'finding-message'}>{label}</span>
    </Space>
  )
}
