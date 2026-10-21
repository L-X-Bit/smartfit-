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
    token: tokenStore.get() || '',
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
      this.token = token;
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
    logout() {
      this.token = '';
      this.user = null;
      tokenStore.clear();
      localStorage.removeItem('smartfit_user');
    },
  },
});
