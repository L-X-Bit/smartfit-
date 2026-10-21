<!--
  主布局：左侧导航 + 顶部栏 + 内容区
  ---------------------------------------------------------------
  导航项直接由路由表 meta 生成，新增页面只需在 router 里加一条，侧边栏自动出现。
-->
<template>
  <div class="layout">
    <!-- ============ 侧边栏 ============ -->
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

    <!-- ============ 右侧主体 ============ -->
    <div class="main">
      <header class="topbar">
        <div class="topbar-left">
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
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useUserStore } from '@/stores/user';
import { api } from '@/api';

const route = useRoute();
const router = useRouter();
const store = useUserStore();
const streak = ref(0);

/** 菜单由路由表生成（只取布局下的子路由） */
const menus = computed(() => {
  const layoutRoute = router.getRoutes().find((r) => r.path === '/');
  return (layoutRoute?.children || [])
    .filter((c) => c.meta?.title && c.path !== '')
    .map((c) => ({ path: `/${c.path}`, title: c.meta.title, icon: c.meta.icon, ai: c.meta.ai }));
});

const currentTitle = computed(() => route.meta.title || '数据总览');

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
</style>
