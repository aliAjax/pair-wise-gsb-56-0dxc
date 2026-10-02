import type { WorkspaceState } from '@/types/domain'
import { createInitialState } from './mockData'

const STORAGE_KEY = 'export-control-review-v2'
const OUTBOX_KEY = 'export-control-review-outbox-v1'
const FAULT_KEY = 'export-control-review-write-fault'

// ---- 写入故障注入（模拟许可平台 / 本地存储间歇不可用） ----
// 开关持久化，保证任意调用方与模拟接口共享同一状态
let failRemaining = 0

export function setWriteFault(on: boolean) {
  if (on) window.localStorage.setItem(FAULT_KEY, '1')
  else window.localStorage.removeItem(FAULT_KEY)
}

export function isWriteFaultOn() {
  return window.localStorage.getItem(FAULT_KEY) === '1'
}

/** 接下来 n 次写入失败，之后自动恢复（演练"失败后从完整批次重试"） */
export function failNextWrites(n: number) {
  failRemaining = n
}

export function pendingFailCount() {
  return failRemaining
}

export function loadWorkspace(): WorkspaceState {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = createInitialState()
    persistRaw(initial)
    return initial
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceState>
    // 兼容旧数据：补齐对账批次字段
    return {
      packages: parsed.packages ?? [],
      files: parsed.files ?? [],
      rules: parsed.rules ?? [],
      findings: parsed.findings ?? [],
      comments: parsed.comments ?? [],
      audit: parsed.audit ?? [],
      batches: parsed.batches ?? [],
      inbox: parsed.inbox ?? [],
      pendingActions: parsed.pendingActions ?? loadOutbox(),
      licenses: parsed.licenses ?? [],
    }
  } catch {
    const initial = createInitialState()
    persistRaw(initial)
    return initial
  }
}

function persistRaw(state: WorkspaceState) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

/** 单次原子落盘；故障开启时抛出，调用方必须把动作转入 outbox（可续办） */
export function saveWorkspace(state: WorkspaceState): void {
  if (isWriteFaultOn() || failRemaining > 0) {
    if (failRemaining > 0) failRemaining -= 1
    throw new Error('写入失败：存储通道不可用（模拟故障），动作已转入待重试')
  }
  persistRaw(state)
}

// ---- 待重试动作（完整批次快照单独持久化，主库写失败也不丢） ----

export function loadOutbox() {
  try {
    const raw = window.localStorage.getItem(OUTBOX_KEY)
    return raw ? (JSON.parse(raw) as WorkspaceState['pendingActions']) : []
  } catch {
    return []
  }
}

export function saveOutbox(actions: WorkspaceState['pendingActions']) {
  window.localStorage.setItem(OUTBOX_KEY, JSON.stringify(actions))
}

export function resetWorkspace(): WorkspaceState {
  const initial = createInitialState()
  failRemaining = 0
  window.localStorage.removeItem(OUTBOX_KEY)
  window.localStorage.removeItem(FAULT_KEY)
  persistRaw(initial)
  return initial
}
