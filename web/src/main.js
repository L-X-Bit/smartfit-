/**
 * 前端入口
 * ---------------------------------------------------------------------------
 * 技术栈：Vue 3（Composition API）+ Vite + Pinia + Vue Router + Element Plus + ECharts
 * 选择理由（技术文档「技术架构」章节）：
 *   · Vue 3 Composition API：逻辑按功能聚合，配合 <script setup> 代码量比 Options API 少 30%；
 *   · Vite：冷启动毫秒级、HMR 极快，开发体验好，构建产物支持按需拆包；
 *   · Element Plus：国内生态最完整的 Vue3 组件库，中后台表单/表格/弹窗开箱即用；
 *   · ECharts：图表类型最全（折线/柱状/雷达/饼图/热力图/仪表盘），中文文档完善，
 *     完全满足「数据可视化」需求，且支持按需引入减小体积；
 *   · Pinia：Vue 官方推荐的状态管理，比 Vuex 更简洁，TS 友好。
 *
 * 体积优化说明（重要）：
 *   这里**不再全量注册 Element Plus**（原 app.use(ElementPlus) + 全量 index.css 约 1.15MB）。
 *   改为在 vite.config.js 里用 unplugin-vue-components + ElementPlusResolver 做编译期按需引入，
 *   模板里写 <el-button> 就会自动引入该组件与其样式；ElMessage / ElMessageBox 等函数式 API
 *   由 unplugin-auto-import 自动引入样式。
 *   中文语言包通过 App.vue 的 <el-config-provider :locale="zhCn"> 提供，不再全局注入。
 *
 *   图标仍保留全量注册：因为侧边栏菜单用 `<component :is="item.icon" />` 动态渲染（图标名是字符串），
 *   编译期无法静态分析，全量注册（约 150KB）是最稳妥的做法。
 */
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';
import './styles/index.css';
import App from './App.vue';
import router from './router';

const app = createApp(App);

// 全局注册 Element Plus 图标（<el-icon><Plus /></el-icon> 与动态 <component :is> 都依赖它）
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

app.use(createPinia());
app.use(router);

app.mount('#app');
