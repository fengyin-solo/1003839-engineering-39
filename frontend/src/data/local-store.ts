import {
  assignPending as assignPendingInDb,
  DB_KEY,
  getCachedInit,
  initializeStorage,
  persistModules,
  readInitLog,
  INIT_LOG_KEY,
  type InitReport,
  type PendingRecord,
} from './init'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// 读取前先走可重复执行的初始化流水线（见 ./init），保证本地开发、构建预览、
// 部署环境与已有本地存储都用同一份兼容规则，运营概览与各业务模块口径同源。
export { DB_KEY, INIT_LOG_KEY, readInitLog }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function database() {
  return getCachedInit() ?? initializeStorage()
}

/** 应用启动时调用一次；重复调用幂等，不会增加重复记录。 */
export function initData(): InitReport {
  return initializeStorage().report
}

export function lastInitReport(): InitReport {
  return database().report
}

export function allRows(): Record<string, EntryRow[]> {
  return database().db.modules
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function listPending(): PendingRecord[] {
  return clone(database().db.pending)
}

export function saveRows(key: string, rows: EntryRow[]): EntryRow[] {
  persistModules(key, rows)
  return rows
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  persistModules(key, rows)
  return rows
}

export function assignPending(ledgerNo: string, moduleKey: string): string {
  const { db } = database()
  return assignPendingInDb(db, ledgerNo, moduleKey).message
}

export function storageKey(): string {
  return DB_KEY
}
