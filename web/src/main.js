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
 */
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';
import 'element-plus/dist/index.css';
import './styles/index.css';
import App from './App.vue';
import router from './router';

const app = createApp(App);

// 全局注册 Element Plus 图标（<el-icon><Plus /></el-icon> 直接可用）
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn }); // 中文语言包（日期选择器等组件显示中文）

app.mount('#app');
