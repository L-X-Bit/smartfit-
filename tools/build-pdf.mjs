/**
 * 技术文档 PDF 导出脚本
 * ===========================================================================
 * 把 docs/技术文档.html 用 Edge 无头模式打印成 A4 PDF，并统计页数（比赛要求 ≤30 页）。
 *
 * 用法：node tools/build-pdf.mjs
 *
 * 为什么用 Edge 打印而不是 puppeteer：
 *   项目里不想为了导出一份 PDF 引入 300MB 的 Chromium 依赖，
 *   Edge 自带 --print-to-pdf，配合 HTML 里的 @page 规则就能得到和浏览器完全一致的版面。
 * 踩过的坑：
 *   · 必须加 --virtual-time-budget，否则图片还没加载完就开始打印，插图会空白；
 *   · 必须加 --no-pdf-header-footer，否则每页会多出页眉页脚的网址和日期。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const HTML = path.join(ROOT, 'docs', '技术文档.html');
const PDF = path.join(ROOT, 'docs', '智练SmartFit-技术文档.pdf');
const LIMIT = 30; // 比赛要求：技术文档不超过 30 页

if (!fs.existsSync(HTML)) {
  console.error('✗ 找不到 docs/技术文档.html');
  process.exit(1);
}

const fileUrl = 'file:///' + HTML.replace(/\\/g, '/');

/**
 * 先删掉旧 PDF：否则 Edge 一旦失败（退出码非 0，比如 0x80000003 STATUS_BREAKPOINT），
 * 目录里躺着的还是上一次的旧文件，脚本只判断「文件存在」就会误报成功。
 */
if (fs.existsSync(PDF)) fs.rmSync(PDF, { force: true });

console.log('正在导出 PDF…');
const code = await new Promise((resolve) => {
  const p = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-pdf-header-footer',
    '--virtual-time-budget=15000',
    // 复用已运行的 Edge 进程会直接失败，单独指定用户数据目录避免冲突
    `--user-data-dir=${os.tmpdir()}\\smartfit-pdf-profile`,
    '--no-first-run',
    '--disable-crash-reporter',
    `--print-to-pdf=${PDF}`,
    fileUrl,
  ], { stdio: 'ignore' });
  p.on('error', (err) => {
    console.error(`✗ 启动 Edge 失败：${err.message}`);
    resolve(-1);
  });
  p.on('exit', resolve);
});

if (!fs.existsSync(PDF)) {
  console.error(`✗ 没有生成 PDF（Edge 退出码 ${code}）——请确认 msedge.exe 路径，或先关闭正在运行的 Edge`);
  process.exit(1);
}
if (code !== 0) {
  console.error(`✗ Edge 退出码 ${code}，生成的 PDF 可能不完整，请重跑一次`);
  process.exit(1);
}

/** 统计页数：Edge 生成的 PDF 未压缩对象结构，直接数 /Type /Page 即可 */
const raw = fs.readFileSync(PDF, 'latin1');
const pages = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length;
const kb = (fs.statSync(PDF).size / 1024 / 1024).toFixed(2);
console.log(`✓ ${path.relative(ROOT, PDF)}　${pages} 页　${kb} MB`);
if (pages > LIMIT) {
  console.error(`✗ 超过 ${LIMIT} 页限制，需要压缩版面（字号/行距/图片高度）`);
  process.exit(1);
}
console.log(`✓ 页数在 ${LIMIT} 页限制内（余量 ${LIMIT - pages} 页）`);
