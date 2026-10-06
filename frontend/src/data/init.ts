/**
 * 可重复执行的示例数据初始化（本地开发 / 构建预览 / 部署环境 / 已有本地存储共用同一份规则）。
 *
 * 设计约束：
 * - 幂等：历史总账流水号处理一次即记入 consumed，重复启动不增加任何重复记录。
 * - 不猜测：缺归属的历史记录只按「关联编号在本地地层/遗迹记录中存在」回填；
 *   编号不存在、缺少线索或疑似重复的，一律进入待归属队列由人工处理，绝不覆盖已有数据。
 * - 单一口径：运营概览不再保存独立快照，一律从各业务模块的本地记录实时汇总。
 * - 整批事务：先算好全部结果再落盘；任一步落盘失败就按快照整体回退，存储保持初始化前状态。
 * - 可复现日志：每次运行记录输入指纹、步骤、计数与错误，相同输入得到相同 runId。
 */
import { LEDGER_RECORDS, type LedgerRecord } from './ledger'
import { MODULE_BY_KEY, MODULES } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

export const INIT_VERSION = 2

export const DB_KEY = 'field-archaeology-digital:entries'
/** 旧版运营概览可能留下的独立快照（只含登记总量，与本地模块口径脱节） */
export const LEGACY_OVERVIEW_KEY = 'field-archaeology-digital:overview'
export const INIT_LOG_KEY = 'field-archaeology-digital:init-log'

const MANAGED_KEYS = [DB_KEY, LEGACY_OVERVIEW_KEY]
const LOG_LIMIT = 20

/** 允许自动回填的模块及其编号字段：只按地层或遗迹关联，不扩大猜测范围 */
const ATTRIBUTABLE: Record<string, { prefix: string; codeField: string }> = {
  stratum: { prefix: 'STRA-', codeField: '地层编号' },
  feature: { prefix: 'FEAT-', codeField: '遗迹编号' },
}

export type PendingReason =
  | 'missing-ref'
  | 'code-not-found'
  | 'out-of-scope'
  | 'duplicate'

export type PendingRecord = {
  ledgerNo: string
  title: string
  registeredAt: string
  refCode: string
  note: string
  reason: PendingReason
  reasonText: string
  /** 疑似重复时，已先行回填的总账流水号 */
  duplicateOf?: string
  source: 'legacy-overview' | 'bundled-ledger'
}

export type Database = {
  version: number
  modules: Record<string, EntryRow[]>
  pending: PendingRecord[]
  /** 已处理过的总账流水号（含已回填与已挂起），保证重复执行不二次处理 */
  consumed: string[]
}

export type InitStep = { name: string; detail: string }

export type InitReport = {
  runId: string
  at: string
  inputHash: string
  status: 'fresh' | 'migrated' | 'unchanged' | 'failed'
  mode: 'localStorage' | 'memory'
  version: number
  steps: InitStep[]
  /** 本次回填到业务模块的记录数 */
  attributed: number
  /** 待人工处理队列总数 */
  pendingTotal: number
  /** 本次因疑似重复挂起的记录数 */
  duplicates: number
  /** 回填后各业务模块合计（运营概览登记总量口径） */
  modulesTotal: number
  /** 旧概览快照声称的登记总量（若存在），用于核对口径差异 */
  legacyOverviewTotal?: number
  error?: string
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 内存存储：SSR、隐私模式或本地存储损坏时的兜底，行为与 localStorage 一致。 */
export function createMemoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

/**
 * 取浏览器本地存储：访问本身就可能抛错（SSR / 部分浏览器隐私模式），
 * 这类环境统一切到内存兜底，应用仍可完整运行，只是不跨刷新持久化。
 */
function browserStorage(): StorageLike | undefined {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      // 真正读写一次，确认不是只在访问时可用、调用即抛的受限存储
      const probe = '__field-archaeology-probe__'
      window.localStorage.setItem(probe, '1')
      window.localStorage.removeItem(probe)
      return window.localStorage
    }
  } catch {
    /* 落到内存兜底 */
  }
  return undefined
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** FNV-1a 32 位指纹：无外部依赖，相同输入恒定得到相同指纹，便于复现日志。 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function emptyDatabase(): Database {
  return { version: INIT_VERSION, modules: clone(SEED_ROWS), pending: [], consumed: [] }
}

function isDatabase(value: unknown): value is Database {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return typeof candidate.version === 'number' && typeof candidate.modules === 'object'
}

function isLegacyRawModules(value: unknown): value is Record<string, EntryRow[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  return Object.keys(value).some((key) => MODULE_BY_KEY.has(key))
}

/** 读取旧版运营概览快照；只认本系统历史上写出过的形状，不认的不动它。 */
function readLegacyOverview(
  raw: string | null,
): { total?: number; records?: LedgerRecord[] } | null {
  if (!raw) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const obj = parsed as Record<string, unknown>
  if (Array.isArray(obj.cards)) {
    const card = obj.cards.find(
      (item) => !!item && typeof item === 'object' && (item as { label?: string }).label === '登记总量',
    )
    const total = card ? Number((card as { value?: unknown }).value) : NaN
    return { total: Number.isFinite(total) ? total : undefined }
  }
  if (typeof obj.total === 'number' && Array.isArray(obj.records)) {
    return { total: obj.total, records: obj.records as LedgerRecord[] }
  }
  return null
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

/** 整批落盘：先拍快照，任一写入失败就把所有受管控键恢复到初始化前状态。 */
function commitAll(
  storage: StorageLike,
  changes: { key: string; value: string | null }[],
): void {
  const snapshot = MANAGED_KEYS.map((key) => ({ key, before: storage.getItem(key) }))
  try {
    for (const { key, value } of changes) {
      if (value === null) {
        storage.removeItem(key)
      } else {
        storage.setItem(key, value)
      }
    }
  } catch (error) {
    for (const { key, before } of snapshot) {
      try {
        if (before === null) {
          storage.removeItem(key)
        } else {
          storage.setItem(key, before)
        }
      } catch {
        /* 回退本身失败时不再抛出，避免掩盖原始错误 */
      }
    }
    throw error
  }
}

function validateDatabase(db: Database): void {
  if (db.version !== INIT_VERSION) {
    throw new Error(`数据版本不是 ${INIT_VERSION}，拒绝写入`)
  }
  for (const key of Object.keys(db.modules)) {
    if (!MODULE_BY_KEY.has(key)) {
      throw new Error(`出现未登记的业务模块 ${key}，拒绝写入`)
    }
    const rows = db.modules[key]
    if (!Array.isArray(rows)) {
      throw new Error(`模块 ${key} 的记录不是数组，拒绝写入`)
    }
    const ids = new Set<number>()
    for (const row of rows) {
      const id = Number(row.id)
      if (!Number.isFinite(id)) {
        throw new Error(`模块 ${key} 存在非数字编号，拒绝写入`)
      }
      if (ids.has(id)) {
        throw new Error(`模块 ${key} 编号 ${id} 重复，拒绝写入`)
      }
      ids.add(id)
    }
  }
  for (const item of db.pending) {
    if (!item.ledgerNo || !item.reasonText) {
      throw new Error('待归属记录缺少流水号或原因说明，拒绝写入')
    }
  }
}

type Classified =
  | { kind: 'attribute'; moduleKey: string; refCode: string; matched: EntryRow }
  | { kind: 'pending'; reason: PendingReason; reasonText: string; duplicateOf?: string }

function classifyLedger(
  record: LedgerRecord,
  db: Database,
  codeOwners: Map<string, { moduleKey: string }>,
): Classified {
  const refCode = record.refCode.trim()
  if (refCode === '') {
    return { kind: 'pending', reason: 'missing-ref', reasonText: '缺少地层或遗迹关联线索，无法自动归属' }
  }
  const owner = [...Object.entries(ATTRIBUTABLE)].find(([, rule]) =>
    refCode.startsWith(rule.prefix),
  )
  if (!owner) {
    return {
      kind: 'pending',
      reason: 'out-of-scope',
      reasonText: `关联编号 ${refCode} 不属于地层(STRA-)或遗迹(FEAT-)范围，不能猜测归属`,
    }
  }
  const [moduleKey] = owner
  const ownerKey = `${moduleKey}:${refCode}`
  const existing = codeOwners.get(ownerKey)
  if (!existing) {
    const label = moduleKey === 'stratum' ? '地层记录' : '遗迹单位'
    return {
      kind: 'pending',
      reason: 'code-not-found',
      reasonText: `关联编号 ${refCode} 在本地${label}中不存在，无法回填`,
    }
  }
  const duplicateOf = db.consumed.find((ledgerNo) =>
    db.modules[moduleKey].some(
      (row) => row['_总账流水号'] === ledgerNo && String(row[ATTRIBUTABLE[moduleKey].codeField]) === refCode
    ),
  )
  if (duplicateOf) {
    return {
      kind: 'pending',
      reason: 'duplicate',
      reasonText: `与 ${duplicateOf} 指向同一 ${refCode}，疑似重复登记，需人工确认`,
      duplicateOf,
    }
  }
  const matched = db.modules[moduleKey].find(
    (row) => String(row[ATTRIBUTABLE[moduleKey].codeField]) === refCode,
  ) as EntryRow
  return { kind: 'attribute', moduleKey, refCode, matched }
}

function buildBackfillRow(
  moduleKey: string,
  record: LedgerRecord,
  matched: EntryRow,
  id: number,
): EntryRow {
  const meta = MODULE_BY_KEY.get(moduleKey) as (typeof MODULES)[number]
  const firstStatus = meta.statuses[0]
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const { codeField } = ATTRIBUTABLE[moduleKey]
  return {
    id,
    status: firstStatus,
    pending: firstStatus !== lastStatus,
    abnormal: false,
    [codeField]: record.refCode.trim(),
    所属探方: String(matched['所属探方'] ?? ''),
    _来源: '历史登记总账自动回填',
    _总账流水号: record.ledgerNo,
    _总账登记日期: record.registeredAt,
    _总账标题: record.title,
    _总账备注: record.note,
  }
}

export type InitOutcome = { db: Database; report: InitReport }

let cached: { db: Database; report: InitReport } | null = null

export function getCachedInit(): InitOutcome | null {
  return cached
}

/**
 * 业务侧更新某个模块后的统一落盘口：先校验整批结构，再经同一事务通道写入并刷新缓存。
 * 不碰待归属队列与已处理总账，保证运营概览与模块页面始终读同一份数据。
 */
export function persistModules(key: string, rows: EntryRow[], storage?: StorageLike): Database {
  const current = cached ?? initializeStorage(storage)
  const next: Database = {
    ...clone(current.db),
    modules: { ...current.db.modules, [key]: clone(rows) },
  }
  validateDatabase(next)
  const adapter: StorageLike =
    storage ??
    (browserStorage() ?? createMemoryStorage())
  commitAll(adapter, [{ key: DB_KEY, value: JSON.stringify(next) }])
  cached = { db: next, report: current.report }
  return next
}

/**
 * 执行一次初始化。可重复调用：已有版本化结构且无新总账时不做任何业务数据写入。
 * @param storage  存储适配器，默认取 window.localStorage；测试可注入内存存储
 * @param now      运行时间，默认当前时间；测试可注入保证日志时间可复现
 */
export function initializeStorage(storage?: StorageLike, now: Date = new Date()): InitOutcome {
  const steps: InitStep[] = []
  const defaultStorage: StorageLike | undefined = browserStorage()
  const mode: InitReport['mode'] =
    storage !== undefined ? inferMode(storage) : defaultStorage ? 'localStorage' : 'memory'
  const adapter: StorageLike = storage ?? defaultStorage ?? createMemoryStorage()

  const snapshot = Object.fromEntries(
    MANAGED_KEYS.map((key) => [key, adapter.getItem(key)]),
  )
  const inputHash = fnv1a(JSON.stringify(snapshot))
  const runId = fnv1a(`${INIT_VERSION}|${inputHash}`)

  const fail = (error: unknown, db: Database): InitOutcome => {
    const message = error instanceof Error ? error.message : String(error)
    const report: InitReport = {
      runId,
      at: now.toISOString(),
      inputHash,
      status: 'failed',
      mode,
      version: INIT_VERSION,
      steps,
      attributed: 0,
      pendingTotal: db.pending.length,
      duplicates: 0,
      modulesTotal: countModules(db),
      error: message,
    }
    persistLog(adapter, report)
    cached = { db, report }
    console.error(`[init] 初始化失败已整批回退 runId=${runId} inputHash=${inputHash}`, message)
    return { db, report }
  }

  // 1. 读取并识别已有数据：版本化结构 / 旧版裸模块表 / 损坏
  let db: Database
  let structuralUpgrade = false
  const rawEntries = adapter.getItem(DB_KEY)
  if (rawEntries === null) {
    db = emptyDatabase()
    steps.push({ name: 'seed', detail: '首次初始化：写入各业务模块示例数据' })
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(rawEntries)
    } catch (error) {
      steps.push({ name: 'parse', detail: '本地模块数据无法解析，保持原存储不动并切换到内存兜底' })
      return fail(error, emptyDatabase())
    }
    if (isDatabase(parsed)) {
      db = {
        version: INIT_VERSION,
        modules: { ...clone(SEED_ROWS), ...clone(parsed.modules ?? {}) },
        pending: Array.isArray(parsed.pending) ? clone(parsed.pending) : [],
        consumed: Array.isArray(parsed.consumed) ? clone(parsed.consumed) : [],
      }
      if (parsed.version < INIT_VERSION) {
        structuralUpgrade = true
        steps.push({
          name: 'upgrade',
          detail: `旧版本 v${parsed.version} 升级到 v${INIT_VERSION}，已有记录原样保留`,
        })
      }
    } else if (isLegacyRawModules(parsed)) {
      structuralUpgrade = true
      db = {
        version: INIT_VERSION,
        // 与历史读规则一致：示例数据兜底，本地已有记录优先，绝不覆盖
        modules: { ...clone(SEED_ROWS), ...clone(parsed) },
        pending: [],
        consumed: [],
      }
      steps.push({
        name: 'wrap-legacy',
        detail: '旧版裸模块表合并进版本化结构，已有业务记录原样保留',
      })
    } else {
      steps.push({ name: 'parse', detail: '本地模块数据结构无法识别，保持原存储不动并切换到内存兜底' })
      return fail(new Error('本地模块数据结构无法识别'), emptyDatabase())
    }
  }

  // 2. 取历史总账：旧概览快照自带的记录优先，否则用仓库发布的同一份示例总账
  const legacyOverview = readLegacyOverview(adapter.getItem(LEGACY_OVERVIEW_KEY))
  let ledgerSource: PendingRecord['source'] = 'bundled-ledger'
  let ledger: LedgerRecord[] = LEDGER_RECORDS
  if (legacyOverview?.records?.length) {
    ledger = legacyOverview.records
    ledgerSource = 'legacy-overview'
  }

  // 3. 逐条处理缺归属的历史总账：只按地层/遗迹精确关联，不能对应就挂起
  const codeOwners = new Map<string, { moduleKey: string }>()
  for (const moduleKey of Object.keys(ATTRIBUTABLE)) {
    for (const row of db.modules[moduleKey] ?? []) {
      codeOwners.set(`${moduleKey}:${String(row[ATTRIBUTABLE[moduleKey].codeField])}`, { moduleKey })
    }
  }

  let attributed = 0
  let duplicates = 0
  let newPending = 0
  const attributedDetail: string[] = []
  const pendingDetail: string[] = []
  for (const record of ledger) {
    if (db.consumed.includes(record.ledgerNo)) {
      continue
    }
    const result = classifyLedger(record, db, codeOwners)
    db.consumed.push(record.ledgerNo)
    if (result.kind === 'attribute') {
      const id = nextId(db.modules[result.moduleKey])
      const row = buildBackfillRow(result.moduleKey, record, result.matched, id)
      db.modules[result.moduleKey].push(row)
      codeOwners.set(`${result.moduleKey}:${result.refCode}`, { moduleKey: result.moduleKey })
      attributed += 1
      attributedDetail.push(`${record.ledgerNo}→${result.moduleKey}:${result.refCode}(#${id})`)
    } else {
      if (result.reason === 'duplicate') {
        duplicates += 1
      }
      newPending += 1
      db.pending.push({
        ledgerNo: record.ledgerNo,
        title: record.title,
        registeredAt: record.registeredAt,
        refCode: record.refCode,
        note: record.note,
        reason: result.reason,
        reasonText: result.reasonText,
        duplicateOf: result.duplicateOf,
        source: ledgerSource,
      })
      pendingDetail.push(`${record.ledgerNo}(${result.reason})`)
    }
  }
  if (attributedDetail.length) {
    steps.push({ name: 'attribute', detail: `按地层/遗迹关联回填 ${attributed} 条：${attributedDetail.join('，')}` })
  }
  if (pendingDetail.length) {
    steps.push({ name: 'pending', detail: `本次 ${newPending} 条无法归属、留待人工处理：${pendingDetail.join('，')}` })
  }

  // 旧概览快照在本批次总账处理完后再核对总量，日志数字与最终口径一致
  if (legacyOverview?.total !== undefined) {
    const derivedTotal = countModules(db)
    steps.push({
      name: 'reconcile-overview',
      detail:
        `旧运营概览登记总量=${legacyOverview.total}，本地各模块合计=${derivedTotal}，` +
        `口径差异=${legacyOverview.total - derivedTotal}；概览快照停用，改为从本地记录实时汇总`,
    })
  }

  // 4. 先校验整批结果，再一次性落盘；旧概览快照随同一事务删除
  try {
    validateDatabase(db)
  } catch (error) {
    return fail(error, db)
  }

  const ledgerChanged = attributed > 0 || newPending > 0
  // 仅当本次运行确实改变了数据（首次播种 / 结构升级 / 处理了新总账 / 删除旧快照）才写存储
  const changed = structuralUpgrade || ledgerChanged || !!legacyOverview
  const status: InitReport['status'] =
    rawEntries === null && !legacyOverview ? 'fresh' : changed ? 'migrated' : 'unchanged'

  const changes: { key: string; value: string | null }[] = []
  if (changed) {
    changes.push({ key: DB_KEY, value: JSON.stringify(db) })
  }
  if (legacyOverview) {
    changes.push({ key: LEGACY_OVERVIEW_KEY, value: null })
  }
  if (changes.length > 0) {
    try {
      commitAll(adapter, changes)
    } catch (error) {
      steps.push({ name: 'rollback', detail: '落盘失败，已按快照整批回退，存储恢复为初始化前状态' })
      return fail(error, db)
    }
  } else {
    steps.push({ name: 'idempotent', detail: '版本化结构已是最新且无未处理总账，未写入任何业务记录' })
  }

  const report: InitReport = {
    runId,
    at: now.toISOString(),
    inputHash,
    status,
    mode,
    version: INIT_VERSION,
    steps,
    attributed,
    pendingTotal: db.pending.length,
    duplicates,
    modulesTotal: countModules(db),
    legacyOverviewTotal: legacyOverview?.total,
  }
  persistLog(adapter, report)
  cached = { db, report }
  console.info(
    `[init] runId=${runId} status=${status} inputHash=${inputHash} ` +
      `回填=${attributed} 待归属=${db.pending.length} 模块合计=${report.modulesTotal}`,
  )
  return { db, report }
}

function inferMode(storage: StorageLike): InitReport['mode'] {
  return browserStorage() === storage ? 'localStorage' : 'memory'
}

function countModules(db: Database): number {
  return MODULES.reduce((sum, meta) => sum + (db.modules[meta.key]?.length ?? 0), 0)
}

/** 追加初始化日志：日志失败不影响业务数据，只在控制台暴露，保证主流程永远可继续。 */
function persistLog(storage: StorageLike, report: InitReport): void {
  try {
    const raw = storage.getItem(INIT_LOG_KEY)
    const list: InitReport[] = raw ? (JSON.parse(raw) as InitReport[]) : []
    list.push(report)
    storage.setItem(INIT_LOG_KEY, JSON.stringify(list.slice(-LOG_LIMIT)))
  } catch (error) {
    console.warn('[init] 初始化日志写入失败（不影响业务数据）', error)
  }
}

export function readInitLog(storage?: StorageLike): InitReport[] {
  const adapter =
    storage ??
    (browserStorage() ?? createMemoryStorage())
  try {
    const raw = adapter.getItem(INIT_LOG_KEY)
    return raw ? (JSON.parse(raw) as InitReport[]) : []
  } catch {
    return []
  }
}

/** 人工归属：操作员明确指定模块后才移动记录，仍然不猜编号、不覆盖任何已有记录。 */
export function assignPending(
  db: Database,
  ledgerNo: string,
  moduleKey: string,
  storage?: StorageLike,
  now: Date = new Date(),
): { db: Database; report: InitReport; message: string } {
  const meta = MODULE_BY_KEY.get(moduleKey)
  if (!meta) {
    return { db, report: rerunReport(db, storage, now, '人工归属失败'), message: `没有登记名为 ${moduleKey} 的业务模块` }
  }
  const index = db.pending.findIndex((item) => item.ledgerNo === ledgerNo)
  if (index < 0) {
    return { db, report: rerunReport(db, storage, now, '人工归属失败'), message: '该待归属记录已被处理或不存在' }
  }
  const item = db.pending[index]
  const next: Database = clone(db)
  const rule = ATTRIBUTABLE[moduleKey]
  const firstStatus = meta.statuses[0]
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const row: EntryRow = {
    id: nextId(next.modules[moduleKey]),
    status: firstStatus,
    pending: firstStatus !== lastStatus,
    abnormal: false,
    _来源: '历史登记总账人工归属',
    _总账流水号: item.ledgerNo,
    _总账登记日期: item.registeredAt,
    _总账标题: item.title,
    _总账备注: item.note,
  }
  // 编号前缀与所选模块一致时原样带上；对不上的编号不强行写入业务编号字段，留给人工补录
  if (rule && item.refCode.trim().startsWith(rule.prefix)) {
    row[rule.codeField] = item.refCode.trim()
  }
  next.modules[moduleKey].push(row)
  next.pending.splice(index, 1)
  validateDatabase(next)

  const adapter: StorageLike =
    storage ??
    (browserStorage() ?? createMemoryStorage())
  try {
    commitAll(adapter, [{ key: DB_KEY, value: JSON.stringify(next) }])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const report = rerunReport(next, adapter, now, `人工归属落盘失败已回退：${message}`)
    cached = { db, report }
    return { db, report, message: `归属失败已回退：${message}` }
  }

  const report = rerunReport(next, adapter, now, `人工归属 ${ledgerNo} → ${meta.name}`)
  cached = { db: next, report }
  return { db: next, report, message: `${item.ledgerNo} 已归属到${meta.name}` }
}

function rerunReport(db: Database, storage: StorageLike | undefined, now: Date, step: string): InitReport {
  const adapter: StorageLike =
    storage ??
    (browserStorage() ?? createMemoryStorage())
  const snapshot = Object.fromEntries(MANAGED_KEYS.map((key) => [key, adapter.getItem(key)]))
  const inputHash = fnv1a(JSON.stringify(snapshot))
  const report: InitReport = {
    runId: fnv1a(`manual|${inputHash}`),
    at: now.toISOString(),
    inputHash,
    status: 'migrated',
    mode: inferMode(adapter),
    version: INIT_VERSION,
    steps: [{ name: 'manual-assign', detail: step }],
    attributed: 0,
    pendingTotal: db.pending.length,
    duplicates: 0,
    modulesTotal: countModules(db),
  }
  persistLog(adapter, report)
  return report
}

export const _internal = { fnv1a, countModules, INIT_LOG_KEY, LEGACY_OVERVIEW_KEY }
