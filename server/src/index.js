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
import { ensureDemoFresh } from './db/demoRefresh.js';

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

  // 演示数据保鲜：部署很久没重启时，把演示数据整体平移到今天（详见 db/demoRefresh.js）
  try {
    const fresh = ensureDemoFresh();
    if (fresh.shifted) console.log(`[演示数据] 保鲜完成，整体后移 ${fresh.shifted} 天`);
    else console.log(`[演示数据] 无需保鲜：${fresh.reason || '已是最新'}`);
  } catch (err) {
    console.warn('[演示数据] 保鲜失败（不影响服务启动）：', err.message);
  }

  const app = createApp();
  /**
   * 监听地址显式指定 0.0.0.0：
   * 不传 host 时 Node 会绑到 `::`，某些容器/Render 环境没开 IPv4-mapped，
   * 结果 127.0.0.1 连不上、健康检查一直失败（线上排查过这个坑）。
   */
  const server = app.listen(config.port, config.host, () => {
    console.log(`✅ 后端服务已启动：http://localhost:${config.port}（监听 ${config.host}:${config.port}）`);
    console.log(`   健康检查：http://localhost:${config.port}/api/health`);
    console.log(`   业务时区：${config.timezone}　今天：${new Date().toISOString().slice(0, 10)}（UTC 参考）`);
    console.log(`   演示账号：demo / 123456\n`);
  });

  // 端口被占用 / 无权限等启动期错误：打印成可读的一句话，而不是未捕获异常堆栈
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ 端口 ${config.port} 已被占用：请先关闭占用进程，或用 PORT=3001 npm start 换端口`);
    } else {
      console.error('❌ HTTP 服务启动失败：', err.message);
    }
    process.exit(1);
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
