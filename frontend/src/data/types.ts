/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
  /** 无法按地层/遗迹关联归属、留待人工处理的历史记录（单独成桶，不计入任何模块存量）。 */
  unassigned: EntryRow[]
}

/**
 * 旧版本地存储里的总览登记：只有登记编号与登记总量，没有业务模块归属。
 * 初始化迁移时按地层/遗迹关联回填，无法归属的单独留待人工处理。
 */
export type LegacyOverviewRow = {
  登记编号: string
  登记日期: string
  摘要: string
  登记总量: number
  关联编号?: string
  地层编号?: string
  遗迹编号?: string
  [field: string]: string | number | undefined
}
