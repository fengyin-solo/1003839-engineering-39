<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>登记总量</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">待人工处理（未归属历史记录）</h3>
    <table class="data-table">
      <thead>
        <tr><th>登记编号</th><th>登记日期</th><th>摘要</th><th>未归属原因</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in unassigned" :key="String(row.id)">
          <td>{{ row['登记编号'] ?? '—' }}</td>
          <td>{{ row['登记日期'] ?? '—' }}</td>
          <td>{{ row['摘要'] ?? '—' }}</td>
          <td>{{ row['未归属原因'] ?? '—' }}</td>
        </tr>
        <tr v-if="!unassigned.length">
          <td colspan="4" class="empty-state">没有待人工处理的历史记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>口径：登记总量 = 各模块存量合计 + 待人工处理；各模块存量与对应业务页列表总数一致</span>
      <span>{{ initSummary }}</span>
    </footer>
    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadOverview, overviewInitLog } from '@/api/local-service'
import type { EntryRow, OverviewResult } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const unassigned = ref<EntryRow[]>([])
const initSummary = ref('')

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  unassigned.value = payload.unassigned
  const logs = overviewInitLog()
  const last = logs[logs.length - 1]
  initSummary.value = last
    ? `最近初始化：${last.migration} · 回填 ${last.summary.backfilled} 条 · 待人工 ${last.summary.manual} 条 · 指纹 ${last.outputFingerprint}`
    : '数据结构已是最新版本，本次启动无需迁移'
}

onMounted(refresh)
</script>

<style scoped>
.section-title {
  font-size: 14px;
  margin: 16px 0 8px;
}
</style>
