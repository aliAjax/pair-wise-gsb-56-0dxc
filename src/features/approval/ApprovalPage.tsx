import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Descriptions,
  Input,
  Modal,
  Space,
  Steps,
  Table,
  Tag,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { Link, useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { StatusTag } from '@/components/StatusTag'
import { BatchStatusTag } from '@/components/BatchTags'
import {
  useDecideApprovalMutation,
  useGetWorkspaceQuery,
  useSubmitApprovalMutation,
} from '@/app/api'
import type { ApprovalStep, MaterialPackage } from '@/types/domain'
import { approvalLevelLabels } from '@/services/rules'

export function ApprovalPage() {
  const [searchParams] = useSearchParams()
  const { data, isLoading } = useGetWorkspaceQuery()
  const [submitApproval, submitState] = useSubmitApprovalMutation()
  const [decideApproval, decideState] = useDecideApprovalMutation()
  const [selectedId, setSelectedId] = useState(searchParams.get('package') ?? '')
  const [decision, setDecision] = useState<'approve' | 'return'>('approve')
  const [decisionOpen, setDecisionOpen] = useState(false)
  const [comment, setComment] = useState('')
  const [decidingStep, setDecidingStep] = useState<ApprovalStep>()

  useEffect(() => {
    if (!selectedId && data?.packages[0]) setSelectedId(data.packages[0].id)
  }, [data, selectedId])

  const selected = useMemo(
    () => data?.packages.find((item) => item.id === selectedId),
    [data, selectedId],
  )
  const openBatch = useMemo(
    () =>
      selected
        ? [...(data?.batches ?? [])]
            .reverse()
            .find((batch) => batch.packageId === selected.id && batch.status !== 'released')
        : undefined,
    [data, selected],
  )
  const rule = data?.rules.find(
    (item) => item.id === (openBatch ? openBatch.ruleId : selected?.matchedRuleId),
  )
  const route = openBatch?.route ?? selected?.approvalRoute ?? []

  if (isLoading || !data) return <div className="panel">正在加载审批路线...</div>
  const workspace = data

  const packageColumns: TableColumnsType<MaterialPackage> = [
    { title: '编号', dataIndex: 'code', width: 135 },
    { title: '资料包', dataIndex: 'title', minWidth: 220 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: MaterialPackage['status']) => <StatusTag status={value} />,
    },
    {
      title: '对账批次',
      width: 130,
      render: (_, record) => {
        const batch = [...workspace.batches]
          .reverse()
          .find((item) => item.packageId === record.id)
        return batch ? (
          <Space direction="vertical" size={0}>
            <Link to={`/reconcile?package=${record.id}`}>{batch.code}</Link>
            <BatchStatusTag status={batch.status} />
          </Space>
        ) : (
          <span className="muted">未送审</span>
        )
      },
    },
    {
      title: '当前步骤',
      width: 160,
      render: (_, record) => {
        const batch = [...workspace.batches]
          .reverse()
          .find((item) => item.packageId === record.id && item.status !== 'released')
        return (
          batch?.route.find((step) => step.status === 'active')?.role ??
          (batch?.status === 'released' ? '批次已放行' : '无活动步骤')
        )
      },
    },
  ]

  const stepColumns: TableColumnsType<ApprovalStep> = [
    { title: '顺序', dataIndex: 'order', width: 60 },
    { title: '审批角色', dataIndex: 'role', width: 150 },
    { title: '处理人', dataIndex: 'assignee', width: 130 },
    {
      title: '等级',
      dataIndex: 'level',
      width: 100,
      render: (value: ApprovalStep['level']) => approvalLevelLabels[value],
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: ApprovalStep['status']) => (
        <Tag
          color={
            value === 'approved'
              ? 'success'
              : value === 'active'
                ? 'processing'
                : value === 'returned'
                  ? 'error'
                  : value === 'invalidated'
                    ? 'orange'
                    : 'default'
          }
        >
          {value === 'approved'
            ? '已通过'
            : value === 'active'
              ? '待审批'
              : value === 'returned'
                ? '已退回'
                : value === 'invalidated'
                  ? '换版失效'
                  : '未开始'}
        </Tag>
      ),
    },
    {
      title: '意见 / 失效原因',
      render: (_, record) =>
        record.invalidatedReason ? (
          <span className="finding-message">{record.invalidatedReason}</span>
        ) : record.comment ? (
          record.comment
        ) : (
          <span className="muted">无（已确认意见在换版后保留）</span>
        ),
    },
    {
      title: '操作',
      width: 150,
      render: (_, record) =>
        record.status === 'active' && openBatch ? (
          <Space>
            <Button
              type="link"
              onClick={() => {
                setDecidingStep(record)
                setDecision('approve')
                setDecisionOpen(true)
              }}
            >
              通过
            </Button>
            <Button
              type="link"
              danger
              onClick={() => {
                setDecidingStep(record)
                setDecision('return')
                setDecisionOpen(true)
              }}
            >
              退回
            </Button>
          </Space>
        ) : null,
    },
  ]

  async function submitCurrent() {
    if (!selected) return
    try {
      await submitApproval({ packageId: selected.id }).unwrap()
      message.success('已固化当前版本与逐页脱敏摘要，对账批次送审')
    } catch (error) {
      const detail =
        typeof error === 'object' && error && 'data' in error
          ? (error.data as { error?: string }).error
          : undefined
      message.error(detail ?? '送审失败')
    }
  }

  async function confirmDecision() {
    if (!selected || !decidingStep) return
    try {
      await decideApproval({
        packageId: selected.id,
        stepId: decidingStep.id,
        decision,
        comment,
      }).unwrap()
      message.success(decision === 'approve' ? '审批步骤已通过' : '资料包已退回，进入新一轮补正')
      setDecisionOpen(false)
      setComment('')
      setDecidingStep(undefined)
    } catch (error) {
      const detail =
        typeof error === 'object' && error && 'data' in error
          ? (error.data as { error?: string }).error
          : undefined
      message.error(detail ?? '审批失败')
    }
  }

  const canSubmit = Boolean(
    selected &&
      !openBatch &&
      !workspace.findings.some(
        (item) => item.packageId === selected.id && item.level === 'high',
      ),
  )

  return (
    <div>
      <PageHeader
        title="审批路线"
        description="审批路线属于对账批次：送审固化版本后逐级确认，换版只失效依赖步骤，已确认意见保留。"
        actions={
          <Button type="primary" disabled={!canSubmit} loading={submitState.isLoading} onClick={submitCurrent}>
            送审并固化对账批次
          </Button>
        }
      />

      <section className="panel">
        <div className="panel-title">
          <h3>待处理资料包</h3>
          <span className="muted">选择资料包后查看其对账批次的审批路线</span>
        </div>
        <Table
          rowKey="id"
          columns={packageColumns}
          dataSource={data.packages}
          pagination={false}
          rowClassName={(record) => (record.id === selectedId ? 'ant-table-row-selected' : '')}
          onRow={(record) => ({ onClick: () => setSelectedId(record.id) })}
        />
      </section>

      {selected ? (
        <div className="two-column">
          <section className="panel">
            <div className="panel-title">
              <h3>{selected.title}</h3>
              <StatusTag status={selected.status} />
            </div>
            {openBatch ? (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Space wrap>
                  <Link to={`/reconcile?package=${selected.id}`}>
                    <Button type="link" style={{ padding: 0 }}>
                      打开对账批次 {openBatch.code}
                    </Button>
                  </Link>
                  <BatchStatusTag status={openBatch.status} />
                  <Tag color="blue">固化版本 {openBatch.packageVersionLabel}</Tag>
                  <Tag color="purple">rev {openBatch.revision}</Tag>
                </Space>
                {openBatch.status === 'invalidated' ? (
                  <Alert
                    type="warning"
                    showIcon
                    message="文件换版后相关待审批步骤已失效，已确认意见保留。"
                    description="请到回执对账页按当前引用版本重算后续办。"
                  />
                ) : null}
                {openBatch.status === 'blocked' ? (
                  <Alert
                    type="error"
                    showIcon
                    message="旧批次逐页脱敏摘要补不全，审批与放行被阻断。"
                  />
                ) : null}
                {openBatch.pendingReason && openBatch.status === 'pending' ? (
                  <Alert type="warning" showIcon message={openBatch.pendingReason} />
                ) : null}
                <Steps
                  direction="vertical"
                  current={route.findIndex((step) => step.status === 'active')}
                  items={route.map((step) => ({
                    title: step.role,
                    description: (
                      <Space direction="vertical" size={2}>
                        {`${step.assignee} · ${
                          step.status === 'approved'
                            ? `已通过${step.decidedRound ? `（第 ${step.decidedRound} 轮意见）` : ''}`
                            : step.status === 'returned'
                              ? '已退回'
                              : step.status === 'invalidated'
                                ? '换版失效待重算'
                                : step.status === 'active'
                                  ? '待处理'
                                  : '等待前序步骤'
                        }`}
                        {step.invalidatedReason ? (
                          <span className="finding-message">{step.invalidatedReason}</span>
                        ) : null}
                      </Space>
                    ),
                    status:
                      step.status === 'approved'
                        ? 'finish'
                        : step.status === 'returned' || step.status === 'invalidated'
                          ? 'error'
                          : step.status === 'active'
                            ? 'process'
                            : 'wait',
                  }))}
                />
              </Space>
            ) : (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Alert type="info" showIcon message="尚未生成对账批次，点击右上角“送审并固化对账批次”。" />
                {workspace.findings.some(
                  (item) => item.packageId === selected.id && item.level === 'high',
                ) ? (
                  <Alert
                    type="error"
                    showIcon
                    message="存在高风险核对项或文件版本错配，修复后才能送审固化。"
                  />
                ) : null}
              </Space>
            )}
          </section>

          <section className="panel">
            <div className="panel-title">
              <h3>规则与轮次</h3>
              <Tag>{openBatch ? `第 ${openBatch.round} 轮` : selected.currentRound ? `第 ${selected.currentRound} 轮` : '未送审'}</Tag>
            </div>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="匹配规则">{rule?.name ?? '未匹配'}</Descriptions.Item>
              <Descriptions.Item label="规则等级">
                {rule ? approvalLevelLabels[rule.approvalLevel] : '未知'}
              </Descriptions.Item>
              <Descriptions.Item label="固化资料包版本">
                {openBatch?.packageVersionLabel ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label="固化文件">
                {openBatch
                  ? `${openBatch.frozenFiles.length} 个；逐页摘要 ${
                      openBatch.frozenDigestComplete ? '完整' : '缺失'
                    }`
                  : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="收件方">{selected.recipient}</Descriptions.Item>
              <Descriptions.Item label="最终用途">{selected.endUse}</Descriptions.Item>
            </Descriptions>
          </section>
        </div>
      ) : null}

      {openBatch ? (
        <section className="panel">
          <div className="panel-title">
            <h3>步骤明细与历史意见（同一批次 {openBatch.code}）</h3>
            <Tag>{openBatch.receipts.length} 份回执</Tag>
          </div>
          <Table rowKey="id" columns={stepColumns} dataSource={route} pagination={false} />
        </section>
      ) : null}

      <Modal
        title={decision === 'approve' ? '通过当前审批步骤' : '退回并进入补正'}
        open={decisionOpen}
        onCancel={() => setDecisionOpen(false)}
        onOk={confirmDecision}
        confirmLoading={decideState.isLoading}
        okText={decision === 'approve' ? '确认通过' : '确认退回'}
        okButtonProps={{ danger: decision === 'return' }}
        cancelText="取消"
      >
        <Alert
          type={decision === 'approve' ? 'info' : 'warning'}
          showIcon
          message={
            decision === 'approve'
              ? '通过后进入下一审批角色；两人同时确认时只放行一个。'
              : '退回后当前轮次结束，补充资料后重新发起并增加轮次。'
          }
          style={{ marginBottom: 14 }}
        />
        <Input.TextArea
          rows={4}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder={decision === 'approve' ? '填写审批意见' : '明确说明退回原因和补正要求'}
        />
      </Modal>
    </div>
  )
}
