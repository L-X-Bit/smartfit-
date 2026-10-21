<!--
  主布局：左侧导航 + 顶部栏 + 内容区
  ---------------------------------------------------------------
  导航项直接由路由表 meta 生成，新增页面只需在 router 里加一条，侧边栏自动出现。
  移动端（≤900px）：侧边栏折叠为抽屉，顶栏出现汉堡按钮；桌面端隐藏汉堡、隐藏抽屉。
-->
<template>
  <div class="layout">
    <!-- ============ 侧边栏（桌面端） ============ -->
    <aside class="sidebar">
      <div class="logo">
        <div class="logo-mark">💪</div>
        <div class="logo-text">
          <div class="logo-title">智练 SmartFit</div>
          <div class="logo-sub">AI 健康运动管理平台</div>
        </div>
      </div>

      <nav class="menu">
        <router-link v-for="item in menus" :key="item.path" :to="item.path" class="menu-item" active-class="active">
          <el-icon class="menu-icon"><component :is="item.icon" /></el-icon>
          <span>{{ item.title }}</span>
          <span v-if="item.ai" class="ai-dot">AI</span>
        </router-link>
      </nav>

      <!-- AI 能力状态：让评委一眼看到「大模型已接入 / 降级模式」 -->
      <div class="ai-panel">
        <div class="ai-panel-title">
          <span class="ai-chip" :class="{ off: !aiOnline }">{{ aiOnline ? '大模型已接入' : '离线知识库模式' }}</span>
        </div>
        <div class="ai-model">{{ aiModelText }}</div>
        <div class="ai-tip">
          {{ aiOnline ? '训练计划由多阶段 AI Agent 生成' : '未配置密钥，已自动降级为规则引擎' }}
        </div>
      </div>
    </aside>

    <!-- ============ 侧边栏（移动端抽屉，内容与上面一致） ============ -->
    <el-drawer v-model="navOpen" direction="ltr" size="248px" :with-header="false" class="nav-drawer">
      <div class="drawer-body">
        <div class="logo">
          <div class="logo-mark">💪</div>
          <div class="logo-text">
            <div class="logo-title">智练 SmartFit</div>
            <div class="logo-sub">AI 健康运动管理平台</div>
          </div>
        </div>

        <nav class="menu">
          <router-link
            v-for="item in menus"
            :key="item.path"
            :to="item.path"
            class="menu-item"
            active-class="active"
            @click="navOpen = false"
          >
            <el-icon class="menu-icon"><component :is="item.icon" /></el-icon>
            <span>{{ item.title }}</span>
            <span v-if="item.ai" class="ai-dot">AI</span>
          </router-link>
        </nav>

        <div class="ai-panel">
          <div class="ai-panel-title">
            <span class="ai-chip" :class="{ off: !aiOnline }">{{ aiOnline ? '大模型已接入' : '离线知识库模式' }}</span>
          </div>
          <div class="ai-model">{{ aiModelText }}</div>
        </div>
      </div>
    </el-drawer>

    <!-- ============ 右侧主体 ============ -->
    <div class="main">
      <header class="topbar">
        <div class="topbar-left">
          <!-- 移动端汉堡按钮：打开导航抽屉 -->
          <button class="hamburger" type="button" aria-label="打开导航" @click="navOpen = true">
            <el-icon><Fold /></el-icon>
          </button>
          <h1 class="page-title">{{ currentTitle }}</h1>
          <span class="topbar-date">{{ todayText }}</span>
        </div>

        <div class="topbar-right">
          <div class="streak" v-if="streak > 0">
            🔥 连续打卡 <b>{{ streak }}</b> 天
          </div>
          <el-dropdown trigger="click" @command="onCommand">
            <div class="user-chip">
              <el-avatar :size="30" :src="store.avatar || undefined">{{ store.nickname.slice(0, 1) }}</el-avatar>
              <span class="user-name">{{ store.nickname }}</span>
              <el-icon><ArrowDown /></el-icon>
            </div>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="profile">个人中心</el-dropdown-item>
                <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <main class="content">
        <router-view v-slot="{ Component }">
          <transition name="fade-slide" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useUserStore } from '@/stores/user';
import { api } from '@/api';

const route = useRoute();
const router = useRouter();
const store = useUserStore();
const streak = ref(0);
/** 移动端导航抽屉开关（≤900px 时由顶栏汉堡按钮控制） */
const navOpen = ref(false);

/**
 * 菜单由路由表生成（只取布局下的子路由）
 * ---------------------------------------------------------------------------
 * 这里必须用 router.options.routes（原始配置）而不是 router.getRoutes()。
 * 踩过的坑：getRoutes() 返回的是「扁平化 + 规范化」后的记录列表，children 里的
 * `{ path: '', redirect: '/dashboard' }` 会被规范化成 path === '/'，与父路由撞车；
 * find(r => r.path === '/') 一旦命中那条空子路由（它没有 children），菜单就会变成空数组，
 * 表现为「侧边栏整块消失、只剩当前页面」——看起来像所有功能都没了。
 * 用原始配置则结构稳定：父路由的 children 就是那 10 个页面。
 */
const menus = computed(() => {
  const rootRoute = router.options.routes.find((r) => r.path === '/' && Array.isArray(r.children) && r.children.length);
  return (rootRoute?.children || [])
    .filter((c) => c.meta?.title && c.path)   // 过滤掉 path 为空的 redirect 占位项
    .map((c) => ({ path: `/${c.path}`, title: c.meta.title, icon: c.meta.icon, ai: c.meta.ai }));
});

const currentTitle = computed(() => route.meta.title || '数据总览');

// 路由变化时关闭移动端抽屉（否则点导航后抽屉会一直挡在上面）
watch(() => route.fullPath, () => { navOpen.value = false; });

const todayText = computed(() => {
  const d = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${week}`;
});

const aiOnline = computed(() => store.aiStatus?.enabled);
const aiModelText = computed(() => (store.aiStatus ? `模型：${store.aiStatus.model}` : '模型：检测中…'));

/** 下拉菜单命令 */
function onCommand(cmd) {
  if (cmd === 'logout') {
    store.logout();
    router.push('/login');
  } else if (cmd === 'profile') {
    router.push('/profile');
  }
}

onMounted(async () => {
  await store.fetchAiStatus();
  // 顶部连续打卡天数（复用仪表盘接口，轻量）
  try {
    const data = await api.overview();
    streak.value = data.streak || 0;
  } catch {
    /* 忽略：不影响布局渲染 */
  }
});
</script>

<style scoped>
.layout {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

/* ---------------- 侧边栏 ---------------- */
.sidebar {
  width: 232px;
  flex-shrink: 0;
  background: #0f172a;
  color: #cbd5e1;
  display: flex;
  flex-direction: column;
  padding: 18px 14px;
}

.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 6px 18px;
}
.logo-mark {
  width: 38px;
  height: 38px;
  border-radius: 12px;
  background: linear-gradient(135deg, #10b981, #059669);
  display: grid;
  place-items: center;
  font-size: 20px;
  box-shadow: 0 6px 16px rgba(16, 185, 129, 0.35);
}
.logo-title {
  font-size: 15px;
  font-weight: 800;
  color: #fff;
  letter-spacing: 0.3px;
}
.logo-sub {
  font-size: 10px;
  color: #64748b;
  margin-top: 2px;
}

.menu {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  overflow-y: auto;
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  color: #94a3b8;
  text-decoration: none;
  font-size: 13.5px;
  font-weight: 500;
  transition: all 0.2s ease;
  position: relative;
}
.menu-item:hover {
  background: rgba(148, 163, 184, 0.12);
  color: #e2e8f0;
}
.menu-item.active {
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.9), rgba(5, 150, 105, 0.9));
  color: #fff;
  font-weight: 700;
  box-shadow: 0 6px 16px rgba(16, 185, 129, 0.3);
}
.menu-icon {
  font-size: 16px;
}
.ai-dot {
  margin-left: auto;
  font-size: 9px;
  font-weight: 800;
  padding: 1px 5px;
  border-radius: 999px;
  background: linear-gradient(135deg, #fbbf24, #f59e0b);
  color: #78350f;
}

/* ---------------- AI 状态面板 ---------------- */
.ai-panel {
  margin-top: 12px;
  padding: 12px;
  border-radius: 12px;
  background: rgba(148, 163, 184, 0.1);
  border: 1px solid rgba(148, 163, 184, 0.15);
}
.ai-panel-title {
  margin-bottom: 8px;
}
.ai-model {
  font-size: 11px;
  color: #94a3b8;
  word-break: break-all;
}
.ai-tip {
  font-size: 10.5px;
  color: #64748b;
  margin-top: 6px;
  line-height: 1.5;
}

/* ---------------- 主体 ---------------- */
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.topbar {
  height: 68px;
  flex-shrink: 0;
  background: #fff;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
}
.topbar-left {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.topbar .page-title {
  font-size: 17px;
  margin: 0;
}
.topbar-date {
  font-size: 12px;
  color: var(--text-3);
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 16px;
}
.streak {
  font-size: 12.5px;
  color: var(--text-2);
  background: #fff7ed;
  border: 1px solid #fed7aa;
  padding: 5px 12px;
  border-radius: 999px;
}
.streak b {
  color: #ea580c;
}
.user-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 10px;
  transition: background 0.2s;
}
.user-chip:hover {
  background: var(--bg);
}
.user-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 22px 24px 40px;
}

/* ---------------- 移动端：汉堡按钮 + 抽屉导航 ---------------- */
/* 桌面端隐藏汉堡；≤900px 时隐藏固定侧边栏、显示汉堡 */
.hamburger {
  display: none;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fff;
  color: var(--text-2);
  font-size: 17px;
  cursor: pointer;
  transition: all 0.2s ease;
}
.hamburger:hover {
  background: var(--brand-light);
  border-color: #a7f3d0;
  color: var(--brand-dark);
}

/* 抽屉内的导航（背景与桌面侧边栏一致，视觉连续） */
.nav-drawer :deep(.el-drawer) {
  background: #0f172a;
}
.nav-drawer :deep(.el-drawer__body) {
  padding: 16px 14px;
  overflow-y: auto;
}
.drawer-body {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.drawer-body .menu {
  flex: 1;
}
.drawer-body .ai-panel {
  margin-top: 14px;
}

@media (max-width: 900px) {
  .sidebar {
    display: none;
  }
  .hamburger {
    display: inline-flex;
  }
  .topbar-left {
    gap: 8px;
    align-items: center;
  }
  .logo-text {
    display: block;
  }
}
</style>
