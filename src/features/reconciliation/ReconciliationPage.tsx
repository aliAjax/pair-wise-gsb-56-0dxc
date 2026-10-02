import { useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Collapse,
  Descriptions,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Steps,
  Table,
  Tag,
  Timeline,
  Tooltip,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import {
  CheckCircleOutlined,
  CloudServerOutlined,
  FileSyncOutlined,
  ReloadOutlined,
  SendOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useLocation } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import {
  useBackfillBatchMutation,
  useChangeFileVersionMutation,
  useCheckReceiptMutation,
  useDecideBatchMutation,
  useFreezeBatchMutation,
  useGetWorkspaceQuery,
  useIngestInboxMutation,
  useReleaseBatchMutation,
  useReleaseRaceMutation,
  useRetryPendingMutation,
  useToggleFaultMutation,
} from '@/app/api'
import type {
  BatchApprovalStep,
  MaterialPackage,
  PageDigest,
  ReceiptRecord,
  ReconciliationBatch,
} from '@/types/domain'
import {
  batchStatusColor,
  batchStatusLabels,
  liveRoute,
  receiptStateColor,
  receiptStateLabels,
  releaseGate,
  unresolvedDigestCount,
} from '@/services/reconciliation'
import { isWriteFaultOn } from '@/services/storage'

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'data' in error) {
    const data = (error as { data?: { error?: string } }).data
    if (data?.error) return data.error
  }
  return '操作失败'
}

function DigestTags({ digests }: { digests: PageDigest[] }) {
  const ok = digests.filter((d) => d.state === 'ok').length
  const backfilled = digests.filter((d) => d.state === 'backfilled').length
  const missing = digests.filter((d) => d.state === 'unresolvable').length
  return (
    <Space size={4} wrap>
      <Tooltip title="送审时固化的逐页脱敏摘要">
        <Tag color="blue">{ok} 页固化</Tag>
      </Tooltip>
      {backfilled > 0 && (
        <Tooltip title="旧数据按首次送审内容回填">
          <Tag color="cyan">{backfilled} 页回填</Tag>
        </Tooltip>
      )}
      {missing > 0 && <Tag color="error">{missing} 页补不全</Tag>}
    </Space>
  )
}

export function ReconciliationPage() {
  const location = useLocation()
  const { data, isLoading, refetch } = useGetWorkspaceQuery()
  const [freezeBatch] = useFreezeBatchMutation()
  const [decideBatch] = useDecideBatchMutation()
  const [ingestInbox] = useIngestInboxMutation()
  const [checkReceipt] = useCheckReceiptMutation()
  const [changeVersion] = useChangeFileVersionMutation()
  const [backfill] = useBackfillBatchMutation()
  const [releaseBatch, releaseState] = useReleaseBatchMutation()
  const [releaseRace] = useReleaseRaceMutation()
  const [retryPending] = useRetryPendingMutation()
  const [toggleFault] = useToggleFaultMutation()

  const [selectedId, setSelectedId] = useState<string | undefined>(
    (location.state as { batchId?: string } | null)?.batchId,
  )
  const [freezePackageId, setFreezePackageId] = useState<string>()
  const [decideStep, setDecideStep] = useState<{ batch: ReconciliationBatch; step: BatchApprovalStep }>()
  const [decisionPassed, setDecisionPassed] = useState(true)
  const [comment, setComment] = useState('')
  const [faultOn, setFaultOn] = useState(isWriteFaultOn())
  const [raceBatch, setRaceBatch] = useState<ReconciliationBatch>()

  const batches = data?.batches ?? []
  const selected = useMemo(
    () => batches.find((batch) => batch.id === selectedId) ?? batches[0],
    [batches, selectedId],
  )
  const packageOf = (id: string) => data?.packages.find((item) => item.id === id)
  const pendingInbox = data?.inbox.filter((mail) => !mail.ingested).length ?? 0

  if (isLoading || !data) return <div className="panel">正在加载对账批次...</div>

  type MutationTrigger = () => { unwrap: () => Promise<unknown> }
  const run = async (fn: MutationTrigger, success: string) => {
    try {
      await fn().unwrap()
      message.success(success)
    } catch (error) {
      message.error(errorMessage(error), 6)
    }
  }

  const batchColumns: TableColumnsType<ReconciliationBatch> = [
    {
      title: '对账批次',
      dataIndex: 'batchNo',
      width: 160,
      render: (value: string, record) => (
        <Space direction="vertical" size={0}>
          <strong>{value}</strong>
          <span className="muted">{packageOf(record.packageId)?.code}</span>
        </Space>
      ),
    },
    {
      title: '资料包 / 固化版本',
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <span>{packageOf(record.packageId)?.title}</span>
          <span className="muted">
            资料包 {record.packageVersionLabel} · 指纹
            <span className="mono"> {record.fingerprint}</span>
          </span>
        </Space>
      ),
    },
    {
      title: '文件引用版本 / 逐页摘要',
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          {record.files.map((ref) => (
            <span key={ref.fileId} className="muted" style={{ fontSize: 12 }}>
              {ref.fileName} <Tag style={{ marginInline: 2 }}>{ref.versionLabel}</Tag>
              <DigestTags digests={ref.digests} />
            </span>
          ))}
        </Space>
      ),
    },
    {
      title: '审批 / 回执',
      width: 150,
      render: (_, record) => {
        const approved = liveRoute(record).filter((step) => step.status === 'approved').length
        const verified = record.receipts.filter((r) => r.state === 'verified').length
        const pending = record.receipts.filter((r) => r.state === 'pending_check').length
        return (
          <Space direction="vertical" size={0}>
            <span>
              审批 {approved}/{liveRoute(record).length}
            </span>
            <span className="muted">
              回执已核 {verified}
              {pending > 0 ? <Tag color="warning">{pending} 待核</Tag> : null}
            </span>
          </Space>
        )
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 140,
      render: (value: ReconciliationBatch['status']) => (
        <Tag color={batchStatusColor(value)}>{batchStatusLabels[value]}</Tag>
      ),
    },
    {
      title: '操作',
      width: 110,
      render: (_, record) => (
        <Button type="link" onClick={() => setSelectedId(record.id)}>
          打开批次
        </Button>
      ),
    },
  ]

  const receiptColumns: TableColumnsType<ReceiptRecord> = [
    { title: '平台回执单号', dataIndex: 'receiptNo', width: 170, render: (v: string) => <span className="mono">{v}</span> },
    { title: '文件', dataIndex: 'fileName' },
    {
      title: '回执声称版本',
      dataIndex: 'claimedVersionLabel',
      width: 130,
      render: (value: string, record) => {
        const ref = selected?.files.find((f) => f.fileId === record.fileId)
        const match = ref?.versionId === record.claimedVersionId
        return (
          <span>
            {value} {match ? <Tag color="success">同版</Tag> : <Tag color="error">错版</Tag>}
          </span>
        )
      },
    },
    {
      title: '状态',
      dataIndex: 'state',
      width: 100,
      render: (value: ReceiptRecord['state']) => (
        <Tag color={receiptStateColor(value)}>{receiptStateLabels[value]}</Tag>
      ),
    },
    { title: '到件时间', dataIndex: 'receivedAt', width: 170, render: (v: string) => new Date(v).toLocaleString('zh-CN') },
    {
      title: '处理',
      width: 230,
      render: (_, record) => {
        if (record.state !== 'pending_check' || !selected) return null
        return (
          <Space>
            <Popconfirm
              title="确认该回执版本已与平台人工核实？"
              onConfirm={() =>
                run(
                  () => checkReceipt({ batchId: selected.id, receiptId: record.id, resolution: 'confirm' }),
                  '回执已人工核对通过',
                )
              }
            >
              <Button size="small" type="link">
                核实同版
              </Button>
            </Popconfirm>
            <Button
              size="small"
              type="link"
              danger
              onClick={() =>
                run(
                  () => checkReceipt({ batchId: selected.id, receiptId: record.id, resolution: 'reject' }),
                  '回执已作废，等待平台补发',
                )
              }
            >
              作废
            </Button>
          </Space>
        )
      },
    },
    { title: '备注', dataIndex: 'note', render: (v: string) => <span className="muted">{v}</span> },
  ]

  const freezablePackages = data.packages.filter(
    (pkg) =>
      !data.batches.some(
        (batch) => batch.packageId === pkg.id && !['released', 'blocked'].includes(batch.status),
      ),
  )

  const gateReasons = selected ? releaseGate(selected) : []
  const route = selected ? liveRoute(selected) : []
  const currentStep = route.find((step) => step.status === 'active')

  const confirmDecision = () => {
    if (!decideStep) return
    void run(
      () =>
        decideBatch({
          batchId: decideStep.batch.id,
          stepId: decideStep.step.id,
          passed: decisionPassed,
          comment,
        }),
      decisionPassed ? '审批意见已确认（已固化版本不变）' : '已退回，批次回到补正态',
    )
    setDecideStep(undefined)
    setComment('')
  }

  const doRelease = async () => {
    if (!selected) return
    try {
      await releaseBatch({ batchId: selected.id, expectedRev: selected.rev }).unwrap()
      message.success(`批次 ${selected.batchNo} 已放行，许可记录已生成`)
    } catch (error) {
      message.error(errorMessage(error), 6)
    }
  }

  const doRace = async () => {
    if (!raceBatch) return
    try {
      await releaseRace({ batchId: raceBatch.id, actor: '许可管理员甲' }).unwrap()
      message.success('并发演练完成：只放行一个，第二个确认被乐观锁拒绝（见审计）')
      setRaceBatch(undefined)
    } catch (error) {
      message.error(errorMessage(error), 6)
    }
  }

  return (
    <div>
      <PageHeader
        title="回执对账批次"
        description="送审即固化资料包版本与逐页脱敏摘要；重复回执只入一次，版本对不上停在待核；文件换版只重算受影响的待审批步骤与未核回执。"
        actions={
          <Space>
            <Badge count={pendingInbox} size="small">
              <Button
                icon={<CloudServerOutlined />}
                onClick={() => run(() => ingestInbox({}), '平台收件已归入批次账')}
              >
                收取平台回执
              </Button>
            </Badge>
            <Button
              type="primary"
              icon={<SendOutlined />}
              onClick={() => setFreezePackageId(freezablePackages[0]?.id)}
              disabled={!freezablePackages.length}
            >
              送审并固化批次
            </Button>
          </Space>
        }
      />

      <section className="panel">
        <div className="panel-title">
          <h3>故障演练与续办</h3>
          <Space>
            <Tag color={faultOn ? 'error' : 'success'}>{faultOn ? '写入故障注入中' : '写入通道正常'}</Tag>
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              onClick={() => {
                const next = !faultOn
                setFaultOn(next)
                void run(() => toggleFault({ on: next }), next ? '写入故障已开启：下次动作将失败并入待重试' : '写入通道已恢复')
              }}
            >
              {faultOn ? '关闭故障注入' : '开启写入故障'}
            </Button>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => refetch()}>
              重新装载
            </Button>
          </Space>
        </div>
        {data.pendingActions.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={`有 ${data.pendingActions.length} 个写入失败的动作待续办（完整批次快照已留存）`}
            description={
              <Space direction="vertical" style={{ width: '100%' }}>
                {data.pendingActions.map((item) => (
                  <Space key={item.id} wrap>
                    <Tag>{item.fullBatchSnapshot.batchNo}</Tag>
                    <span>动作 {item.action}</span>
                    <span className="muted">已失败 {item.attempts} 次</span>
                    <span className="muted">{item.lastError}</span>
                    <Popconfirm
                      title="关闭故障后，从完整批次快照重试该动作？"
                      onConfirm={() =>
                        run(() => retryPending({ actionId: item.id }), '已从完整批次重试成功')
                      }
                    >
                      <Button size="small" type="primary">
                        从完整批次重试
                      </Button>
                    </Popconfirm>
                  </Space>
                ))}
              </Space>
            }
          />
        ) : (
          <Alert
            type="info"
            showIcon
            message="开启写入故障后执行任意批次动作，动作会带着完整批次快照进入待重试；关闭故障后一键续办，批次不丢账。"
          />
        )}
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>对账批次（{batches.length}）</h3>
          <span className="muted">同一批次贯穿审批、版本差异、回执核对与导出</span>
        </div>
        <Table
          rowKey="id"
          columns={batchColumns}
          dataSource={batches}
          pagination={false}
          onRow={(record) => ({ onClick: () => setSelectedId(record.id), style: { cursor: 'pointer' } })}
          rowClassName={(record) => (record.id === selected?.id ? 'ant-table-row-selected' : '')}
        />
      </section>

      {selected ? (
        <section className="panel">
          <div className="panel-title">
            <h3>批次 {selected.batchNo} 明细</h3>
            <Space>
              {unresolvedDigestCount(selected) > 0 ||
              selected.files.some((f) => f.digests.length === 0) ? (
                <Button
                  icon={<FileSyncOutlined />}
                  onClick={() => run(() => backfill({ batchId: selected.id }), '已按首次送审内容回填')}
                >
                  回填缺失摘要
                </Button>
              ) : null}
              {selected.status !== 'released' ? (
                <>
                  <Popconfirm
                    title="两人同时确认演练"
                    description="将以相同 rev 连续提交两次放行，验证只放行一个"
                    onConfirm={doRace}
                  >
                    <Button onClick={() => setRaceBatch(selected)}>并发确认演练</Button>
                  </Popconfirm>
                  <Button
                    type="primary"
                    icon={<CheckCircleOutlined />}
                    loading={releaseState.isLoading}
                    disabled={gateReasons.length > 0}
                    onClick={doRelease}
                  >
                    确认放行
                  </Button>
                </>
              ) : (
                <Tag color="success" style={{ fontSize: 14, padding: '4px 12px' }}>
                  已放行 · 许可记录保留
                </Tag>
              )}
            </Space>
          </div>

          {gateReasons.length > 0 && selected.status !== 'released' ? (
            <Alert
              type={selected.status === 'blocked' ? 'error' : 'warning'}
              showIcon
              style={{ marginBottom: 14 }}
              message="放行闸门未满足（补不全不放行 / 版本不符停在待核）"
              description={
                <ul style={{ marginBottom: 0, paddingInlineStart: 18 }}>
                  {gateReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              }
            />
          ) : null}

          <Descriptions bordered size="small" column={3} style={{ marginBottom: 14 }}>
            <Descriptions.Item label="资料包">
              {packageOf(selected.packageId)?.code} · {packageOf(selected.packageId)?.title}
            </Descriptions.Item>
            <Descriptions.Item label="固化资料包版本">{selected.packageVersionLabel}</Descriptions.Item>
            <Descriptions.Item label="批次修订号 rev">{selected.rev}</Descriptions.Item>
            <Descriptions.Item label="固化指纹" span={2}>
              <span className="mono">{selected.fingerprint}</span>
            </Descriptions.Item>
            <Descriptions.Item label="送审时间">
              {new Date(selected.frozenAt).toLocaleString('zh-CN')}
            </Descriptions.Item>
          </Descriptions>

          <div className="two-column">
            <div>
              <h4>审批路线（只重算依赖换版文件的待办节点）</h4>
              <Steps
                direction="vertical"
                size="small"
                current={route.findIndex((step) => step.status === 'active')}
                items={[
                  ...route.map((step) => ({
                    title: (
                      <Space>
                        {step.role}
                        <Tag>{step.assignee}</Tag>
                        {step.dependsOn.length > 0 ? (
                          <span className="muted" style={{ fontSize: 12 }}>
                            依赖 {step.dependsOn.length} 文件
                          </span>
                        ) : null}
                      </Space>
                    ),
                    description: (
                      <Space direction="vertical" size={2}>
                        <span className="muted">{step.comment || '暂无意见'}</span>
                        {step.status === 'active' && selected.status !== 'released' ? (
                          <Space>
                            <Button
                              size="small"
                              type="primary"
                              onClick={() => {
                                setDecideStep({ batch: selected, step })
                                setDecisionPassed(true)
                              }}
                            >
                              通过
                            </Button>
                            <Button
                              size="small"
                              danger
                              onClick={() => {
                                setDecideStep({ batch: selected, step })
                                setDecisionPassed(false)
                              }}
                            >
                              退回
                            </Button>
                          </Space>
                        ) : null}
                      </Space>
                    ),
                    status:
                      step.status === 'approved'
                        ? ('finish' as const)
                        : step.status === 'returned'
                          ? ('error' as const)
                          : step.status === 'active'
                            ? ('process' as const)
                            : ('wait' as const),
                  })),
                  ...selected.route
                    .filter((step) => step.status === 'invalidated')
                    .map((step) => ({
                      title: (
                        <Space>
                          <span style={{ textDecoration: 'line-through' }}>{step.role}</span>
                          <Tag color="default">已失效重算</Tag>
                        </Space>
                      ),
                      description: (
                        <Tooltip
                          title={step.history.map((h) => h.comment).join('；') || '无历史意见'}
                        >
                          <span className="muted">{step.invalidatedNote}（意见已留痕）</span>
                        </Tooltip>
                      ),
                      status: 'wait' as const,
                    })),
                ]}
              />
              {currentStep ? null : (
                <span className="muted">
                  {selected.status === 'released' ? '批次已放行' : '无活动审批节点'}
                </span>
              )}
            </div>

            <div>
              <h4>文件引用版本与换版重算</h4>
              <Table
                rowKey="fileId"
                size="small"
                pagination={false}
                dataSource={selected.files}
                columns={[
                  { title: '文件', dataIndex: 'fileName' },
                  {
                    title: '固化引用',
                    width: 110,
                    render: (_, ref) => (
                      <span>
                        {ref.versionLabel}
                        <br />
                        <span className="mono muted" style={{ fontSize: 11 }}>
                          {ref.versionHash}
                        </span>
                      </span>
                    ),
                  },
                  {
                    title: '摘要',
                    width: 150,
                    render: (_, ref) => <DigestTags digests={ref.digests} />,
                  },
                  {
                    title: '换版',
                    width: 90,
                    render: (_, ref) =>
                      selected.status === 'released' ? (
                        <Tag color="success">已锁定</Tag>
                      ) : (
                        <Button
                          size="small"
                          type="link"
                          onClick={() =>
                            run(
                              () =>
                                changeVersion({
                                  packageId: selected.packageId,
                                  fileId: ref.fileId,
                                  label: `${ref.versionLabel.split(/[-.]/)[0]}-${Date.now().toString().slice(-4)}`,
                                  summary: `《${ref.fileName}》换版：仅重算依赖该文件的待审批步骤与未核回执`,
                                }),
                              '换版完成：受影响节点与未核回执已失效重算',
                            )
                          }
                        >
                          模拟换版
                        </Button>
                      ),
                  },
                ]}
              />
              <Alert
                style={{ marginTop: 10 }}
                type="info"
                showIcon
                message="已确认意见与已生成的许可记录永久保留；换版只影响待审批步骤和未核回执。"
              />
            </div>
          </div>

          <Collapse
            style={{ marginTop: 16 }}
            items={[
              {
                key: 'receipts',
                label: `许可回执台账（${selected.receipts.length} 张，重复件只入一次）`,
                children: (
                  <Table
                    rowKey="id"
                    size="small"
                    columns={receiptColumns}
                    dataSource={selected.receipts}
                    pagination={false}
                  />
                ),
              },
              {
                key: 'digests',
                label: '逐页脱敏摘要（送审固化 / 旧数据回填）',
                children: (
                  <Space direction="vertical" style={{ width: '100%' }} size={12}>
                    {selected.files.map((ref) => (
                      <div key={ref.fileId}>
                        <strong>
                          {ref.fileName} · {ref.versionLabel}
                        </strong>
                        <Table
                          rowKey="pageId"
                          size="small"
                          style={{ marginTop: 6 }}
                          pagination={false}
                          dataSource={ref.digests}
                          columns={[
                            { title: '页', dataIndex: 'page', width: 60 },
                            {
                              title: '脱敏摘要',
                              dataIndex: 'redactedSummary',
                              render: (v: string) => <span className="mono">{v}</span>,
                            },
                            {
                              title: '指纹',
                              dataIndex: 'hash',
                              width: 110,
                              render: (v: string) => <span className="mono">{v}</span>,
                            },
                            {
                              title: '来源',
                              dataIndex: 'state',
                              width: 110,
                              render: (value: PageDigest['state']) => (
                                <Tag
                                  color={
                                    value === 'ok' ? 'blue' : value === 'backfilled' ? 'cyan' : 'error'
                                  }
                                >
                                  {value === 'ok' ? '送审固化' : value === 'backfilled' ? '首次送审回填' : '补不全'}
                                </Tag>
                              ),
                            },
                          ]}
                        />
                      </div>
                    ))}
                  </Space>
                ),
              },
              {
                key: 'attempts',
                label: `批次写入与重试记录（${selected.attempts.length}）`,
                children: (
                  <Timeline
                    items={selected.attempts.map((attempt) => ({
                      color: attempt.ok ? 'green' : 'red',
                      children: (
                        <span>
                          {new Date(attempt.at).toLocaleString('zh-CN')} · {attempt.action} · 第 {attempt.attempt} 次 ·{' '}
                          {attempt.actor} {attempt.ok ? '成功' : `失败：${attempt.error}`}
                        </span>
                      ),
                    }))}
                  />
                ),
              },
            ]}
          />
        </section>
      ) : null}

      <Modal
        title="送审并固化对账批次"
        open={Boolean(freezePackageId)}
        onCancel={() => setFreezePackageId(undefined)}
        onOk={() => {
          if (freezePackageId) {
            void run(
              () => freezeBatch({ packageId: freezePackageId }),
              '已固化当前资料包版本、文件引用版本与逐页脱敏摘要',
            )
          }
          setFreezePackageId(undefined)
        }}
        okText="确认送审固化"
      >
        <p className="muted">送审时将冻结以下内容，后续文件换版不会静默改动旧批次：</p>
        <ul>
          <li>资料包当前版本快照与整体指纹</li>
          <li>每个文件的引用版本与逐页脱敏摘要（内容指纹）</li>
          <li>按规则等级生成、显式携带文件依赖的审批路线</li>
        </ul>
        <Select
          style={{ width: '100%' }}
          value={freezePackageId}
          onChange={setFreezePackageId}
          options={data.packages.map((pkg: MaterialPackage) => ({
            value: pkg.id,
            label: `${pkg.code} · ${pkg.title}`,
          }))}
        />
      </Modal>

      <Modal
        title={decisionPassed ? '确认审批通过' : '退回补正'}
        open={Boolean(decideStep)}
        onCancel={() => setDecideStep(undefined)}
        onOk={confirmDecision}
        okText={decisionPassed ? '确认通过' : '确认退回'}
        okButtonProps={{ danger: !decisionPassed }}
      >
        <Alert
          style={{ marginBottom: 12 }}
          type={decisionPassed ? 'info' : 'warning'}
          showIcon
          message={
            decisionPassed
              ? '意见将计入批次；若该节点依赖文件之后换版，待审批节点失效重算，已确认意见保留。'
              : '退回后批次回到已固化补正态，重新发起只重算未定论节点。'
          }
        />
        <Input.TextArea
          rows={3}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder="填写审批意见"
        />
      </Modal>
    </div>
  )
}
