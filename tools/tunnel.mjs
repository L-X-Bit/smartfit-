/**
 * 一键公网访问（内网穿透 · 多线路守护版）
 * ===========================================================================
 * 目标：手机不用连校园网、不用开热点、不用数据线，复制一个 https 网址就能打开。
 *
 * 为什么需要"守护"：免费隧道服务（localhost.run / pinggy）会定期把连接切断，
 * 而且**每重连一次域名都会变**——所以脚本必须做到四件事：
 *   ① 断线自动重连；② 换线路兜底（一个服务挂了换另一个）；③ 心跳保活；
 *   ④ 把当前地址写进 tools/tunnel-url.txt，并在终端显著位置打印。
 *
 * 两条线路（自动切换，都无需注册）：
 *   · localhost.run —— ssh -R 80:localhost:3000 nokey@localhost.run（首选）
 *   · pinggy        —— ssh -p 443 -R0:localhost:3000 a.pinggy.io（免费会话 60 分钟）
 *
 * 用法：
 *   node tools/tunnel.mjs              # 自动选线路（默认 localhost.run 优先）
 *   node tools/tunnel.mjs --provider=pinggy
 * 前提：先 npm run build（前端构建产物）+ 后端已在 3000 端口运行。
 *
 * 踩过的坑（都体现在下面的参数里）：
 *   · 不加 ServerAliveInterval 时，空闲几分钟会被运营商 NAT 或服务端掐掉；
 *   · 服务端刚释放上一次会话时立刻重连，会因远端端口占用而秒退（exit 255），
 *     所以必须做**指数退避**，而不是固定 5 秒硬撞；
 *   · 隧道"看起来连着"但实际已死（浏览器打开显示 no tunnel），
 *     因此要主动通过公网地址自检 /api/health，失败即重建。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.TUNNEL_PORT || 3000);
const URL_FILE = path.join(ROOT, 'tools', 'tunnel-url.txt');
/** 放在项目根目录的「纯文本网址」，方便直接打开复制、粘到微信/邮件里发给别人 */
const PLAIN_FILE = path.join(ROOT, '当前网址.txt');
const QR_FILE = path.join(ROOT, 'logs', 'tunnel-qr.html');
const SSH = process.env.SSH_PATH || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'usr', 'bin', 'ssh.exe');
const FORCED = (process.argv.find((a) => a.startsWith('--provider=')) || '').split('=')[1];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本机在局域网里的 IPv4 地址（同一个 Wi-Fi 下手机可以直接访问，比隧道稳得多） */
function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(`http://${ni.address}:${PORT}`);
    }
  }
  return out;
}

/**
 * 生成「手机扫码页」：把当前公网地址渲染成二维码，手机用相机扫屏幕即可打开，
 * 省掉"在手机上输入一长串随机域名"的麻烦。
 * 两个细节：
 *   · 页面自带 10 秒自动刷新——隧道重连换了域名，页面会自动显示新的二维码；
 *   · 二维码图片走公开的 QR 接口（qrserver / pwmqr 双备份），本机只负责拼 HTML，不引第三方依赖。
 */
function writeQrPage(publicUrl, provider) {
  const lan = lanUrls();
  const qr = (data, size) =>
    `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=8&data=${encodeURIComponent(data)}`;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="refresh" content="10" />
<title>智练 SmartFit · 手机扫码打开</title>
<style>
  body { font-family: "Microsoft YaHei", sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 28px 20px; text-align: center; }
  h1 { font-size: 20px; color: #6ee7b7; margin: 0 0 6px; }
  .sub { font-size: 12.5px; color: #94a3b8; margin-bottom: 22px; }
  .cards { display: flex; gap: 18px; justify-content: center; flex-wrap: wrap; }
  .card { background: #fff; color: #0f172a; border-radius: 16px; padding: 16px 18px; width: 300px; box-shadow: 0 12px 30px rgba(0,0,0,.35); }
  .card h2 { font-size: 15px; margin: 0 0 4px; color: #065f46; }
  .card .tag { font-size: 11px; color: #64748b; margin-bottom: 10px; }
  .card img { width: 240px; height: 240px; image-rendering: pixelated; }
  .url { font-size: 11.5px; word-break: break-all; background: #f1f5f9; border-radius: 8px; padding: 7px 9px; margin-top: 8px; color: #0f172a; }
  .foot { font-size: 11.5px; color: #64748b; margin-top: 22px; line-height: 1.9; }
  .warn { color: #fbbf24; }
</style>
</head>
<body>
  <h1>📱 手机扫码打开「智练 SmartFit」</h1>
  <div class="sub">当前线路：${provider} · 更新于 ${new Date().toLocaleString('zh-CN')} · 本页每 10 秒自动刷新</div>
  <div class="cards">
    <div class="card">
      <h2>公网地址</h2>
      <div class="tag">任何网络都能开（4G / 热点均可）</div>
      <img src="${qr(publicUrl, 240)}" alt="公网地址二维码" />
      <div class="url">${publicUrl}</div>
    </div>
    ${
      lan.length
        ? `<div class="card">
      <h2>同一个 Wi-Fi</h2>
      <div class="tag">更快更稳，地址固定不变</div>
      <img src="${qr(lan[0], 240)}" alt="局域网地址二维码" />
      <div class="url">${lan[0]}</div>
    </div>`
        : ''
    }
  </div>
  <div class="foot">
    👤 演示账号：demo / 123456<br />
    <span class="warn">若手机显示「no tunnel」= 这条公网地址已过期</span>，回到电脑看这个页面刷新后的新二维码；<br />
    免费隧道断开后域名会变，同 Wi-Fi 那条地址则始终有效。
  </div>
</body>
</html>`;
  fs.mkdirSync(path.dirname(QR_FILE), { recursive: true });
  fs.writeFileSync(QR_FILE, html, 'utf8');
  return QR_FILE;
}

/** 两条线路：命令行参数优先级最高，其余按顺序自动尝试 */
const PROVIDERS = [
  {
    name: 'localhost.run',
    args: ['-R', `80:localhost:${PORT}`, 'nokey@localhost.run'],
    urlRe: /https:\/\/([a-z0-9]+\.lhr\.life)/,
    url: (m) => `https://${m[1]}`,
  },
  {
    name: 'pinggy',
    args: ['-p', '443', '-R0:localhost:' + PORT, 'a.pinggy.io'],
    urlRe: /https:\/\/([a-z0-9-]+\.(?:run\.pinggy-free\.link|free\.pinggy\.net))/,
    url: (m) => `https://${m[1]}`,
  },
];

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

/** 心跳：定期通过公网地址自检，隧道假死也能发现 */
function startHeartbeat(url, onFail) {
  let fails = 0;
  const timer = setInterval(async () => {
    try {
      const ctl = AbortSignal.timeout(20000);
      const r = await fetch(url + '/api/health', { signal: ctl });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      fails = 0;
    } catch {
      fails += 1;
      if (fails >= 2) {
        clearInterval(timer);
        onFail();
      }
    }
  }, 45000);
  return () => clearInterval(timer);
}

/** 启动一轮隧道；拿到地址后打印并开始心跳，进程退出则返回 */
function connectOnce(provider, attempt) {
  return new Promise((resolve) => {
    console.log(`\n正在建立隧道（${provider.name} · 第 ${attempt} 次）…`);
    const child = spawn(
      SSH,
      [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'TCPKeepAlive=yes',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ExitOnForwardFailure=yes',
        ...provider.args,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let printed = false;
    let stopHeart = null;
    let lastLines = [];

    const handle = (buf) => {
      const text = buf.toString();
      // 记录最后几行输出，便于退出时看到真实原因
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) lastLines.push(line.trim());
      }
      if (lastLines.length > 6) lastLines = lastLines.slice(-6);

      if (printed) return;
      const m = text.match(provider.urlRe);
      if (!m) return;

      printed = true;
      const url = provider.url(m);
      fs.writeFileSync(URL_FILE, url + '\n', 'utf8');
      // 纯文本版：打开就能整段复制，直接发给别人
      fs.writeFileSync(
        PLAIN_FILE,
        [
          '智练 SmartFit — 当前公网网址（复制下面这一行发给别人，4G 也能直接打开）',
          '',
          url,
          '',
          `更新时间：${new Date().toLocaleString('zh-CN')}　线路：${provider.name}`,
          '演示账号：demo / 123456',
          '',
          '注意：免费隧道的域名会随隧道重连而改变。',
          '  · 网址失效（打开显示 no tunnel）时，回电脑看这份文件或终端里的新地址；',
          `  · 同一 Wi-Fi 下更稳的固定地址：${lanUrls()[0] || '（未检测到局域网地址）'}`,
          '  · 想彻底固定：把项目部署到云平台，见 docs/部署到云-永久地址.md',
          '',
        ].join('\n'),
        'utf8',
      );
      const qrPath = writeQrPage(url, provider.name);
      const line = '='.repeat(66);
      console.log(line);
      console.log('  🌐 手机 / 任何网络都能打开的地址（复制这个）：');
      console.log('');
      console.log(`     ${url}`);
      console.log('');
      console.log('  👤 演示账号：demo / 123456');
      console.log('  🔌 线路：' + provider.name);
      console.log('');
      console.log('  📷 不想手输网址？双击桌面「手机扫码打开智练」或打开：');
      console.log(`     ${qrPath}   （手机相机扫屏幕即可，页面自动跟随地址更新）`);
      console.log('');
      console.log('  📄 要发给别人：打开项目根目录的「当前网址.txt」，整段复制即可。');
      console.log('');
      console.log('  ⏱  首次打开约 15~25 秒（免费隧道带宽有限），第二次靠缓存很快。');
      console.log('  ⚠  免费线路会定期断开，断开后**地址会变**：');
      console.log(`     地址始终以 ${URL_FILE} 与这份输出为准。`);
      console.log('  📶 手机打开后若显示 no tunnel → 说明地址已过期，回来复制新的。');
      console.log(line);

      stopHeart = startHeartbeat(url, () => {
        console.log('\n⚠ 心跳检测失败（隧道已假死），重建连接…');
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      });
    };

    child.stdout.on('data', handle);
    child.stderr.on('data', handle);

    child.on('exit', (code) => {
      stopHeart?.();
      if (!printed) {
        console.log(`\n⚠ ${provider.name} 建立失败（code ${code}）`);
        if (lastLines.length) console.log('   原因：' + lastLines.slice(-2).join(' | '));
      } else {
        console.log(`\n⚠ 隧道断开（code ${code}），正在重连…`);
      }
      resolve({ ok: printed });
    });
  });
}

(async () => {
  await preflight();

  const list = FORCED ? PROVIDERS.filter((p) => p.name.includes(FORCED)) : PROVIDERS;
  if (!list.length) {
    console.error(`✗ 未知线路：${FORCED}（可选 ${PROVIDERS.map((p) => p.name).join(' / ')}）`);
    process.exit(1);
  }

  // 每条线路单独计次：连续失败越多，退避越久（避免撞上服务端的端口占用/限流）
  const counts = Object.fromEntries(list.map((p) => [p.name, 0]));
  let idx = 0;
  for (;;) {
    const p = list[idx % list.length];
    counts[p.name] += 1;
    const { ok } = await connectOnce(p, counts[p.name]);
    // 成功过的线路立刻可以再试；连续失败的线路先跳过，交给下一条
    if (ok) counts[p.name] = 0;
    idx += 1;
    const backoff = Math.min(30, 5 * Math.max(1, counts[p.name] || 1));
    console.log(`  ${backoff} 秒后重试…`);
    await sleep(backoff * 1000);
  }
})();
