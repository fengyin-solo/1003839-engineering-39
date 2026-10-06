import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { runBootstrap } from '@/data/bootstrap'
import './styles/global.css'

// 启动先跑数据初始化/迁移：幂等、失败整批回退，各环境同一份规则。
runBootstrap()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
