import { useEffect, useMemo, useState } from 'react'
import { Alert, Descriptions, Select, Space, Table, Tag, message } from 'antd'
import type { TableColumnsType } from 'antd'
import { Link, useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import {
  useGetWorkspaceQuery,
  useSetReferenceVersionMutation,
} from '@/app/api'
import { BatchStatusTag } from '@/components/BatchTags'
import type { MaterialFile, ReconcileBatch, VersionDiff } from '@/types/domain'
import { diffBatch, diffPackageVersions } from '@/services/rules'

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
  const packageBatches = useMemo(
    () =>
      data
        ? [...data.batches]
            .filter((batch) => batch.packageId === selectedId)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        : [],
    [data, selectedId],
  )

  useEffect(() => {
    if (selected && !selected.versions.some((version) => version.id === versionId)) {
      setVersionId(selected.versions[0]?.id ?? '')
    }
  }, [selected, versionId])

  if (isLoading || !data) return <div className="panel">正在加载版本数据...</div>

  const snapshotDiffs = selected ? diffPackageVersions(selected, versionId, files) : []

  const diffColumns: TableColumnsType<VersionDiff> = [
    {
      title: '范围',
      dataIndex: 'kind',
      width: 110,
      render: (value: VersionDiff['kind']) =>
        value === 'package' ? '资料包快照' : value === 'batch' ? '对账批次' : '文件引用',
    },
    { title: '字段', dataIndex: 'field', width: 210 },
    {
      title: '基线 / 固化值',
      dataIndex: 'before',
      render: (value: string) => <span className="diff-before">{value}</span>,
    },
    {
      title: '当前值',
      dataIndex: 'after',
      render: (value: string) => <span className="diff-after">{value}</span>,
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
            try {
              await setReferenceVersion({ fileId: file.id, versionId: nextVersionId }).unwrap()
              message.success('引用版本已切换：依赖该文件的待审批步骤与未核回执已失效，可重算续办')
            } catch (error) {
              const detail =
                typeof error === 'object' && error && 'data' in error
                  ? (error.data as { error?: string }).error
                  : undefined
              message.error(detail ?? '引用版本切换失败')
            }
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
      title: '送审批次中的固化版本',
      width: 200,
      render: (_, file) => {
        const open = packageBatches.find((batch) => batch.status !== 'released')
        const frozen = open?.frozenFiles.find((item) => item.fileId === file.id)
        if (!frozen) return <span className="muted">无开放批次</span>
        const matches = frozen.versionId === file.referencedVersionId
        return (
          <Space size={4}>
            <Tag color={matches ? 'blue' : 'red'}>{frozen.versionLabel}</Tag>
            {matches ? <Tag color="success">一致</Tag> : <Tag color="orange">批次待重算</Tag>}
          </Space>
        )
      },
    },
  ]

  const batchColumns: TableColumnsType<ReconcileBatch> = [
    {
      title: '对账批次',
      width: 170,
      render: (_, record) => (
        <Link to={`/reconcile?package=${record.packageId}`}>{record.code}</Link>
      ),
    },
    {
      title: '固化资料包版本',
      width: 130,
      render: (_, record) => <Tag color="blue">{record.packageVersionLabel}</Tag>,
    },
    {
      title: '批次状态',
      width: 110,
      render: (_, record) => <BatchStatusTag status={record.status} />,
    },
    {
      title: '与当前引用的差异',
      render: (_, record) => {
        const diffs = diffBatch(record, files)
        return diffs.length ? (
          <Space direction="vertical" size={2}>
            {diffs.map((item) => (
              <Tag key={item.id} color="warning">
                {item.field}：{item.before} → {item.after}
              </Tag>
            ))}
          </Space>
        ) : (
          <Tag color="success">固化版本与逐页摘要无漂移</Tag>
        )
      },
    },
  ]

  const openBatch = packageBatches.find((batch) => batch.status !== 'released')
  const openBatchDiffs = openBatch ? diffBatch(openBatch, files) : []

  return (
    <div>
      <PageHeader
        title="版本差异"
        description="同一对账批次视角：比较送审固化版本、文件引用版本与逐页脱敏摘要，换版只影响依赖步骤并可重算。"
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
          placeholder="选择资料包基线版本"
          style={{ width: 220 }}
          onChange={setVersionId}
          options={selected?.versions.map((version) => ({
            value: version.id,
            label: `${version.label} · ${version.createdAt.slice(0, 10)}`,
          }))}
        />
        <span className="grow" />
        <Tag color={snapshotDiffs.length ? 'warning' : 'success'}>
          快照差异 {snapshotDiffs.length} 项
        </Tag>
        <Tag color={openBatchDiffs.length ? 'orange' : 'success'}>
          开放批次差异 {openBatchDiffs.length} 项
        </Tag>
      </div>

      {selected ? (
        <div className="two-column">
          <section className="panel">
            <div className="panel-title">
              <h3>资料包快照与当前差异</h3>
            </div>
            <Table
              rowKey="id"
              columns={diffColumns}
              dataSource={snapshotDiffs}
              pagination={false}
              locale={{ emptyText: '当前与所选基线没有差异' }}
            />
          </section>
          <section className="panel">
            <div className="panel-title">
              <h3>开放批次固化差异</h3>
              {openBatch ? <BatchStatusTag status={openBatch.status} /> : null}
            </div>
            {openBatch ? (
              <Table
                rowKey="id"
                columns={diffColumns}
                dataSource={openBatchDiffs}
                pagination={false}
                locale={{ emptyText: '送审固化版本与当前引用、逐页脱敏摘要完全一致' }}
              />
            ) : (
              <Alert type="info" showIcon message="该资料包当前没有开放中的对账批次。" />
            )}
          </section>
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-title">
          <h3>对账批次版本差异（审批、版本差异、导出展示同一批次）</h3>
          <Tag>{packageBatches.length} 个批次</Tag>
        </div>
        <Table
          rowKey="id"
          columns={batchColumns}
          dataSource={packageBatches}
          pagination={false}
          locale={{ emptyText: '尚无对账批次' }}
        />
      </section>

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
            message="全部文件版本引用一致；切换引用版本会使依赖该文件的待审批步骤和未核回执失效，已确认意见与许可记录保留。"
            style={{ marginTop: 14 }}
          />
        )}
        <Descriptions column={1} size="small" style={{ marginTop: 14 }}>
          <Descriptions.Item label="当前目的地">{selected?.destination}</Descriptions.Item>
          <Descriptions.Item label="当前声明">
            {selected?.declarations.join('、')}
          </Descriptions.Item>
        </Descriptions>
      </section>
    </div>
  )
}
