import { ENTRIES_KEY, UNASSIGNED_BUCKET, defaultAdapter, readMigrationLog, runBootstrap } from './bootstrap'
import type { BootstrapReport } from './bootstrap'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// 首次读写前先跑一遍初始化/迁移（幂等），保证旧版存储也按同一份规则收敛。
// 读写都走与 bootstrap 同一个存储适配器，任何环境下规则一致。
const STORAGE_KEY = ENTRIES_KEY

let initialized = false

function ensureInitialized(): void {
  if (initialized) {
    return
  }
  initialized = true
  runBootstrap()
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  ensureInitialized()
  const fallback = clone(SEED_ROWS)
  const adapter = defaultAdapter()
  const raw = adapter.getItem(STORAGE_KEY)
  if (!raw) {
    adapter.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    adapter.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

// 其他标签页写入（包括迁移）后，本页缓存作废，下次读取拿到最新状态。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === STORAGE_KEY) {
      cache = null
    }
  })
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/** 无法归属、留待人工处理的历史记录（单独成桶，不计入任何模块存量）。 */
export function listUnassigned(): EntryRow[] {
  return listRows(UNASSIGNED_BUCKET)
}

/** 历次初始化/迁移日志：内容确定，可拿来复现每一次归属决策。 */
export function bootstrapReports(): BootstrapReport[] {
  ensureInitialized()
  return readMigrationLog()
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  defaultAdapter().setItem(STORAGE_KEY, JSON.stringify(next))
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
