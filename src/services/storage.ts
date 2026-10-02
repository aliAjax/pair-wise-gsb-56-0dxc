import type { BatchOutboxEntry, WorkspaceState } from '@/types/domain'
import { createInitialState } from './mockData'
import { migrateWorkspace } from './reconcile'

const STORAGE_KEY = 'export-control-review-v1'
const OUTBOX_KEY = 'export-control-review-outbox-v1'
const FAIL_NEXT_KEY = 'export-control-review-fail-next-v1'

function normalizeState(raw: WorkspaceState): WorkspaceState {
  return migrateWorkspace({
    ...raw,
    batches: raw.batches ?? [],
  })
}

export function loadWorkspace(): WorkspaceState {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = migrateWorkspace(createInitialState())
    saveWorkspace(initial)
    return initial
  }
  try {
    const parsed = JSON.parse(raw) as WorkspaceState
    const normalized = normalizeState(parsed)
    // 迁移（摘要回填等）发生后立即落盘
    saveWorkspace(normalized)
    return normalized
  } catch {
    const initial = migrateWorkspace(createInitialState())
    saveWorkspace(initial)
    return initial
  }
}

export function saveWorkspace(state: WorkspaceState): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function resetWorkspace(): WorkspaceState {
  const initial = migrateWorkspace(createInitialState())
  saveWorkspace(initial)
  clearOutbox()
  return initial
}

export function loadOutbox(): BatchOutboxEntry[] {
  const raw = window.localStorage.getItem(OUTBOX_KEY)
  if (!raw) return []
  try {
    return JSON.parse(raw) as BatchOutboxEntry[]
  } catch {
    return []
  }
}

export function saveOutbox(entries: BatchOutboxEntry[]): void {
  window.localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries))
}

export function clearOutbox(): void {
  window.localStorage.removeItem(OUTBOX_KEY)
}

/** 演示用：下一次批次写入故意失败，落一条可整批重试的 outbox 记录 */
export function consumeFailNext(url: string): boolean {
  if (window.localStorage.getItem(FAIL_NEXT_KEY) !== '1') return false
  window.localStorage.removeItem(FAIL_NEXT_KEY)
  void url
  return true
}

export function armFailNext(): void {
  window.localStorage.setItem(FAIL_NEXT_KEY, '1')
}
