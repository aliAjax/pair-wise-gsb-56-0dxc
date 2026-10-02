import { useMemo, useState } from 'react'
import { Button, Input, Select, Space, Table, Tag, message } from 'antd'
import type { TableColumnsType } from 'antd'
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import { PageHeader } from '@/components/PageHeader'
import {
  useAddAuditMutation,
  useGetWorkspaceQuery,
  useResetWorkspaceMutation,
} from '@/app/api'
import type { AuditEntry, ReconciliationBatch } from '@/types/domain'
import { buildBatchExport } from '@/services/reconciliation'

function downloadFile(name: string, content: string, type: string) {
  const blob = new Blob([`\ufeff${content}`], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

export function AuditPage() {
  const { data, isLoading } = useGetWorkspaceQuery()
  const [addAudit] = useAddAuditMutation()
  const [resetWorkspace, resetState] = useResetWorkspaceMutation()
  const [keyword, setKeyword] = useState('')
  const [action, setAction] = useState('')
  const [packageId, setPackageId] = useState('')
  const [batchId, setBatchId] = useState<string | undefined>(undefined)

  const actions = useMemo(
    () => [...new Set(data?.audit.map((item) => item.action) ?? [])],
    [data],
  )
  const filtered = useMemo(
    () =>
      data?.audit.filter((item) => {
        const matchesKeyword =
          !keyword ||
          `${item.action}${item.target}${item.detail}`.toLowerCase().includes(keyword.toLowerCase())
        return (
          matchesKeyword &&
          (!action || item.action === action) &&
          (!packageId || item.packageId === packageId)
        )
      }) ?? [],
    [action, data, keyword, packageId],
  )

  if (isLoading || !data) return <div className="panel">正在加载审计日志...</div>
  const workspace = data

  const columns: TableColumnsType<AuditEntry> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (value: string) => new Date(value).toLocaleString('zh-CN'),
    },
    { title: '操作', dataIndex: 'action', width: 130 },
    {
      title: '资料包',
      dataIndex: 'packageId',
      width: 140,
      render: (value: string | undefined) =>
        data.packages.find((item) => item.id === value)?.code ?? '系统',
    },
    { title: '对象', dataIndex: 'target', width: 220 },
    { title: '操作人', dataIndex: 'operator', width: 105 },
    {
      title: '详情',
      dataIndex: 'detail',
      render: (value: string) => <div className="audit-detail">{value}</div>,
    },
  ]

  async function exportTrace() {
    const payload = {
      exportedAt: new Date().toISOString(),
      policySet: '2026 出口管制规则集',
      packages: workspace.packages.map((item) => ({
        code: item.code,
        title: item.title,
        destination: item.destination,
        status: item.status,
        round: item.currentRound,
        rule: workspace.rules.find((rule) => rule.id === item.matchedRuleId)?.name,
        files: workspace.files
          .filter((file) => file.packageId === item.id)
          .map((file) => ({
            name: file.name,
            activeVersion: file.versions.find((version) => version.id === file.activeVersionId)?.label,
            referencedVersion: file.versions.find(
              (version) => version.id === file.referencedVersionId,
            )?.label,
          })),
      })),
      findings: workspace.findings,
      reconciliationBatches: workspace.batches.map((batch) =>
        buildBatchExport(
          batch,
          workspace.packages.find((pkg) => pkg.id === batch.packageId),
        ),
      ),
      licenseRecords: workspace.licenses,
      platformInbox: workspace.inbox,
      pendingRetry: workspace.pendingActions.map((item) => ({
        batchNo: item.fullBatchSnapshot.batchNo,
        action: item.action,
        attempts: item.attempts,
        lastError: item.lastError,
        snapshotRev: item.fullBatchSnapshot.rev,
      })),
      audit: workspace.audit,
    }
    await addAudit({
      entry: {
        action: '导出追溯包',
        target: '全量审批追溯 JSON',
        operator: '当前用户',
        detail: `导出 ${workspace.packages.length} 个资料包、${workspace.batches.length} 个对账批次与 ${workspace.audit.length} 条审计记录。`,
      },
    }).unwrap()
    downloadFile(
      `出口管制审批追溯-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8',
    )
    message.success('追溯包已导出并写入审计')
  }

  async function exportBatch(batch: ReconciliationBatch) {
    const pkg = workspace.packages.find((item) => item.id === batch.packageId)
    const payload = buildBatchExport(batch, pkg)
    await addAudit({
      entry: {
        packageId: batch.packageId,
        action: '导出批次对账包',
        target: batch.batchNo,
        operator: '当前用户',
        detail: `导出同批次的固化版本、逐页摘要、审批路线、回执台账与许可记录。`,
      },
    }).unwrap()
    downloadFile(
      `对账批次-${batch.batchNo}.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8',
    )
    message.success(`批次 ${batch.batchNo} 对账包已导出`)
  }

  function exportCsv() {
    const header = ['时间', '操作', '资料包', '对象', '操作人', '详情']
    const rows = filtered.map((item) => [
      new Date(item.createdAt).toLocaleString('zh-CN'),
      item.action,
      workspace.packages.find((pkg) => pkg.id === item.packageId)?.code ?? '系统',
      item.target,
      item.operator,
      item.detail,
    ])
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','))
      .join('\n')
    downloadFile('出口管制审计日志.csv', csv, 'text/csv;charset=utf-8')
  }

  async function reset() {
    await resetWorkspace().unwrap()
    message.success('演示数据已恢复')
  }

  return (
    <div>
      <PageHeader
        title="审计与追溯导出"
        description="按资料包查看拆解、分类、版本、审批、额度扣减和导出操作，生成完整追溯包。"
        actions={
          <Space>
            <Button danger icon={<ReloadOutlined />} loading={resetState.isLoading} onClick={reset}>
              恢复演示数据
            </Button>
            <Button onClick={exportCsv}>导出当前日志</Button>
            <Button type="primary" icon={<DownloadOutlined />} onClick={exportTrace}>
              导出追溯包
            </Button>
          </Space>
        }
      />

      <div className="toolbar">
        <Input.Search
          allowClear
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索操作、对象或详情"
          style={{ width: 280 }}
        />
        <Select
          allowClear
          value={action || undefined}
          onChange={(value) => setAction(value ?? '')}
          placeholder="操作类型"
          style={{ width: 180 }}
          options={actions.map((value) => ({ value, label: value }))}
        />
        <Select
          allowClear
          value={packageId || undefined}
          onChange={(value) => setPackageId(value ?? '')}
          placeholder="资料包"
          style={{ width: 240 }}
          options={data.packages.map((item) => ({ value: item.id, label: `${item.code} · ${item.title}` }))}
        />
        <span className="grow" />
        <Tag>{filtered.length} 条日志</Tag>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h3>按对账批次导出（审批 / 版本差异 / 回执 / 许可同一批次）</h3>
          <Select
            allowClear
            placeholder="选择对账批次"
            style={{ width: 320 }}
            value={batchId}
            onChange={setBatchId}
            options={data.batches.map((batch) => {
              const pkg = data.packages.find((item) => item.id === batch.packageId)
              return {
                value: batch.id,
                label: `${batch.batchNo} · ${pkg?.code ?? batch.packageId} · ${batch.packageVersionLabel}`,
              }
            })}
          />
        </div>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={data.batches}
          columns={[
            { title: '批次号', dataIndex: 'batchNo', width: 160, render: (v: string) => <span className="mono">{v}</span> },
            {
              title: '资料包',
              render: (_, batch) =>
                data.packages.find((item) => item.id === batch.packageId)?.code ?? batch.packageId,
            },
            { title: '固化版本', dataIndex: 'packageVersionLabel', width: 100 },
            {
              title: '审批 / 回执 / 许可',
              width: 220,
              render: (_, batch) => {
                const license = data.licenses.find((item) => item.batchId === batch.id)
                return (
                  <Space size={4}>
                    <Tag>{batch.route.filter((s) => s.status === 'approved').length} 步通过</Tag>
                    <Tag>{batch.receipts.filter((r) => r.state === 'verified').length} 回执已核</Tag>
                    {license ? <Tag color="success">许可已生成</Tag> : null}
                  </Space>
                )
              },
            },
            {
              title: '操作',
              width: 130,
              render: (_, batch) => (
                <Button size="small" type="link" icon={<DownloadOutlined />} onClick={() => exportBatch(batch)}>
                  导出该批次
                </Button>
              ),
            },
          ]}
          rowClassName={(batch) => (batch.id === batchId ? 'ant-table-row-selected' : '')}
          onRow={(batch) => ({ onClick: () => setBatchId(batch.id), style: { cursor: 'pointer' } })}
        />
      </section>

      <section className="panel">
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          scroll={{ x: 1180 }}
          pagination={{ pageSize: 10, showSizeChanger: false }}
        />
      </section>
    </div>
  )
}
