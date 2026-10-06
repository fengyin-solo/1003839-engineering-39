import { SEED_LEGACY_OVERVIEW, SEED_ROWS } from './seed'
import type { EntryRow, LegacyOverviewRow } from './types'

// 本地数据初始化与迁移：版本化、幂等、原子。
// 同一份规则跑在本地开发、构建预览、部署环境（纯前端，启动时执行），
// 也兼容已有本地存储（旧版没有 meta 或残留 overview 桶都会走迁移）。
//
// 存储布局（三个 key）：
//   entries  业务数据：模块桶 + 待人工桶（overview_unassigned）
//   meta     结构版本：{ schemaVersion }
//   log      迁移日志：每次真实迁移/失败追加一条，内容确定、可复现
export const ENTRIES_KEY = 'field-archaeology-digital:entries'
export const META_KEY = 'field-archaeology-digital:meta'
export const MIGRATION_LOG_KEY = 'field-archaeology-digital:migration-log'

/** 旧版总览登记所在的桶：只有登记总量、没有业务模块归属。 */
export const LEGACY_BUCKET = 'overview'
/** 无法归属的历史记录单独留待人工处理，不进任何模块桶。 */
export const UNASSIGNED_BUCKET = 'overview_unassigned'

export const SCHEMA_VERSION = 2

export type StorageAdapter = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type BootstrapDecision = {
  登记编号: string
  rule: string
  target: string
  detail: string
}

export type BootstrapReport = {
  ok: boolean
  changed: boolean
  migration: string
  schemaVersion: number
  source: string
  /** 输入状态指纹：同样的输入必然得到同样的指纹，日志可复现。 */
  inputFingerprint: string
  outputFingerprint: string
  decisions: BootstrapDecision[]
  summary: {
    legacy: number
    backfilled: number
    manual: number
    skipped: number
    moduleTotal: number
    unassignedTotal: number
    grandTotal: number
  }
  error?: string
}

type Snapshot = {
  entriesRaw: string | null
  metaRaw: string | null
  logRaw: string | null
}

type Plan = {
  changed: boolean
  nextEntries: Record<string, EntryRow[]>
  nextMeta: { schemaVersion: number }
  report: BootstrapReport
}

// ---------------------------------------------------------------------------
// 存储适配：默认用 localStorage；非浏览器环境（如校验脚本）退回内存实现。
// ---------------------------------------------------------------------------

function createMemoryAdapter(): StorageAdapter {
  const map = new Map<string, string>()
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, String(value))
    },
    removeItem: (key) => {
      map.delete(key)
    },
  }
}

let memoryAdapter: StorageAdapter | null = null

export function defaultAdapter(): StorageAdapter {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage
  }
  if (memoryAdapter === null) {
    memoryAdapter = createMemoryAdapter()
  }
  return memoryAdapter
}

// ---------------------------------------------------------------------------
// 可复现指纹：键序无关的规范化 JSON + FNV-1a，同样输入必然得到同样输出。
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`
  }
  const pairs = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
  return `{${pairs.join(',')}}`
}

export function fingerprint(value: unknown): string {
  const text = canonicalize(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// ---------------------------------------------------------------------------
// 归属规则：只按确定性地层/遗迹关联回填，无法归属的一律留待人工，不猜测覆盖。
// ---------------------------------------------------------------------------

const STRATUM_CODE = /^STRA-\d+$/
const FEATURE_CODE = /^FEAT-\d+$/

type Attribution =
  | { kind: 'backfill'; target: 'stratum' | 'feature'; rule: string; detail: string; keyField: string; keyValue: string }
  | { kind: 'manual'; rule: string; detail: string }

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function attributeRecord(record: LegacyOverviewRow, taken: { stratum: Set<string>; feature: Set<string> }): Attribution {
  const stratumField = textOf(record['地层编号']) || textOf(record['所属地层'])
  const featureField = textOf(record['遗迹编号']) || textOf(record['所属遗迹'])
  const linked = textOf(record['关联编号'])
  const stratumSignal = stratumField || (STRATUM_CODE.test(linked) ? linked : '')
  const featureSignal = featureField || (FEATURE_CODE.test(linked) ? linked : '')

  if (stratumSignal && featureSignal) {
    return { kind: 'manual', rule: '关联冲突', detail: `同时指向地层 ${stratumSignal} 与遗迹 ${featureSignal}，不猜测` }
  }
  if (stratumSignal) {
    if (taken.stratum.has(stratumSignal)) {
      return { kind: 'manual', rule: '编号已存在', detail: `地层记录已存在 ${stratumSignal}，不覆盖` }
    }
    return { kind: 'backfill', target: 'stratum', rule: '地层关联', detail: stratumSignal, keyField: '地层编号', keyValue: stratumSignal }
  }
  if (featureSignal) {
    if (taken.feature.has(featureSignal)) {
      return { kind: 'manual', rule: '编号已存在', detail: `遗迹单位已存在 ${featureSignal}，不覆盖` }
    }
    return { kind: 'backfill', target: 'feature', rule: '遗迹关联', detail: featureSignal, keyField: '遗迹编号', keyValue: featureSignal }
  }
  return {
    kind: 'manual',
    rule: '无关联',
    detail: linked ? `关联编号 ${linked} 不符合地层/遗迹编号规则` : '缺少地层或遗迹关联',
  }
}

/** 回填行不允许覆盖的保留字段。 */
const RESERVED_FIELDS = new Set(['id', 'status', 'pending', 'abnormal', '来源', '来源登记编号'])

function copyLegacyFields(record: LegacyOverviewRow): Record<string, string | number> {
  const copied: Record<string, string | number> = {}
  for (const [field, value] of Object.entries(record)) {
    if (RESERVED_FIELDS.has(field) || value === undefined) {
      continue
    }
    if (typeof value === 'string' || typeof value === 'number') {
      copied[field] = value
    }
  }
  return copied
}

// ---------------------------------------------------------------------------
// 迁移计划：纯函数，从当前快照算出下一个状态；不碰存储，失败前没有任何写入。
// ---------------------------------------------------------------------------

function parseEntries(raw: string | null): Record<string, EntryRow[]> | null {
  if (raw === null) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, EntryRow[]>
  } catch {
    return null
  }
}

function numericId(row: EntryRow): number {
  const id = Number(row.id)
  return Number.isFinite(id) ? id : 0
}

function planInitialization(snapshot: Snapshot): Plan {
  const decisions: BootstrapDecision[] = []
  const parsedMeta = parseEntries(snapshot.metaRaw) as unknown as { schemaVersion?: number } | null
  const fromVersion = typeof parsedMeta?.schemaVersion === 'number' ? parsedMeta.schemaVersion : snapshot.entriesRaw === null ? 0 : 1

  let source: string
  let current: Record<string, EntryRow[]>
  let legacy: LegacyOverviewRow[]
  const stored = parseEntries(snapshot.entriesRaw)
  if (stored === null) {
    // 全新环境，或旧数据损坏：都按同一份示例数据重建，规则一致。
    current = clone(SEED_ROWS)
    legacy = clone(SEED_LEGACY_OVERVIEW)
    source = snapshot.entriesRaw === null ? '全新初始化（内置示例数据）' : '本地数据损坏，按示例数据重建'
    if (snapshot.entriesRaw !== null) {
      decisions.push({ 登记编号: '-', rule: '数据修复', target: '-', detail: '本地存储无法解析，按示例数据重建' })
    }
  } else {
    // 已有本地存储：缺失的模块桶用示例数据补齐（与读取侧的兼容规则一致），其余原样保留。
    current = { ...clone(SEED_ROWS), ...stored }
    legacy = Array.isArray(stored[LEGACY_BUCKET]) ? (stored[LEGACY_BUCKET] as unknown as LegacyOverviewRow[]) : []
    source = `已有本地存储（结构版本 v${fromVersion}）`
  }

  const nextEntries: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(current)) {
    if (key === LEGACY_BUCKET) {
      continue // 旧版总览桶被消费，不再保留
    }
    nextEntries[key] = Array.isArray(rows) ? [...rows] : []
  }

  const unassigned = Array.isArray(nextEntries[UNASSIGNED_BUCKET]) ? nextEntries[UNASSIGNED_BUCKET] : []
  nextEntries[UNASSIGNED_BUCKET] = unassigned

  // 幂等依据一：目标模块里已有的业务编号（地层编号/遗迹编号），冲突即转人工，不覆盖。
  const taken = {
    stratum: new Set((nextEntries['stratum'] ?? []).map((row) => textOf(row['地层编号'])).filter(Boolean)),
    feature: new Set((nextEntries['feature'] ?? []).map((row) => textOf(row['遗迹编号'])).filter(Boolean)),
  }
  // 幂等依据二：已处理过的登记编号（回填行的来源登记编号 / 待人工桶的登记编号），重复执行直接跳过。
  const processed = new Set<string>()
  for (const [key, rows] of Object.entries(nextEntries)) {
    for (const row of rows) {
      if (key === UNASSIGNED_BUCKET) {
        processed.add(textOf(row['登记编号']))
      } else {
        processed.add(textOf(row['来源登记编号']))
      }
    }
  }
  processed.delete('')

  const nextId: Record<string, number> = {}
  const allocateId = (bucket: string): number => {
    if (!(bucket in nextId)) {
      nextId[bucket] = Math.max(0, ...(nextEntries[bucket] ?? []).map(numericId)) + 1
    }
    const id = nextId[bucket]
    nextId[bucket] = id + 1
    return id
  }

  let backfilled = 0
  let manual = 0
  let skipped = 0
  const ordered = [...legacy].sort((a, b) => (a.登记编号 < b.登记编号 ? -1 : a.登记编号 > b.登记编号 ? 1 : 0))
  for (const record of ordered) {
    const code = textOf(record.登记编号)
    if (code && processed.has(code)) {
      skipped += 1
      decisions.push({ 登记编号: code, rule: '已处理过', target: '-', detail: '重复执行不重复回填' })
      continue
    }
    const attribution = attributeRecord(record, taken)
    if (attribution.kind === 'backfill') {
      const bucket = nextEntries[attribution.target] ?? []
      nextEntries[attribution.target] = bucket
      const row: EntryRow = {
        id: allocateId(attribution.target),
        status: '待补录',
        pending: true,
        abnormal: false,
        ...copyLegacyFields(record),
        [attribution.keyField]: attribution.keyValue,
        来源: '总览初始化回填',
        来源登记编号: code,
      }
      bucket.push(row)
      taken[attribution.target].add(attribution.keyValue)
      backfilled += 1
      decisions.push({ 登记编号: code, rule: attribution.rule, target: attribution.target, detail: attribution.detail })
    } else {
      const row: EntryRow = {
        id: allocateId(UNASSIGNED_BUCKET),
        status: '待人工处理',
        pending: true,
        abnormal: false,
        ...copyLegacyFields(record),
        未归属原因: `${attribution.rule}：${attribution.detail}`,
      }
      unassigned.push(row)
      manual += 1
      decisions.push({ 登记编号: code, rule: attribution.rule, target: UNASSIGNED_BUCKET, detail: attribution.detail })
    }
    if (code) {
      processed.add(code)
    }
  }

  const moduleTotal = Object.entries(nextEntries)
    .filter(([key]) => key !== UNASSIGNED_BUCKET)
    .reduce((sum, [, rows]) => sum + rows.length, 0)
  const summary = {
    legacy: legacy.length,
    backfilled,
    manual,
    skipped,
    moduleTotal,
    unassignedTotal: unassigned.length,
    grandTotal: moduleTotal + unassigned.length,
  }

  const changed =
    fromVersion !== SCHEMA_VERSION ||
    legacy.length > 0 ||
    snapshot.entriesRaw === null ||
    stored === null ||
    LEGACY_BUCKET in current

  const report: BootstrapReport = {
    ok: true,
    changed,
    migration: changed ? `v${fromVersion} -> v${SCHEMA_VERSION} 归属回填` : `v${SCHEMA_VERSION} 无需迁移`,
    schemaVersion: SCHEMA_VERSION,
    source,
    inputFingerprint: fingerprint({ entries: snapshot.entriesRaw, meta: snapshot.metaRaw }),
    outputFingerprint: fingerprint(nextEntries),
    decisions,
    summary,
  }
  return { changed, nextEntries, nextMeta: { schemaVersion: SCHEMA_VERSION }, report }
}

// ---------------------------------------------------------------------------
// 写入前校验：任何不一致都抛错，整批不落盘。
// ---------------------------------------------------------------------------

function validatePlan(snapshot: Snapshot, plan: Plan): void {
  const before = parseEntries(snapshot.entriesRaw) ?? {}
  const beforeBuckets = Object.entries(before).filter(([key]) => key !== LEGACY_BUCKET)

  // 1. 既有记录一行不少、一行不改（追加式回填，不覆盖）。
  for (const [key, rows] of beforeBuckets) {
    const nextRows = plan.nextEntries[key] ?? []
    const list = Array.isArray(rows) ? rows : []
    if (nextRows.length < list.length) {
      throw new Error(`桶 ${key} 记录数变少（${list.length} -> ${nextRows.length}）`)
    }
    if (canonicalize(nextRows.slice(0, list.length)) !== canonicalize(list)) {
      throw new Error(`桶 ${key} 的既有记录被改动`)
    }
  }

  // 2. 每条历史记录都有且仅有一个处理决定。
  const handled = plan.report.summary.backfilled + plan.report.summary.manual + plan.report.summary.skipped
  if (handled !== plan.report.summary.legacy) {
    throw new Error(`历史记录处理不完整：${handled} / ${plan.report.summary.legacy}`)
  }

  // 3. 同一桶内不允许重复的来源登记编号；待人工桶内不允许重复的登记编号。
  for (const [key, rows] of Object.entries(plan.nextEntries)) {
    const seen = new Set<string>()
    for (const row of rows) {
      const marker = key === UNASSIGNED_BUCKET ? textOf(row['登记编号']) : textOf(row['来源登记编号'])
      if (!marker) {
        continue
      }
      if (seen.has(marker)) {
        throw new Error(`桶 ${key} 出现重复登记编号 ${marker}`)
      }
      seen.add(marker)
    }
  }

  // 4. 回填行必须落在声明的归属字段上。
  for (const target of ['stratum', 'feature'] as const) {
    const keyField = target === 'stratum' ? '地层编号' : '遗迹编号'
    for (const row of plan.nextEntries[target] ?? []) {
      if (row['来源'] === '总览初始化回填' && !textOf(row[keyField])) {
        throw new Error(`回填行缺少${keyField}`)
      }
    }
  }

  // 5. 总量对账：登记总量 = 模块存量合计 + 待人工处理。
  const moduleTotal = Object.entries(plan.nextEntries)
    .filter(([key]) => key !== UNASSIGNED_BUCKET)
    .reduce((sum, [, rows]) => sum + rows.length, 0)
  const unassignedTotal = plan.nextEntries[UNASSIGNED_BUCKET]?.length ?? 0
  if (moduleTotal !== plan.report.summary.moduleTotal || unassignedTotal !== plan.report.summary.unassignedTotal) {
    throw new Error('总量对账失败：模块存量或待人工数与计划不一致')
  }
}

// ---------------------------------------------------------------------------
// 快照读写与整批回退
// ---------------------------------------------------------------------------

function readSnapshot(adapter: StorageAdapter): Snapshot {
  return {
    entriesRaw: adapter.getItem(ENTRIES_KEY),
    metaRaw: adapter.getItem(META_KEY),
    logRaw: adapter.getItem(MIGRATION_LOG_KEY),
  }
}

function restoreKey(adapter: StorageAdapter, key: string, value: string | null): void {
  if (value === null) {
    adapter.removeItem(key)
  } else {
    adapter.setItem(key, value)
  }
}

function restoreSnapshot(adapter: StorageAdapter, snapshot: Snapshot): void {
  restoreKey(adapter, ENTRIES_KEY, snapshot.entriesRaw)
  restoreKey(adapter, META_KEY, snapshot.metaRaw)
  restoreKey(adapter, MIGRATION_LOG_KEY, snapshot.logRaw)
}

export function readMigrationLog(adapter: StorageAdapter = defaultAdapter()): BootstrapReport[] {
  try {
    const parsed = JSON.parse(adapter.getItem(MIGRATION_LOG_KEY) ?? '[]') as unknown
    return Array.isArray(parsed) ? (parsed as BootstrapReport[]) : []
  } catch {
    return []
  }
}

function persistReport(adapter: StorageAdapter, report: BootstrapReport): void {
  const log = readMigrationLog(adapter)
  log.push(report)
  adapter.setItem(MIGRATION_LOG_KEY, JSON.stringify(log))
}

function echoReport(report: BootstrapReport): void {
  const tag = '[bootstrap]'
  if (!report.ok) {
    console.error(`${tag} ${report.migration} 失败：${report.error}；已整批回退，输入指纹 ${report.inputFingerprint}`)
    return
  }
  if (!report.changed) {
    console.info(`${tag} ${report.migration}，登记总量 ${report.summary.grandTotal}（指纹 ${report.outputFingerprint}）`)
    return
  }
  const { summary } = report
  console.info(`${tag} ${report.migration}（${report.source}）：历史记录 ${summary.legacy} 条，回填 ${summary.backfilled}，待人工 ${summary.manual}，跳过 ${summary.skipped}`)
  for (const decision of report.decisions) {
    console.info(`${tag}   ${decision.登记编号} -> ${decision.target}（${decision.rule}：${decision.detail}）`)
  }
  console.info(`${tag} 校验通过：登记总量 ${summary.grandTotal} = 模块存量 ${summary.moduleTotal} + 待人工 ${summary.unassignedTotal}（指纹 ${report.outputFingerprint}）`)
}

function failureReport(snapshot: Snapshot, error: unknown, plan?: Plan): BootstrapReport {
  return {
    ok: false,
    changed: false,
    migration: plan?.report.migration ?? '初始化',
    schemaVersion: SCHEMA_VERSION,
    source: plan?.report.source ?? '未知',
    inputFingerprint: fingerprint({ entries: snapshot.entriesRaw, meta: snapshot.metaRaw }),
    outputFingerprint: fingerprint({ entries: snapshot.entriesRaw, meta: snapshot.metaRaw }),
    decisions: plan?.report.decisions ?? [],
    summary: plan?.report.summary ?? { legacy: 0, backfilled: 0, manual: 0, skipped: 0, moduleTotal: 0, unassignedTotal: 0, grandTotal: 0 },
    error: error instanceof Error ? error.message : String(error),
  }
}

/**
 * 启动初始化：幂等（重复执行不增加重复记录）、原子（失败整批回退）、
 * 可复现（日志只含确定性内容，同样输入必然得到同样日志）。
 * 本地开发、构建预览、部署环境与已有本地存储都走这同一份规则。
 */
export function runBootstrap(adapter: StorageAdapter = defaultAdapter()): BootstrapReport {
  const snapshot = readSnapshot(adapter)
  let plan: Plan
  try {
    plan = planInitialization(snapshot)
    validatePlan(snapshot, plan)
  } catch (error) {
    const report = failureReport(snapshot, error)
    try {
      persistReport(adapter, report)
    } catch {
      // 日志写不进去不遮罩原始失败
    }
    echoReport(report)
    return report
  }

  if (plan.changed) {
    try {
      adapter.setItem(ENTRIES_KEY, JSON.stringify(plan.nextEntries))
      adapter.setItem(META_KEY, JSON.stringify(plan.nextMeta))
      persistReport(adapter, plan.report)
    } catch (error) {
      try {
        restoreSnapshot(adapter, snapshot)
      } catch (restoreError) {
        console.error('[bootstrap] 回退失败：', restoreError)
      }
      const report = failureReport(snapshot, error, plan)
      try {
        persistReport(adapter, report)
      } catch {
        // 日志写不进去不遮罩原始失败
      }
      echoReport(report)
      return report
    }
  }

  echoReport(plan.report)
  return plan.report
}
