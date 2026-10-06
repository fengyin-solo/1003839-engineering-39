<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常；存量与各模块页面同一口径。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value" :class="{ 'stat-warn': card.label === '待归属' && card.value > 0 }">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>存量</th><th>待处理</th><th>异常量</th></tr>
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

    <section v-if="pending.length" class="pending-panel">
      <h3>缺归属历史记录（待人工处理）</h3>
      <p class="page-desc">
        这些记录来自旧运营概览的登记总账，无法按地层或遗迹编号唯一对应，系统没有猜测归属；
        请人工指定业务模块后归属。自动回填的记录已直接进入「地层记录」或「遗迹单位」。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>总账流水号</th><th>登记名称</th><th>登记日期</th><th>关联编号</th>
            <th>无法归属原因</th><th>人工归属到</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in pending" :key="item.ledgerNo">
            <td>{{ item.ledgerNo }}</td>
            <td>{{ item.title }}</td>
            <td>{{ item.registeredAt }}</td>
            <td>{{ item.refCode || '—' }}</td>
            <td class="error-text">{{ item.reasonText }}</td>
            <td>
              <select v-model="assignments[item.ledgerNo]">
                <option value="" disabled>请选择模块</option>
                <option value="stratum">地层记录</option>
                <option value="feature">遗迹单位</option>
              </select>
            </td>
            <td>
              <button
                class="link"
                type="button"
                :disabled="!assignments[item.ledgerNo]"
                @click="assignOne(item.ledgerNo)"
              >
                确认归属
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
      <span v-if="message" :class="messageOk ? '' : 'error-text'">{{ message }}</span>
      <span v-if="init">
        初始化 runId：{{ init.runId.slice(0, 8) }} · 状态：{{ statusText(init.status) }} ·
        自动回填 {{ init.attributed }} 条 · 待归属 {{ init.pendingTotal }} 条
        <button class="link" type="button" @click="showLog = !showLog">
          {{ showLog ? '收起日志' : '查看初始化日志' }}
        </button>
      </span>
    </footer>

    <section v-if="showLog && init" class="init-log">
      <h3>初始化日志（最近 {{ logs.length }} 次，可复现）</h3>
      <ul>
        <li v-for="(log, index) in logs" :key="index">
          <strong>{{ log.at }}</strong> runId={{ log.runId }} inputHash={{ log.inputHash }}
          status={{ log.status }} · 回填 {{ log.attributed }} · 待归属 {{ log.pendingTotal }}
          · 模块合计 {{ log.modulesTotal }}
          <span v-if="log.legacyOverviewTotal !== undefined">
            · 旧概览登记总量 {{ log.legacyOverviewTotal }}
          </span>
          <span v-if="log.error" class="error-text"> · 错误：{{ log.error }}</span>
          <ul>
            <li v-for="(step, stepIndex) in log.steps" :key="stepIndex">
              [{{ step.name }}] {{ step.detail }}
            </li>
          </ul>
        </li>
      </ul>
    </section>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'

import {
  assignPendingEntry,
  lastInitReport,
  loadOverview,
  pendingEntries,
  readInitLog,
} from '@/api/local-service'
import type { OverviewResult } from '@/data/types'
import type { InitReport, PendingRecord } from '@/api/local-service'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const pending = ref<PendingRecord[]>([])
const assignments = reactive<Record<string, string>>({})
const init = ref<InitReport | null>(null)
const logs = ref<InitReport[]>([])
const showLog = ref(false)
const message = ref('')
const messageOk = ref(true)

const STATUS_TEXT: Record<InitReport['status'], string> = {
  fresh: '首次播种',
  migrated: '已迁移',
  unchanged: '已是最新（幂等无写入）',
  failed: '失败已回退',
}

function statusText(status: InitReport['status']): string {
  return STATUS_TEXT[status]
}

function refresh() {
  message.value = ''
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  pending.value = pendingEntries()
  init.value = lastInitReport()
  logs.value = readInitLog()
}

function assignOne(ledgerNo: string) {
  const moduleKey = assignments[ledgerNo]
  if (!moduleKey) {
    return
  }
  const result = assignPendingEntry(ledgerNo, moduleKey)
  message.value = result.message
  messageOk.value = result.ok
  if (result.ok) {
    delete assignments[ledgerNo]
  }
  refresh()
}

onMounted(refresh)
</script>

<style scoped>
.stat-warn {
  color: #b42318;
}
.pending-panel {
  margin-top: 16px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.pending-panel h3 {
  margin: 0 0 6px;
  font-size: 15px;
}
.init-log {
  margin-top: 12px;
  background: #0f172a;
  color: #d1d5db;
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 12px;
  max-height: 280px;
  overflow: auto;
}
.init-log h3 {
  color: #fff;
  font-size: 13px;
  margin: 0 0 8px;
}
.init-log ul {
  padding-left: 18px;
  margin: 4px 0;
}
.init-log .error-text {
  color: #fca5a5;
}
.page-actions {
  display: flex;
  gap: 8px;
}
</style>
