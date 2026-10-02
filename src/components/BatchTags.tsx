import { Tag } from 'antd'
import type { BatchStatus, ReceiptStatus } from '@/types/domain'

const batchMeta: Record<BatchStatus, { label: string; color: string }> = {
  submitted: { label: '已送审', color: 'processing' },
  pending: { label: '待核', color: 'warning' },
  invalidated: { label: '待重算', color: 'orange' },
  returned: { label: '已退回', color: 'error' },
  released: { label: '已放行', color: 'success' },
  blocked: { label: '阻断·补不全', color: 'default' },
}

const receiptMeta: Record<ReceiptStatus, { label: string; color: string }> = {
  received: { label: '未核验', color: 'warning' },
  verified: { label: '已核验', color: 'success' },
  mismatch: { label: '版本不符', color: 'error' },
  invalidated: { label: '已失效', color: 'default' },
}

export function BatchStatusTag({ status }: { status: BatchStatus }) {
  const meta = batchMeta[status]
  return <Tag color={meta.color}>{meta.label}</Tag>
}

export function ReceiptStatusTag({ status }: { status: ReceiptStatus }) {
  const meta = receiptMeta[status]
  return <Tag color={meta.color}>{meta.label}</Tag>
}
