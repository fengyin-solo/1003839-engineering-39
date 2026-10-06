// 可重复执行的初始化校验：用 esbuild 把数据层打到临时目录后在 node 里跑场景断言。
// 场景：全新初始化 / 幂等重跑 / 强制重跑 / 旧版存储迁移 / 失败整批回退 / 日志可复现 / 总览口径一致。
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(here, '..')
const outdir = path.join(frontendRoot, 'node_modules', '.cache', 'verify-bootstrap')

await build({
  entryPoints: [
    path.join(frontendRoot, 'src/data/bootstrap.ts'),
    path.join(frontendRoot, 'src/api/local-service.ts'),
  ],
  outdir,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'neutral',
  alias: { '@': path.join(frontendRoot, 'src') },
  logLevel: 'silent',
})

const bootstrap = await import(path.join(outdir, 'data/bootstrap.js'))
const service = await import(path.join(outdir, 'api/local-service.js'))

const {
  ENTRIES_KEY,
  META_KEY,
  MIGRATION_LOG_KEY,
  UNASSIGNED_BUCKET,
  runBootstrap,
  readMigrationLog,
  fingerprint,
} = bootstrap

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`PASS ${name}`)
  } else {
    failures += 1
    console.error(`FAIL ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

function createAdapter(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map.entries()),
  }
}

function readEntries(adapter) {
  return JSON.parse(adapter.getItem(ENTRIES_KEY))
}

// --- 场景 1：全新初始化，缺归属历史记录按地层/遗迹关联回填 -------------------
{
  const adapter = createAdapter()
  const report = runBootstrap(adapter)
  const entries = readEntries(adapter)
  check('S1 全新初始化成功', report.ok && report.changed)
  check('S1 地层回填 2 条', entries.stratum.length === 5, `实际 ${entries.stratum.length}`)
  check('S1 遗迹回填 2 条', entries.feature.length === 5, `实际 ${entries.feature.length}`)
  check('S1 待人工 4 条', entries[UNASSIGNED_BUCKET].length === 4, `实际 ${entries[UNASSIGNED_BUCKET].length}`)
  check(
    'S1 登记总量对账',
    report.summary.grandTotal === 62 && report.summary.moduleTotal === 58 && report.summary.unassignedTotal === 4,
    JSON.stringify(report.summary),
  )
  const backfilled = entries.stratum.filter((row) => row['来源'] === '总览初始化回填')
  check(
    'S1 回填行落在归属字段上',
    backfilled.length === 2 && backfilled.every((row) => /^STRA-\d+$/.test(row['地层编号']) && row.status === '待补录'),
  )
  const manualCodes = entries[UNASSIGNED_BUCKET].map((row) => row['登记编号']).sort()
  check(
    'S1 无法归属的留待人工（含冲突/无关联/编号已存在）',
    JSON.stringify(manualCodes) === JSON.stringify(['OV-0005', 'OV-0006', 'OV-0007', 'OV-0008']),
    manualCodes.join(','),
  )
  check('S1 迁移日志落盘 1 条', readMigrationLog(adapter).length === 1)
}

// --- 场景 2：幂等，重复启动不增加重复记录 ------------------------------------
{
  const adapter = createAdapter()
  runBootstrap(adapter)
  const before = adapter.getItem(ENTRIES_KEY)
  const logBefore = readMigrationLog(adapter).length
  const again = runBootstrap(adapter)
  check('S2 重复执行为空转', again.ok && !again.changed)
  check('S2 数据零变化', adapter.getItem(ENTRIES_KEY) === before)
  check('S2 日志不膨胀', readMigrationLog(adapter).length === logBefore)
}

// --- 场景 3：版本标记丢失后强制重跑，靠记录级去重保持幂等 --------------------
{
  const adapter = createAdapter()
  runBootstrap(adapter)
  adapter.removeItem(META_KEY)
  const before = fingerprint(readEntries(adapter))
  const rerun = runBootstrap(adapter)
  const entries = readEntries(adapter)
  check('S3 强制重跑成功', rerun.ok)
  check('S3 不产生重复记录', fingerprint(entries) === before && entries.stratum.length === 5 && entries[UNASSIGNED_BUCKET].length === 4)
}

// --- 场景 4：已有本地存储（旧版 v1）按同一份规则迁移，用户数据原样保留 --------
{
  const v1 = {
    stratum: [{ id: 1, status: '已划分', pending: true, abnormal: false, 地层编号: 'STRA-1001', 备注: '用户数据' }],
    feature: [],
    overview: [
      { 登记编号: 'OV-1001', 登记日期: '2026-07-01', 摘要: '旧系统补登', 登记总量: 1, 关联编号: 'STRA-1002' },
      { 登记编号: 'OV-1002', 登记日期: '2026-07-02', 摘要: '无关联旧记录', 登记总量: 1 },
    ],
  }
  const adapter = createAdapter({ [ENTRIES_KEY]: JSON.stringify(v1) })
  const report = runBootstrap(adapter)
  const entries = readEntries(adapter)
  check('S4 旧版存储迁移成功', report.ok && report.migration.includes('v1'))
  check(
    'S4 用户既有记录原样保留',
    entries.stratum[0].备注 === '用户数据' && entries.stratum[0].地层编号 === 'STRA-1001',
  )
  check(
    'S4 旧总览记录按关联回填',
    entries.stratum.length === 2 && entries.stratum[1]['地层编号'] === 'STRA-1002' && entries.stratum[1]['来源登记编号'] === 'OV-1001',
  )
  check('S4 无关联旧记录留待人工', entries[UNASSIGNED_BUCKET].length === 1 && entries[UNASSIGNED_BUCKET][0]['登记编号'] === 'OV-1002')
  check('S4 旧版总览桶已消费', !('overview' in entries))
  check('S4 结构版本升到 v2', JSON.parse(adapter.getItem(META_KEY)).schemaVersion === 2)
}

// --- 场景 5：写入中途失败，整批回退并留下可复现失败日志 -----------------------
{
  const v1 = { stratum: [], overview: [{ 登记编号: 'OV-2001', 登记日期: '2026-07-03', 摘要: 'x', 登记总量: 1 }] }
  const inner = createAdapter({ [ENTRIES_KEY]: JSON.stringify(v1) })
  const originalSet = inner.setItem
  // 让 META 写入失败：此时 ENTRIES 已写完，属于部分写入，必须整体回退。
  inner.setItem = (key, value) => {
    if (key === META_KEY) {
      throw new Error('模拟写入失败（存储配额）')
    }
    originalSet(key, value)
  }
  const before = inner.dump()
  const report = runBootstrap(inner)
  const after = inner.dump()
  const log = readMigrationLog(inner)
  check('S5 失败有报告', !report.ok && typeof report.error === 'string' && report.error.includes('模拟写入失败'))
  check('S5 业务数据整批回退', after[ENTRIES_KEY] === before[ENTRIES_KEY])
  check('S5 版本标记未污染', after[META_KEY] === undefined)
  check(
    'S5 失败日志可复现',
    log.length === 1 && log[0].ok === false && log[0].error.includes('模拟写入失败') && /^[0-9a-f]{8}$/.test(log[0].inputFingerprint),
  )
}

// --- 场景 6：同样的输入必然得到同样的日志与数据（可复现） ---------------------
{
  const a = createAdapter()
  const b = createAdapter()
  runBootstrap(a)
  runBootstrap(b)
  check('S6 数据可复现', a.getItem(ENTRIES_KEY) === b.getItem(ENTRIES_KEY))
  check('S6 日志可复现', a.getItem(MIGRATION_LOG_KEY) === b.getItem(MIGRATION_LOG_KEY))
}

// --- 场景 7：跨页面口径一致——总览、地层记录、遗迹单位读同一份本地初始化数据 ---
{
  const overview = service.loadOverview()
  const stratumPage = service.listEntries('stratum')
  const featurePage = service.listEntries('feature')
  const stratumRow = overview.modules.find((row) => row.name === '地层记录')
  const featureRow = overview.modules.find((row) => row.name === '遗迹单位')
  check('S7 地层记录口径一致', stratumRow.created === 5 && stratumPage.total === 5)
  check('S7 遗迹单位口径一致', featureRow.created === 5 && featurePage.total === 5)
  const totalCard = overview.cards.find((card) => card.label === '登记总量')
  const manualCard = overview.cards.find((card) => card.label === '待人工处理')
  const moduleSum = overview.modules.reduce((sum, row) => sum + row.created, 0)
  check(
    'S7 登记总量 = 模块存量 + 待人工',
    totalCard.value === 62 && totalCard.value === moduleSum + overview.unassigned.length && manualCard.value === 4,
  )
  check('S7 初始化日志可见', service.overviewInitLog().length === 1)
}

if (failures > 0) {
  console.error(`\n${failures} 项校验失败`)
  process.exit(1)
}
console.log('\n全部校验通过')
