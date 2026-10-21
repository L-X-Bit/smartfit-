/**
 * Express 应用装配
 * ---------------------------------------------------------------------------
 * 分层结构：路由层（routes）→ 服务层（service / ai agent）→ 数据层（db）
 * 中间件顺序：CORS → 请求体解析 → 静态资源 → 日志 → 业务路由 → 404 → 错误处理
 */
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, SERVER_ROOT } from './config/index.js';
import { requestLogger } from './middleware/common.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';

// 业务路由
import authRoutes from './modules/auth/routes.js';
import bodyRoutes from './modules/body/routes.js';
import checkinRoutes from './modules/checkin/routes.js';
import exerciseRoutes from './modules/exercise/routes.js';
import planRoutes from './modules/plan/routes.js';
import dietRoutes from './modules/diet/routes.js';
import communityRoutes from './modules/community/routes.js';
import dashboardRoutes from './modules/dashboard/routes.js';
import aiRoutes from './modules/ai/routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();

  // 1) 跨域：开发环境前端跑在 5173，需要放开（生产环境建议用 Nginx 同源代理）
  app.use(cors({ origin: true, credentials: true }));

  // 2) 请求体解析：AI 相关接口可能带 base64 图片，放宽到 10MB
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // 3) 上传目录静态托管
  fs.mkdirSync(config.uploadDir, { recursive: true });
  app.use(config.uploadUrlPrefix, express.static(config.uploadDir, { maxAge: '7d' }));

  // 4) 请求日志
  app.use(requestLogger);

  // 5) 健康检查（部署探活用）
  app.get('/api/health', (req, res) =>
    res.json({ code: 0, message: 'ok', data: { name: '智练 SmartFit', time: new Date().toISOString(), env: config.env } }),
  );

  // 6) 业务路由
  app.use('/api/auth', authRoutes);
  app.use('/api/body', bodyRoutes);
  app.use('/api/checkin', checkinRoutes);
  app.use('/api/exercises', exerciseRoutes);
  app.use('/api/plan', planRoutes);
  app.use('/api/diet', dietRoutes);
  app.use('/api/community', communityRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/ai', aiRoutes);

  // 7) 生产模式下托管前端构建产物（npm run build 后 dist 目录）
  //    前端路由使用 history 模式，因此非 /api 开头的 GET 请求都回落到 index.html
  const webDist = path.resolve(SERVER_ROOT, '../web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api|uploads).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
    console.log('[静态资源] 已托管前端构建产物：', webDist);
  }

  // 8) 兜底
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
