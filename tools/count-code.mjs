/**
 * 统计源码规模（技术文档 1.1 里的数字必须是真实统计出来的，不能拍脑袋）
 * 用法：node tools/count-code.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 递归收集源码文件 */
function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'data', 'uploads'].includes(entry.name)) continue;
      walk(full, exts, out);
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 统计总行 / 注释行 / 空行
 * ---------------------------------------------------------------------------
 * 需要区分两种块注释的结束符：JS/CSS 的块注释以 `*\/` 结束，HTML/Vue 模板注释以 `-->` 结束。
 * 踩过的坑：第一版统一只找 `*\/`，于是 .vue 文件顶部的 `<!-- ... -->` 注释块一直"没结束"，
 * 把后面几百行代码全算成注释（注释率虚高到 26%）。这里用两种状态分别判断。
 */
function analyze(files) {
  let total = 0;
  let comment = 0;
  let blank = 0;
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    /** null = 不在块注释内；'js' = /* *\/；'html' = <!-- --> */
    let block = null;
    for (const raw of lines) {
      const line = raw.trim();
      total += 1;
      if (!line) {
        blank += 1;
        continue;
      }
      if (block) {
        comment += 1;
        if (block === 'js' && line.includes('*/')) block = null;
        if (block === 'html' && line.includes('-->')) block = null;
        continue;
      }
      if (line.startsWith('/*')) {
        comment += 1;
        if (!line.includes('*/')) block = 'js';
        continue;
      }
      if (line.startsWith('<!--')) {
        comment += 1;
        if (!line.includes('-->')) block = 'html';
        continue;
      }
      if (line.startsWith('//') || line.startsWith('*') || line.startsWith('--')) {
        comment += 1;
      }
    }
  }
  return { files: files.length, total, comment, blank };
}

const groups = [
  ['后端 server/src', walk(path.join(ROOT, 'server', 'src'), ['.js', '.sql'])],
  ['前端 web/src', walk(path.join(ROOT, 'web', 'src'), ['.js', '.vue', '.css'])],
];
let sum = { files: 0, total: 0, comment: 0, blank: 0 };
for (const [name, files] of groups) {
  const r = analyze(files);
  sum = { files: sum.files + r.files, total: sum.total + r.total, comment: sum.comment + r.comment, blank: sum.blank + r.blank };
  console.log(`${name.padEnd(16)} 文件 ${String(r.files).padStart(3)}  总行 ${String(r.total).padStart(5)}  注释 ${String(r.comment).padStart(4)}  空行 ${String(r.blank).padStart(4)}`);
}
const pct = ((sum.comment / sum.total) * 100).toFixed(1);
console.log(`${'合计'.padEnd(16)} 文件 ${String(sum.files).padStart(3)}  总行 ${String(sum.total).padStart(5)}  注释 ${String(sum.comment).padStart(4)}  空行 ${String(sum.blank).padStart(4)}  注释率 ${pct}%`);
