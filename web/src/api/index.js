/**
 * API 请求层
 * ---------------------------------------------------------------------------
 * 统一封装 axios：
 *   · 请求拦截：自动带上 JWT
 *   · 响应拦截：把 { code, message, data } 解包成 data，业务失败统一抛错并提示
 *   · 401 处理：清空本地登录态并跳转登录页
 * 好处：视图层只关心「拿到的数据」，不重复写 try/catch 与 token 处理。
 */
import axios from 'axios';
import { ElMessage } from 'element-plus';

const TOKEN_KEY = 'smartfit_token';

export const http = axios.create({
  // 开发环境走 Vite 代理（baseURL 留空即同源 /api）；生产可用 VITE_API_BASE 指定后端地址
  baseURL: import.meta.env.VITE_API_BASE || '',
  timeout: 60000, // AI 生成较慢，超时给足 60 秒
});

// ---------------- 请求拦截：注入 token
http.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ---------------- 响应拦截：解包 + 统一错误提示
http.interceptors.response.use(
  (response) => {
    const body = response.data;
    // 二进制/非标准响应直接返回
    if (body === null || typeof body !== 'object' || body.code === undefined) return body;
    if (body.code === 0) return body.data;
    ElMessage.error(body.message || '请求失败');
    return Promise.reject(new Error(body.message || '请求失败'));
  },
  (error) => {
    const status = error.response?.status;
    const message = error.response?.data?.message || error.message || '网络异常';
    if (status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem('smartfit_user');
      // 避免在登录页重复跳转
      if (!location.hash.includes('/login')) location.hash = '#/login';
      ElMessage.warning('登录已过期，请重新登录');
    } else {
      ElMessage.error(message);
    }
    return Promise.reject(error);
  },
);

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

/** 按业务模块组织的 API 集合 */
export const api = {
  // ---------------- 鉴权
  register: (data) => http.post('/api/auth/register', data),
  login: (data) => http.post('/api/auth/login', data),
  me: () => http.get('/api/auth/me'),
  updateProfile: (data) => http.put('/api/auth/profile', data),

  // ---------------- 身体数据
  bodyRecords: (limit = 60) => http.get('/api/body/records', { params: { limit } }),
  addBodyRecord: (data) => http.post('/api/body/records', data),
  deleteBodyRecord: (id) => http.delete(`/api/body/records/${id}`),
  bodyAnalysis: () => http.get('/api/body/analysis'),

  // ---------------- 动作库
  exercises: (params) => http.get('/api/exercises', { params }),
  exerciseMeta: () => http.get('/api/exercises/meta'),

  // ---------------- 运动打卡
  checkinLogs: (params) => http.get('/api/checkin/logs', { params }),
  addCheckin: (data) => http.post('/api/checkin/logs', data),
  deleteCheckin: (id) => http.delete(`/api/checkin/logs/${id}`),
  checkinStats: () => http.get('/api/checkin/stats'),

  // ---------------- 训练计划
  generatePlan: (data) => http.post('/api/plan/generate', data),
  planList: () => http.get('/api/plan/list'),
  planDetail: (id) => http.get(`/api/plan/${id}`),
  planPractice: () => http.get('/api/plan/latest/practice'),
  togglePlanItem: (id, data) => http.patch(`/api/plan/items/${id}`, data),
  deletePlan: (id) => http.delete(`/api/plan/${id}`),

  // ---------------- 饮食
  foods: (params) => http.get('/api/diet/foods', { params }),
  dietSummary: (date) => http.get('/api/diet/summary', { params: { date } }),
  addDietLog: (data) => http.post('/api/diet/logs', data),
  addDietBatch: (data) => http.post('/api/diet/logs/batch', data),
  deleteDietLog: (id) => http.delete(`/api/diet/logs/${id}`),
  recommendDiet: (data) => http.post('/api/diet/recommend', data),

  // ---------------- 社区
  posts: (params) => http.get('/api/community/posts', { params }),
  createPost: (data) => http.post('/api/community/posts', data),
  likePost: (id) => http.post(`/api/community/posts/${id}/like`),
  comments: (id) => http.get(`/api/community/posts/${id}/comments`),
  addComment: (id, data) => http.post(`/api/community/posts/${id}/comments`, data),
  deletePost: (id) => http.delete(`/api/community/posts/${id}`),
  leaderboard: () => http.get('/api/community/leaderboard'),

  // ---------------- AI 拍照识热量（多模态独立板块） ----------------
  foodScanCapability: () => http.get('/api/food-scan/capability'),
  foodScanAnalyze: (imageDataUrl) => http.post('/api/food-scan/analyze', { imageDataUrl }),
  foodScanHistory: (limit = 20) => http.get('/api/food-scan/history', { params: { limit } }),
  foodScanDetail: (id) => http.get(`/api/food-scan/${id}`),
  foodScanLog: (id, data) => http.post(`/api/food-scan/${id}/log`, data),
  foodScanDelete: (id) => http.delete(`/api/food-scan/${id}`),
  // 餐食评估 Agent：把「份量试算」结果交给后端，结合身体数据判断这一餐是否合适
  // （FoodScan.vue 的「③ 份量试算 & 饮食建议」卡片依赖此方法，缺失会导致点击即报错）
  foodScanAdvice: (data) => http.post('/api/food-scan/advice', data),

  // ---------------- 仪表盘 ----------------
  overview: () => http.get('/api/dashboard/overview'),

  // ---------------- AI
  aiStatus: () => http.get('/api/ai/status'),
  aiStats: () => http.get('/api/ai/stats'),
  aiHistory: () => http.get('/api/ai/history'),
  clearAiHistory: () => http.delete('/api/ai/history'),
  aiSuggestions: () => http.get('/api/ai/suggestions'),
  uploadImage: (dataUrl) => http.post('/api/ai/upload', { dataUrl }),
  visionFood: (imageDataUrl) => http.post('/api/ai/vision-food', { imageDataUrl }),
};

/**
 * AI 教练流式对话（SSE）
 * ---------------------------------------------------------------------------
 * 为什么不用 EventSource：EventSource 只支持 GET 且不能自定义 Header（无法带 JWT），
 * 因此这里用 fetch + ReadableStream 手动解析 SSE 帧，效果相同但更灵活。
 *
 * @param {string} question 用户问题
 * @param {{onDelta:Function, onDone:Function, onError:Function, onMeta:Function}} handlers
 * @returns {Promise<void>}
 */
export async function streamCoach(question, { onDelta, onDone, onError, onMeta } = {}) {
  const response = await fetch('/api/ai/coach', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenStore.get() || ''}`,
    },
    body: JSON.stringify({ question }),
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `请求失败(${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 帧以空行分隔
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';
    for (const frame of frames) {
      const lines = frame.split('\n');
      let event = 'message';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      if (event === 'delta') onDelta?.(payload.text, payload.type);
      else if (event === 'meta') onMeta?.(payload);
      else if (event === 'done') onDone?.(payload);
      else if (event === 'error') onError?.(payload.message);
    }
  }
}
