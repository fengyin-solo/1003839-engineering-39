import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { initData } from './data/local-store'
import './styles/global.css'

// 应用挂载前先跑一次示例数据初始化：幂等，本地开发/预览/部署/已有本地存储同一套规则。
// 失败会整批回退并留下可复现日志（runId + inputHash），不阻断页面加载。
initData()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
