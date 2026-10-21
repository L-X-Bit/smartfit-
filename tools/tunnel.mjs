/**
 * 一键公网访问（内网穿透 · 守护版）
 * ===========================================================================
 * 目标：手机不用连校园网、不用开热点、不用数据线，复制一个 https 网址就能打开。
 *
 * 方案：SSH 反向隧道（localhost.run 免费服务，无需注册）
 *   本机 3000（生产构建 + 后端 API 同源） → https://xxxx.lhr.life
 *
 * 为什么不用其它两个方案（实测结论，避免你重复踩坑）：
 *   · localtunnel（loca.lt）：浏览器访问会被 511「Tunnel website ahead!」警告页拦截，
 *     该页还加载 Google 广告（国内加载不出来），SPA 永远白屏；
 *   · Cloudflare 快速隧道（cloudflared）：需从 GitHub 下载 52MB 客户端，
 *     本机网络限速只下到 13MB 就断，装不上。
 *   → localhost.run 是唯一能真正打开页面的；缺点是带宽小（约 10~30KB/s）、
 *     长时间空闲会被切断、每次重连域名都会变，因此本脚本做了：
 *       ① 断线自动重连；② 每轮打印新地址并写入 tools/tunnel-url.txt。
 *
 * 用法：
 *   node tools/tunnel.mjs
 * 前提：先 npm run build（前端构建产物）+ 后端已在 3000 端口运行。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.TUNNEL_PORT || 3000);
const URL_FILE = path.join(ROOT, 'tools', 'tunnel-url.txt');
const SSH = process.env.SSH_PATH || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'usr', 'bin', 'ssh.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 前置检查：前端已构建 + 后端在跑 + ssh 可用 */
async function preflight() {
  if (!fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) {
    console.error('✗ 没有前端构建产物，请先执行：npm run build');
    process.exit(1);
  }
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    const j = await r.json();
    console.log(`✓ 后端就绪：${j.data?.name || 'ok'}`);
  } catch {
    console.error(`✗ 后端未启动（127.0.0.1:${PORT}）。请先 npm run dev 或 npm start`);
    process.exit(1);
  }
  if (!fs.existsSync(SSH)) {
    console.error(`✗ 找不到 ssh（${SSH}）。可设置环境变量 SSH_PATH 指定路径`);
    process.exit(1);
  }
  console.log(`✓ ssh：${SSH}`);
}

/** 启动一轮隧道；拿到地址后打印，进程退出则自动重连 */
function connectOnce(attempt) {
  return new Promise((resolve) => {
    console.log(`\n正在建立隧道（第 ${attempt} 次）…`);
    const child = spawn(
      SSH,
      [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ServerAliveInterval=20',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ExitOnForwardFailure=yes',
        '-R', `80:localhost:${PORT}`,
        'nokey@localhost.run',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let printed = false;
    const handle = (buf) => {
      const text = buf.toString();
      const m = text.match(/https:\/\/([a-z0-9]+)\.lhr\.life/);
      if (m && !printed) {
        printed = true;
        const url = `https://${m[1]}.lhr.life`;
        fs.writeFileSync(URL_FILE, url + '\n', 'utf8');
        const line = '='.repeat(64);
        console.log(line);
        console.log('  🌐 手机公网访问地址（4G / 任何网络都能打开）：');
        console.log('');
        console.log(`     ${url}`);
        console.log('');
        console.log('  👤 演示账号：demo / 123456');
        console.log('');
        console.log('  ⏱  首次打开约 15~25 秒（免费隧道带宽有限），');
        console.log('     静态资源已开长缓存，第二次打开很快。');
        console.log('');
        console.log(`  📄 地址也写入了：${URL_FILE}`);
        console.log('  ⚠  隧道可能被服务端定期切断，脚本会自动重连；');
        console.log('     重连后地址会变，看这里的最新输出即可。');
        console.log(line);
      }
    };

    child.stdout.on('data', handle);
    child.stderr.on('data', handle);

    child.on('exit', (code) => {
      console.log(`\n⚠ 隧道进程退出（code ${code}）`);
      resolve();
    });
  });
}

(async () => {
  await preflight();
  let attempt = 1;
  for (;;) {
    await connectOnce(attempt);
    attempt += 1;
    console.log('  5 秒后自动重连…');
    await sleep(5000);
  }
})();
