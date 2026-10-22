/**
 * 路由配置
 * ---------------------------------------------------------------------------
 * · 使用 history 模式（需后端托管时回落到 index.html，已在 server 中处理）
 * · 全局前置守卫做登录校验：未登录访问业务页 → 跳登录页并记住来源
 * · 每个路由的 meta.title 同时用于侧边栏菜单与浏览器标题
 */
import { createRouter, createWebHistory } from 'vue-router';
import { useUserStore } from '@/stores/user';

const routes = [
  { path: '/login', name: 'login', component: () => import('@/views/Login.vue'), meta: { public: true, title: '登录' } },
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', name: 'dashboard', component: () => import('@/views/Dashboard.vue'), meta: { title: '数据总览', icon: 'DataBoard' } },
      { path: 'checkin', name: 'checkin', component: () => import('@/views/Checkin.vue'), meta: { title: '运动打卡', icon: 'AlarmClock' } },
      { path: 'plan', name: 'plan', component: () => import('@/views/Plan.vue'), meta: { title: 'AI 健身计划', icon: 'Calendar' } },
      { path: 'body', name: 'body', component: () => import('@/views/Body.vue'), meta: { title: '身体数据', icon: 'Odometer' } },
      // 可穿戴设备同步：蓝牙心率带实时心率 / 手环数据导入 / 无设备演示模式
      { path: 'devices', name: 'devices', component: () => import('@/views/Devices.vue'), meta: { title: '设备同步', icon: 'Watch' } },
      { path: 'analytics', name: 'analytics', component: () => import('@/views/Analytics.vue'), meta: { title: '数据可视化', icon: 'TrendCharts' } },
      { path: 'coach', name: 'coach', component: () => import('@/views/Coach.vue'), meta: { title: 'AI 健身教练', icon: 'ChatDotRound', ai: true } },
      { path: 'diet', name: 'diet', component: () => import('@/views/Diet.vue'), meta: { title: '健康饮食', icon: 'Bowl' } },
      { path: 'food-scan', name: 'foodscan', component: () => import('@/views/FoodScan.vue'), meta: { title: 'AI 拍照识热量', icon: 'Camera', ai: true } },
      { path: 'community', name: 'community', component: () => import('@/views/Community.vue'), meta: { title: '运动社区', icon: 'ChatLineSquare' } },
      { path: 'profile', name: 'profile', component: () => import('@/views/Profile.vue'), meta: { title: '个人中心', icon: 'User' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

// ---------------- 全局守卫：登录校验 + 标题
router.beforeEach((to) => {
  const store = useUserStore();
  document.title = to.meta.title ? `${to.meta.title} · 智练 SmartFit` : '智练 SmartFit';

  if (!to.meta.public && !store.isLogin) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  // 已登录还访问登录页 → 回首页
  if (to.name === 'login' && store.isLogin) return { name: 'dashboard' };
  return true;
});

export default router;
