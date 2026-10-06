/**
 * 历史「登记总账」：运营概览早期初始化只登记了登记总量，没有业务模块归属。
 * 这些记录不能猜测归属：初始化时按「关联地层 / 关联遗迹」与本地模块记录核对，
 * 能唯一对应上的才回填到地层记录或遗迹单位，对应不上的进入待归属队列留给人工处理。
 */
export type LedgerRecord = {
  /** 总账流水号，稳定标识，用于幂等去重 */
  ledgerNo: string
  /** 登记名称 / 摘要 */
  title: string
  /** 登记日期（YYYY-MM-DD） */
  registeredAt: string
  /**
   * 关联线索：可能是地层编号（STRA- 开头）或遗迹编号（FEAT- 开头），
   * 也可能缺失或写错；初始化只拿它与本地记录做精确核对，绝不猜测。
   */
  refCode: string
  /** 备注，原样保留 */
  note: string
}

/**
 * 随仓库发布的一份历史总账示例：本地开发、构建预览、部署环境首次初始化都走同一份。
 * 含可按地层回填、可按遗迹回填、编号对不上、缺少关联线索等各类记录，保证规则可演示、可复现。
 */
export const LEDGER_RECORDS: LedgerRecord[] = [
  {
    ledgerNo: 'REG-20260810-001',
    title: '早期地层补登（北区）',
    registeredAt: '2026-08-10',
    refCode: 'STRA-0001',
    note: '旧系统迁移，仅登记总量，归属待核',
  },
  {
    ledgerNo: 'REG-20260810-002',
    title: '早期地层补登（南区）',
    registeredAt: '2026-08-10',
    refCode: 'STRA-0002',
    note: '旧系统迁移，仅登记总量，归属待核',
  },
  {
    ledgerNo: 'REG-20260811-003',
    title: '早期遗迹补登（H 区灰坑）',
    registeredAt: '2026-08-11',
    refCode: 'FEAT-0001',
    note: '旧系统迁移，仅登记总量，归属待核',
  },
  {
    ledgerNo: 'REG-20260811-004',
    title: '早期遗迹补登（M 区墓葬）',
    registeredAt: '2026-08-11',
    refCode: 'FEAT-0003',
    note: '旧系统迁移，仅登记总量，归属待核',
  },
  {
    ledgerNo: 'REG-20260812-005',
    title: '编号残缺的补登记录',
    registeredAt: '2026-08-12',
    refCode: 'STRA-0999',
    note: '关联编号在本地地层记录中查无此号，无法自动归属',
  },
  {
    ledgerNo: 'REG-20260812-006',
    title: '缺少关联线索的补登记录',
    registeredAt: '2026-08-12',
    refCode: '',
    note: '纸质单据转登，未记录所属地层或遗迹',
  },
  {
    ledgerNo: 'REG-20260813-007',
    title: '重复补登记录',
    registeredAt: '2026-08-13',
    refCode: 'FEAT-0001',
    note: '与 REG-20260811-003 指向同一遗迹，疑似重复登记',
  },
]
