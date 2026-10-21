/**
 * 服务入口
 * ---------------------------------------------------------------------------
 * 启动流程：初始化数据库 → 预加载知识库索引 → 启动 HTTP 服务
 * 首次运行若数据库为空，会自动执行一次种子数据导入（等同 npm run init:db）。
 */
import { createApp } from './app.js';
import { config, printConfigSummary } from './config/index.js';
import { initSchema, get, run } from './db/index.js';
import { hashPassword } from './utils/security.js';

// 屏蔽 node:sqlite 的实验性特性警告（不影响功能，避免干扰演示时的控制台输出）
const originalEmit = process.emit;
process.emit = function (name, data, ...args) {
  if (name === 'warning' && data?.name === 'ExperimentalWarning' && /SQLite/i.test(data.message)) return false;
  return originalEmit.call(process, name, data, ...args);
};

/** 确保数据库结构与种子数据就绪 */
async function bootstrapDatabase() {
  initSchema();

  const userCount = get('SELECT COUNT(*) AS c FROM users').c;
  const exerciseCount = get('SELECT COUNT(*) AS c FROM exercises').c;

  if (userCount === 0 || exerciseCount === 0) {
    console.log('检测到数据库为空，正在自动导入初始数据（动作库/食物库/演示账号）...');
    // 动态导入种子脚本：该脚本在被导入时会自动完成「建表 + 知识库导入 + 演示数据生成」
    await import('./db/seed.js');
  }
}

async function main() {
  printConfigSummary();
  await bootstrapDatabase();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`✅ 后端服务已启动：http://localhost:${config.port}`);
    console.log(`   健康检查：http://localhost:${config.port}/api/health`);
    console.log(`   演示账号：demo / 123456\n`);
  });

  // 优雅关闭：收到信号后停止接收新请求，10 秒后强制退出
  const shutdown = (signal) => {
    console.log(`\n[${signal}] 正在关闭服务...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('服务启动失败：', err);
  process.exit(1);
});
