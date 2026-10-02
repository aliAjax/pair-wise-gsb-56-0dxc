import { useEffect, useMemo, useState } from 'react'
import { Alert, Descriptions, Select, Space, Table, Tag, message } from 'antd'
import type { TableColumnsType } from 'antd'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import {
  useGetWorkspaceQuery,
  useSetReferenceVersionMutation,
} from '@/app/api'
import type { MaterialFile, ReconciliationBatch, VersionDiff } from '@/types/domain'
import { diffPackageVersions } from '@/services/rules'
import { batchStatusColor, batchStatusLabels } from '@/services/reconciliation'

export function VersionDiffPage() {
  const [searchParams] = useSearchParams()
  const { data, isLoading } = useGetWorkspaceQuery()
  const [setReferenceVersion] = useSetReferenceVersionMutation()
  const [selectedId, setSelectedId] = useState(searchParams.get('package') ?? '')
  const [versionId, setVersionId] = useState('')

  useEffect(() => {
    if (!selectedId && data?.packages[0]) setSelectedId(data.packages[0].id)
  }, [data, selectedId])

  const selected = useMemo(
    () => data?.packages.find((item) => item.id === selectedId),
    [data, selectedId],
  )
  const files = data?.files.filter((file) => file.packageId === selectedId) ?? []

  useEffect(() => {
    if (selected && !selected.versions.some((version) => version.id === versionId)) {
      setVersionId(selected.versions[0]?.id ?? '')
    }
  }, [selected, versionId])

  // 批次视角：同一批次固化的文件引用版本与现行版本差异
  const packageBatches = useMemo(
    () => (data && selectedId ? data.batches.filter((batch) => batch.packageId === selectedId) : []),
    [data, selectedId],
  )
  const [batchId, setBatchId] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!packageBatches.some((batch) => batch.id === batchId)) {
      setBatchId(packageBatches[0]?.id)
    }
  }, [packageBatches, batchId])

  if (isLoading || !data) return <div className="panel">正在加载版本数据...</div>

  const diffs = selected ? diffPackageVersions(selected, versionId, files) : []

  const selectedBatch: ReconciliationBatch | undefined = packageBatches.find(
    (batch) => batch.id === batchId,
  )

  const batchFileColumns: TableColumnsType<ReconciliationBatch['files'][number]> = [
    { title: '文件', dataIndex: 'fileName' },
    {
      title: '批次固化引用',
      width: 150,
      render: (_, ref) => (
        <Tag color="blue">
          {ref.versionLabel} · {ref.versionHash}
        </Tag>
      ),
    },
    {
      title: '现行版本',
      width: 150,
      render: (_, ref) => {
        const file = files.find((item) => item.id === ref.fileId)
        const current = file?.versions.find((version) => version.id === file?.activeVersionId)
        const changed = current?.id !== ref.versionId
        return (
          <Tag color={changed ? 'error' : 'success'}>
            {current?.label ?? '版本已删除'} {changed ? '· 已换版' : '· 一致'}
          </Tag>
        )
      },
    },
    {
      title: '逐页摘要',
      render: (_, ref) => `${ref.digests.length} 页 · 指纹 ${ref.digests[0]?.hash ?? '—'}`,
    },
  ]

  const fileColumns: TableColumnsType<MaterialFile> = [
    { title: '文件名称', dataIndex: 'name', minWidth: 230 },
    {
      title: '现行版本',
      width: 130,
      render: (_, file) =>
        file.versions.find((version) => version.id === file.activeVersionId)?.label,
    },
    {
      title: '审批引用版本',
      width: 190,
      render: (_, file) => (
        <Select
          value={file.referencedVersionId}
          style={{ width: 165 }}
          options={file.versions.map((version) => ({
            value: version.id,
            label: `${version.label} · ${version.hash}`,
          }))}
          onChange={async (nextVersionId) => {
            await setReferenceVersion({ fileId: file.id, versionId: nextVersionId }).unwrap()
            message.success('版本引用已切换并写入审计')
          }}
        />
      ),
    },
    {
      title: '一致性',
      width: 105,
      render: (_, file) => (
        <Tag color={file.activeVersionId === file.referencedVersionId ? 'success' : 'error'}>
          {file.activeVersionId === file.referencedVersionId ? '一致' : '错配'}
        </Tag>
      ),
    },
    {
      title: '版本数',
      width: 90,
      render: (_, file) => file.versions.length,
    },
  ]

  const diffColumns: TableColumnsType<VersionDiff> = [
    {
      title: '范围',
      dataIndex: 'kind',
      width: 90,
      render: (value: VersionDiff['kind']) => (value === 'package' ? '资料包' : '文件引用'),
    },
    { title: '字段', dataIndex: 'field', width: 190 },
    {
      title: '基线值',
      dataIndex: 'before',
      render: (value: string) => <span className="diff-before">{value}</span>,
    },
    {
      title: '当前值',
      dataIndex: 'after',
      render: (value: string) => <span className="diff-after">{value}</span>,
    },
  ]

  return (
    <div>
      <PageHeader
        title="版本差异"
        description="比较资料包快照与当前申报信息，明确文件版本引用变化并阻断混用。"
      />

      <div className="toolbar">
        <Select
          value={selectedId || undefined}
          placeholder="选择资料包"
          style={{ width: 330 }}
          onChange={(value) => {
            setSelectedId(value)
            setVersionId('')
          }}
          options={data.packages.map((item) => ({
            value: item.id,
            label: `${item.code} · ${item.title}`,
          }))}
        />
        <Select
          value={versionId || undefined}
          placeholder="选择基线版本"
          style={{ width: 220 }}
          onChange={setVersionId}
          options={selected?.versions.map((version) => ({
            value: version.id,
            label: `${version.label} · ${version.createdAt.slice(0, 10)}`,
          }))}
        />
        <span className="grow" />
        <Tag color={diffs.length ? 'warning' : 'success'}>{diffs.length} 项差异</Tag>
      </div>

      {selected ? (
        <div className="two-column">
          <section className="panel">
            <div className="panel-title">
              <h3>快照与当前差异</h3>
            </div>
            <Table
              rowKey="id"
              columns={diffColumns}
              dataSource={diffs}
              pagination={false}
              locale={{ emptyText: '当前与所选基线没有差异' }}
            />
          </section>
          <section className="panel">
            <div className="panel-title">
              <h3>版本信息</h3>
            </div>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="资料包">{selected.code}</Descriptions.Item>
              <Descriptions.Item label="版本数量">{selected.versions.length}</Descriptions.Item>
              <Descriptions.Item label="当前目的地">{selected.destination}</Descriptions.Item>
              <Descriptions.Item label="当前声明">
                {selected.declarations.join('、')}
              </Descriptions.Item>
              <Descriptions.Item label="技术参数">
                {selected.technologyTags.join('、')}
              </Descriptions.Item>
            </Descriptions>
          </section>
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-title">
          <h3>文件版本引用</h3>
          <Space>
            <Tag>{files.length} 个文件</Tag>
            <Tag color="error">
              {files.filter((file) => file.activeVersionId !== file.referencedVersionId).length} 个错配
            </Tag>
          </Space>
        </div>
        <Table rowKey="id" columns={fileColumns} dataSource={files} pagination={false} />
        {files.some((file) => file.activeVersionId !== file.referencedVersionId) ? (
          <Alert
            type="error"
            showIcon
            message="检测到文件版本错配，同一资料文件的不同版本不得在审批中混用。"
            style={{ marginTop: 14 }}
          />
        ) : (
          <Alert
            type="success"
            showIcon
            message="全部文件版本引用一致。"
            style={{ marginTop: 14 }}
          />
        )}
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>批次固化引用 vs 现行版本</h3>
          <Space>
            <Select
              size="small"
              style={{ width: 220 }}
              value={batchId}
              onChange={setBatchId}
              options={packageBatches.map((batch) => ({
                value: batch.id,
                label: `${batch.batchNo} · ${batch.packageVersionLabel}`,
              }))}
            />
            {selectedBatch ? <Tag color={batchStatusColor(selectedBatch.status)}>{batchStatusLabels[selectedBatch.status]}</Tag> : null}
          </Space>
        </div>
        {selectedBatch ? (
          <>
            <Descriptions size="small" column={3} style={{ marginBottom: 12 }}>
              <Descriptions.Item label="批次">
                <span className="mono">{selectedBatch.fingerprint}</span> 指纹
              </Descriptions.Item>
              <Descriptions.Item label="固化资料包版本">{selectedBatch.packageVersionLabel}</Descriptions.Item>
              <Descriptions.Item label="固化时间">
                {new Date(selectedBatch.frozenAt).toLocaleString('zh-CN')}
              </Descriptions.Item>
            </Descriptions>
            <Table
              rowKey="fileId"
              size="small"
              columns={batchFileColumns}
              dataSource={selectedBatch.files}
              pagination={false}
            />
            <Alert
              style={{ marginTop: 12 }}
              type="info"
              showIcon
              message="批次内的审批、回执核对与导出始终按固化引用对账；现行版本换版只触发受影响节点重算，不改写固化摘要。"
            />
          </>
        ) : (
          <Alert type="info" showIcon message="该资料包暂无对账批次，送审后在此查看固化引用差异。" />
        )}
      </section>
    </div>
  )
}
