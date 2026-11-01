/**
 * 用户状态（Pinia Store）
 * ---------------------------------------------------------------------------
 * 保存登录态与用户档案，页面通过 useUserStore() 直接读，避免层层传参。
 * token 持久化在 localStorage，刷新页面不掉登录。
 */
import { defineStore } from 'pinia';
import { api, tokenStore } from '@/api';

export const useUserStore = defineStore('user', {
  state: () => ({
    // 注意：这里不再保存 JWT 明文。凭证在 HttpOnly Cookie 里，JS 读不到（防 XSS 窃取）；
    // token 字段仅用于「是否登录」的兼容判断（脚本注入 token 的老方式仍然可用）。
    token: tokenStore.has() ? 'cookie-session' : '',
    user: JSON.parse(localStorage.getItem('smartfit_user') || 'null'),
    aiStatus: null,
  }),

  getters: {
    isLogin: (s) => Boolean(s.token),
    nickname: (s) => s.user?.nickname || '健身达人',
    avatar: (s) => s.user?.avatar || '',
  },

  actions: {
    /** 登录 */
    async login(payload) {
      const data = await api.login(payload);
      this.setSession(data.token, data.user);
    },

    /** 注册（注册成功自动登录） */
    async register(payload) {
      const data = await api.register(payload);
      this.setSession(data.token, data.user);
    },

    setSession(token, user) {
      // token 本身不再落 localStorage（后端已写入 HttpOnly Cookie），tokenStore.set 只记登录标记
      this.token = 'cookie-session';
      this.user = user;
      tokenStore.set(token);
      localStorage.setItem('smartfit_user', JSON.stringify(user));
    },

    /** 刷新用户信息（改完档案后调用） */
    async refresh() {
      const me = await api.me();
      this.user = me;
      localStorage.setItem('smartfit_user', JSON.stringify(me));
      return me;
    },

    /** 获取 AI 能力状态（用于顶部标签展示「大模型/降级模式」） */
    async fetchAiStatus() {
      this.aiStatus = await api.aiStatus();
      return this.aiStatus;
    },

    /** 退出登录 */
    async logout() {
      // 通知后端清掉 HttpOnly Cookie（失败也不阻塞前端清理）
      try {
        await api.logout();
      } catch {
        /* 网络异常时忽略，本地状态照常清理 */
      }
      this.token = '';
      this.user = null;
      tokenStore.clear();
      localStorage.removeItem('smartfit_user');
    },
  },
});
