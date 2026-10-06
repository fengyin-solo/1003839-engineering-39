/**
 * 初始化规则验证（纯 Node + esbuild 打包，无需浏览器）：
 *   node --experimental-vm-modules 不需要，直接打包成 ESM 后 import。
 *
 * 覆盖：首次播种幂等、按地层/遗迹回填、无法归属挂起、重复登记挂起、
 *       旧版裸模块表迁移、旧概览快照迁移、损坏数据回退、落盘失败整批回退、
 *       人工归属、概览口径一致。
 */
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'init-check-'))
const outfile = join(dir, 'init.bundle.mjs')

await build({
  entryPoints: ['src/data/init.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent',
})

const init = await import(pathToFileURL(outfile).href)

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (map.get('__throw_on__') === k) {
        throw new Error(`模拟写入失败:${k}`)
      }
      map.set(k, v)
    },
    removeItem: (k) => map.delete(k),
    _map: map,
  }
}

const SEED_MODULE_COUNT = 54 // 18 个模块 × 3 条示例
const FIXED_NOW = new Date('2026-10-06T08:00:00.000Z')

// ---- 1. 首次播种：自动回填 + 挂起 -----------------------------------------
console.log('1) 首次初始化')
{
  const storage = makeStorage()
  const { db, report } = init.initializeStorage(storage, FIXED_NOW)
  check('状态为 fresh', report.status === 'fresh', report.status)
  check('回填 4 条（2 地层 + 2 遗迹）', report.attributed === 4, String(report.attributed))
  check('待归属 3 条（编号缺失/无线索/重复）', report.pendingTotal === 3, String(report.pendingTotal))
  check('疑似重复 1 条', report.duplicates === 1, String(report.duplicates))
  const total = Object.values(db.modules).reduce((s, rows) => s + rows.length, 0)
  check(`模块合计=${SEED_MODULE_COUNT + 4}`, total === SEED_MODULE_COUNT + 4, String(total))
  check('地层记录为 5 条（3 示例 + 2 回填）', db.modules.stratum.length === 5, String(db.modules.stratum.length))
  check('遗迹单位为 5 条（3 示例 + 2 回填）', db.modules.feature.length === 5, String(db.modules.feature.length))
  const backfilled = db.modules.stratum.find((r) => r['_总账流水号'] === 'REG-20260810-001')
  check('回填记录关联字段精确命中 STRA-0001', backfilled && backfilled['地层编号'] === 'STRA-0001')
  check('回填记录保留追溯信息', backfilled && backfilled['_来源'] === '历史登记总账自动回填')
  check('回填记录继承所属探方', backfilled && backfilled['所属探方'] === '地层记录样例1')
  const reasons = db.pending.map((p) => p.reason).sort()
  check(
    '挂起原因齐全',
    JSON.stringify(reasons) === JSON.stringify(['code-not-found', 'duplicate', 'missing-ref']),
    JSON.stringify(reasons),
  )
  check('存储为版本化结构 v2', JSON.parse(storage.getItem(init.DB_KEY)).version === 2)
  check('写入了可复现日志', JSON.parse(storage.getItem(init._internal.INIT_LOG_KEY)).length === 1)
}

// ---- 2. 幂等：重复启动不增加记录 ------------------------------------------
console.log('2) 重复启动幂等')
{
  const storage = makeStorage()
  const first = init.initializeStorage(storage, FIXED_NOW)
  const snapshotAfterFirst = storage.getItem(init.DB_KEY)
  const second = init.initializeStorage(storage, FIXED_NOW)
  check('第二次状态 unchanged', second.report.status === 'unchanged', second.report.status)
  check('第二次回填 0 条', second.report.attributed === 0)
  check('第二次不改变模块数据', storage.getItem(init.DB_KEY) === snapshotAfterFirst)
  const third = init.initializeStorage(storage, FIXED_NOW)
  check('第三次仍幂等', third.report.status === 'unchanged')
  check('runId 对相同存储状态可复现', second.report.runId === third.report.runId)
  check('重复启动不重复写日志状态', second.report.attributed === 0 && third.report.attributed === 0)
  check('地层仍为 5 条', third.db.modules.stratum.length === 5)
  check('待归属仍为 3 条', third.db.pending.length === 3)
}

// ---- 3. 旧版裸模块表迁移：已有记录不被覆盖 --------------------------------
console.log('3) 旧版裸模块表（仅有本地模块数据）迁移')
{
  // 旧结构就是 { trench: [...] }：示例模块缺失，已存在的记录必须原样保留
  const legacy = {
    trench: [{ id: 1, status: '发掘中', pending: true, abnormal: false, 探方编号: 'MY-TRENCH' }],
  }
  const storage = makeStorage({ [init.DB_KEY]: JSON.stringify(legacy) })
  const { db, report } = init.initializeStorage(storage, FIXED_NOW)
  check('状态 migrated', report.status === 'migrated')
  check('用户已有记录不被覆盖', db.modules.trench[0]['探方编号'] === 'MY-TRENCH')
  check('缺失模块用示例补齐', db.modules.stratum.length === 5)
  check('总账只处理一次（旧存储也走同一规则）', db.consumed.length === 7)
  const second = init.initializeStorage(storage, FIXED_NOW)
  check('再次启动幂等', second.report.status === 'unchanged')
}

// ---- 4. 旧概览快照：只含登记总量，迁移后删除并记录口径差异 -----------------
console.log('4) 旧运营概览快照迁移与口径核对')
{
  const legacyOverview = { cards: [{ label: '登记总量', value: 99 }], modules: [] }
  const storage = makeStorage({
    [init._internal.LEGACY_OVERVIEW_KEY]: JSON.stringify(legacyOverview),
  })
  const { db, report } = init.initializeStorage(storage, FIXED_NOW)
  check('记录了旧快照登记总量', report.legacyOverviewTotal === 99)
  check('概览以本地模块合计为准', report.modulesTotal === SEED_MODULE_COUNT + 4)
  check('旧概览快照已随事务删除', storage.getItem(init._internal.LEGACY_OVERVIEW_KEY) === null)
  const reconcile = report.steps.find((s) => s.name === 'reconcile-overview')
  check('日志记录口径差异=99-58=41', reconcile && reconcile.detail.includes('口径差异=41'), reconcile?.detail)
  check('模块数据完整', Object.keys(db.modules).length === 18)
}

// ---- 5. 损坏数据：保持原存储，整批不落盘，报告失败 --------------------------
console.log('5) 损坏/无法识别数据回退')
{
  const garbage = '{不是合法 JSON'
  const storage = makeStorage({ [init.DB_KEY]: garbage })
  const { report } = init.initializeStorage(storage, FIXED_NOW)
  check('状态 failed', report.status === 'failed')
  check('原始损坏数据原样保留', storage.getItem(init.DB_KEY) === garbage)
  check('错误信息可复现（含失败原因）', report.error.includes('JSON') || report.error.includes('解析'), report.error)
  check('失败也写日志', JSON.parse(storage.getItem(init._internal.INIT_LOG_KEY)).length === 1)

  const unrecognized = JSON.stringify({ unexpected: true })
  const storage2 = makeStorage({ [init.DB_KEY]: unrecognized })
  const r2 = init.initializeStorage(storage2, FIXED_NOW)
  check('结构无法识别时不覆盖原存储', storage2.getItem(init.DB_KEY) === unrecognized && r2.report.status === 'failed')
}

// ---- 6. 落盘失败：整批回退，存储与初始化前一致 -----------------------------
console.log('6) 落盘失败整批回退')
{
  const storage = makeStorage()
  storage._map.set('__throw_on__', init.DB_KEY)
  const beforeKeys = [...storage._map.keys()]
  const { report } = init.initializeStorage(storage, FIXED_NOW)
  check('状态 failed 已回退', report.status === 'failed')
  check('回退后没有残留 entries', storage.getItem(init.DB_KEY) === null)
  check('键集合与初始化前一致（仅多日志）',
    [...storage._map.keys()].filter((k) => k !== init._internal.INIT_LOG_KEY && k !== '__throw_on__')
      .join(',') === beforeKeys.filter((k) => k !== '__throw_on__').join(','))
}

// ---- 7. 人工归属：操作员指定模块才移动，不猜编号 ----------------------------
console.log('7) 人工归属')
{
  const storage = makeStorage()
  const first = init.initializeStorage(storage, FIXED_NOW)
  const noRef = first.db.pending.find((p) => p.reason === 'missing-ref')
  const result = init.assignPending(first.db, noRef.ledgerNo, 'stratum', storage, FIXED_NOW)
  check('归属成功', result.message.includes('已归属'), result.message)
  check('队列减少 1 条', result.db.pending.length === 2)
  check('地层增加 1 条', result.db.modules.stratum.length === 6)
  check('人工归属记录带追溯来源',
    result.db.modules.stratum.some((r) => r['_总账流水号'] === noRef.ledgerNo && r['_来源'] === '历史登记总账人工归属'))
  const bad = init.assignPending(result.db, 'NOT-EXIST', 'feature', storage, FIXED_NOW)
  check('处理不存在的记录报错且不动数据', !bad.message.includes('已归属') && bad.db.modules.feature.length === 5)
  // 错误前缀编号不会被强写进业务编号字段
  const notFound = result.db.pending.find((p) => p.reason === 'code-not-found')
  const toFeature = init.assignPending(result.db, notFound.ledgerNo, 'feature', storage, FIXED_NOW)
  const row = toFeature.db.modules.feature.find((r) => r['_总账流水号'] === notFound.ledgerNo)
  check('STRA 编号不会被猜写进遗迹编号字段', row && row['遗迹编号'] === undefined)
}

// ---- 8. 内存兜底（无 localStorage 环境，如 SSR/隐私模式） --------------------
console.log('8) 无本地存储时内存兜底')
{
  const { report } = init.initializeStorage(init.createMemoryStorage(), FIXED_NOW)
  check('内存模式可完成初始化', report.mode === 'memory' && report.attributed === 4)
}

// ---- 9. 旧概览自带 records 时以旧记录为准（不重复处理示例总账） --------------
console.log('9) 旧概览内联总账迁移')
{
  const legacyOverview = {
    total: 1,
    records: [
      { ledgerNo: 'OLD-1', title: '旧库记录', registeredAt: '2026-08-01', refCode: 'STRA-0001', note: '' },
    ],
  }
  const storage = makeStorage({ [init._internal.LEGACY_OVERVIEW_KEY]: JSON.stringify(legacyOverview) })
  const { db } = init.initializeStorage(storage, FIXED_NOW)
  check('只处理旧概览自带的 1 条总账', db.consumed.length === 1)
  check('旧记录回填到地层', db.modules.stratum.length === 4)
  check('示例总账不被额外应用', db.pending.length === 0)
}

// ---- 10. 跨页面对账：运营概览与地层记录、遗迹单位读同一份存储 ----------------
console.log('10) 服务层跨页面对账（带 window.localStorage 垫片）')
{
  const svcOut = join(dir, 'service.bundle.mjs')
  await build({
    entryPoints: ['src/api/local-service.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: svcOut,
    alias: { '@': join(process.cwd(), 'src') },
    logLevel: 'silent',
  })
  // 模拟浏览器环境后再加载（模块顶层不会访问 window，初始化在 main.ts 触发）
  const browserStore = makeStorage()
  globalThis.window = {
    localStorage: {
      getItem: (k) => browserStore.getItem(k),
      setItem: (k, v) => browserStore.setItem(k, v),
      removeItem: (k) => browserStore.removeItem(k),
    },
  }
  const svc = await import(pathToFileURL(svcOut).href)

  // 与 main.ts 相同的启动动作
  const store = await import(pathToFileURL(outfile).href)
  store.initializeStorage()

  const overview = svc.loadOverview()
  const totalCard = overview.cards.find((c) => c.label === '登记总量').value
  const pendingCard = overview.cards.find((c) => c.label === '待归属').value
  const stratumRow = overview.modules.find((m) => m.name === '地层记录')
  const featureRow = overview.modules.find((m) => m.name === '遗迹单位')
  const stratumLocal = svc.listEntries('stratum')
  const featureLocal = svc.listEntries('feature')

  check('概览登记总量=58', totalCard === 58, String(totalCard))
  check('概览待归属卡=3', pendingCard === 3, String(pendingCard))
  check('概览地层存量=本地地层列表数', stratumRow.created === stratumLocal.total && stratumLocal.total === 5, `${stratumRow.created} vs ${stratumLocal.total}`)
  check('概览遗迹存量=本地遗迹列表数', featureRow.created === featureLocal.total && featureLocal.total === 5, `${featureRow.created} vs ${featureLocal.total}`)
  check('登记表合计等于各模块行之和', totalCard === overview.modules.reduce((s, m) => s + m.created, 0))
  check('待归属接口返回 3 条', svc.pendingEntries().length === 3)

  // 回填记录可正常参与状态流转
  const backfilledId = stratumLocal.items.find((r) => r['_总账流水号'] === 'REG-20260810-001').id
  const action = svc.runAction('stratum', backfilledId, '提交记录')
  check('回填记录可状态流转', action.ok && svc.listEntries('stratum').items.find((r) => r.id === backfilledId).status === '已记录')

  // 人工归属走服务层后，概览与列表同步变化
  const target = svc.pendingEntries().find((p) => p.reason === 'missing-ref')
  const assigned = svc.assignPendingEntry(target.ledgerNo, 'stratum')
  const overview2 = svc.loadOverview()
  check('人工归属成功', assigned.ok, assigned.message)
  check('归属后概览待归属降为 2', overview2.pendingQueue === 2 && overview2.cards.find((c) => c.label === '待归属').value === 2)
  check('归属后概览地层=6，与本地列表一致',
    overview2.modules.find((m) => m.name === '地层记录').created === 6 && svc.listEntries('stratum').total === 6)

  // 重置模块后三处口径仍同源（重置是显式动作，概览不再有自己的旧快照）
  svc.resetModule('stratum')
  const overview3 = svc.loadOverview()
  check('显式重置后概览仍与本地列表一致',
    overview3.modules.find((m) => m.name === '地层记录').created === svc.listEntries('stratum').total)
  check('旧概览快照键从未被创建', browserStore.getItem(store._internal.LEGACY_OVERVIEW_KEY) === null)

  delete globalThis.window
}

rmSync(dir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n全部检查通过')
