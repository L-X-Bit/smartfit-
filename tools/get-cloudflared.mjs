/**
 * 下载 cloudflared（Cloudflare 隧道客户端）
 * ---------------------------------------------------------------------------
 * 用途：把本机 http://localhost:5173 映射成一个公网 HTTPS 域名（*.trycloudflare.com），
 *      手机用 4G/5G 或任何网络都能直接打开，不需要同网段、热点或数据线。
 * 特点：无需注册账号、无需 Token，命令行一条即可；关掉进程隧道立即失效。
 *
 * 网络说明：本机直连 github.com 经常握手超时，因此按「官方 → 国内镜像」顺序重试。
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'tools', 'bin', 'cloudflared.exe');
const FILE = 'cloudflared-windows-amd64.exe';

const MIRRORS = [
  `https://github.com/cloudflare/cloudflared/releases/latest/download/${FILE}`,
  `https://mirror.nju.edu.cn/github-release/cloudflare/cloudflared/LatestRelease/${FILE}`,
  `https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/${FILE}`,
  `https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/${FILE}`,
  `https://cdn.jsdelivr.net/gh/cloudflare/cloudflared@latest/${FILE}`,
];

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('重定向过多'));
    const req = https.get(url, { timeout: 90000, headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        return download(next, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const total = Number(res.headers['content-length'] || 0);
      let got = 0;
      let last = 0;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        got += c.length;
        const now = Date.now();
        if (now - last > 4000) {
          last = now;
          console.log(`   ... ${(got / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)}MB`);
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(got)));
      out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
  });
}

(async () => {
  if (fs.existsSync(OUT) && fs.statSync(OUT).size > 20 * 1048576) {
    console.log('✓ cloudflared 已存在，跳过下载:', OUT);
    return;
  }
  for (const url of MIRRORS) {
    const host = new URL(url).host;
    console.log(`尝试下载 (${host}) ...`);
    try {
      const size = await download(url, OUT);
      if (size < 20 * 1048576) throw new Error(`文件过小 ${(size / 1048576).toFixed(1)}MB`);
      console.log(`✓ 下载完成: ${OUT} (${(size / 1048576).toFixed(1)}MB)`);
      return;
    } catch (e) {
      console.log(`  ✗ ${e.message}`);
      try { if (fs.existsSync(OUT)) fs.unlinkSync(OUT); } catch {}
    }
  }
  console.error('✗ 所有镜像均下载失败');
  process.exit(1);
})();
