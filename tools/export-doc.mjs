/**
 * 一份文档出两种格式：Markdown → PDF（打印用）+ Word .docx（改稿用）
 * ===========================================================================
 * 为什么要它：
 *   《功能详解与演讲稿》是给录制同学看的，他要打印、要批注、要发给不用 VSCode 的人，
 *   光有 .md 不方便。这里一次生成 PDF 与 docx，样式保持和项目一致（品牌绿 + 灰底引用块）。
 *
 * 用法：
 *   node tools/export-doc.mjs                                   # 默认导出 docs/功能详解与演讲稿.md
 *   node tools/export-doc.mjs docs/演示视频讲解稿.md            # 指定文件
 *   node tools/export-doc.mjs docs/xxx.md --pdf-only            # 只出 PDF
 *
 * 依赖（本机已确认可用）：
 *   · python + markdown        → Markdown 转 HTML 片段
 *   · python + python-docx     → 生成 .docx
 *   · Microsoft Edge 无头模式   → HTML 打印成 PDF（项目里不引 300MB 的 Chromium）
 *
 * 踩过的坑：
 *   · Edge 打印必须加 --virtual-time-budget，否则样式还没应用就开始打，会出现空白页；
 *   · 必须加 --no-pdf-header-footer，否则每页底部多出网址和日期；
 *   · Windows 下 python 打印中文要设 PYTHONIOENCODING=utf-8，否则控制台报编码错。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PYTHON = process.env.PYTHON_PATH || 'python';

const args = process.argv.slice(2);
const PDF_ONLY = args.includes('--pdf-only');
const DOCX_ONLY = args.includes('--docx-only');
const mdArg = args.find((a) => !a.startsWith('-'));
const MD = mdArg ? path.resolve(ROOT, mdArg) : path.join(ROOT, 'docs', '功能详解与演讲稿.md');

if (!fs.existsSync(MD)) {
  console.error(`✗ 找不到文档：${MD}`);
  process.exit(1);
}
const base = MD.replace(/\.md$/i, '');
const HTML = `${base}.print.html`;
const PDF = `${base}.pdf`;
const DOCX = `${base}.docx`;
const TITLE = path.basename(base);

/** 打印样式：A4、微软雅黑、表格/引用/代码块都按纸质文档调过 */
const CSS = `
  @page { size: A4; margin: 16mm 14mm 16mm 14mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif;
    font-size: 10.5pt; line-height: 1.62; color: #1f2a37; margin: 0;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  h1 { font-size: 19pt; color: #0f9d58; margin: 0 0 10px; padding-bottom: 8px; border-bottom: 2px solid #d1fae5; break-after: avoid; }
  h2 { font-size: 14.5pt; color: #0f9d58; margin: 22px 0 8px; padding-left: 9px; border-left: 4px solid #0f9d58; break-after: avoid; }
  h3 { font-size: 12pt; color: #1f2a37; margin: 16px 0 6px; break-after: avoid; }
  h4 { font-size: 11pt; color: #334155; margin: 12px 0 4px; break-after: avoid; }
  p { margin: 6px 0; }
  strong { color: #0b1220; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 14px 0; }
  ul, ol { margin: 6px 0 6px 4px; padding-left: 18px; }
  li { margin: 3px 0; }
  blockquote {
    margin: 8px 0; padding: 8px 12px; background: #f8fafc;
    border-left: 3px solid #10b981; color: #475569; font-size: 10pt;
    break-inside: avoid;
  }
  blockquote p { margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 12px; font-size: 9pt; break-inside: auto; }
  th, td { border: 1px solid #cbd5e1; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #eef6f1; font-weight: 700; }
  tr { break-inside: avoid; }
  tbody tr:nth-child(even) td { background: #fbfdfc; }
  code {
    font-family: Consolas, "Courier New", monospace; font-size: 9pt;
    background: #f1f5f9; color: #be123c; padding: 1px 4px; border-radius: 3px;
  }
  pre {
    background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px;
    padding: 9px 11px; overflow: visible; break-inside: avoid;
  }
  pre code { background: none; color: #334155; padding: 0; font-size: 8.5pt; line-height: 1.45; }
  a { color: #1d4ed8; text-decoration: none; }
`;

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} 退出码 ${code}\n${err || out}`))));
  });
}

const pyEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' };

// ---------------------------------------------------------------- 1. Markdown → HTML
const fragmentPath = path.join(path.dirname(MD), `.${path.basename(base)}.fragment.html`);
await run(PYTHON, [path.join(ROOT, 'tools', 'md2html.py'), MD, fragmentPath], { env: pyEnv });
const fragment = fs.readFileSync(fragmentPath, 'utf-8');
fs.writeFileSync(HTML, `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${TITLE}</title>
<style>${CSS}</style>
</head>
<body>
${fragment}
</body>
</html>
`, 'utf-8');
fs.rmSync(fragmentPath, { force: true });
console.log(`✓ HTML 排版稿：${path.relative(ROOT, HTML)}`);

// ---------------------------------------------------------------- 2. HTML → PDF
if (!DOCX_ONLY) {
  await run(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-pdf-header-footer',
    '--virtual-time-budget=8000',
    `--print-to-pdf=${PDF}`,
    'file:///' + HTML.replace(/\\/g, '/'),
  ]);
  const pdfBuf = fs.readFileSync(PDF);
  // 页数：数 PDF 里的 /Type /Page 对象（排除 /Pages 目录节点）
  const pageCount = (pdfBuf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  console.log(`✓ PDF：${path.relative(ROOT, PDF)}（${(pdfBuf.length / 1024 / 1024).toFixed(2)} MB，约 ${pageCount} 页）`);
}

// ---------------------------------------------------------------- 3. Markdown → Word
if (!PDF_ONLY) {
  await run(PYTHON, [path.join(ROOT, 'tools', 'md2docx.py'), MD, DOCX], { env: pyEnv });
  const size = fs.statSync(DOCX).size;
  console.log(`✓ Word：${path.relative(ROOT, DOCX)}（${(size / 1024).toFixed(0)} KB）`);
}
