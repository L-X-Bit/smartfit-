/**
 * 拍照识热量「回放」验证脚本
 * ===========================================================================
 * 用法：node tools/test-vision-replay.mjs [图片路径] [用户名] [密码]
 *   不带图片路径时，自动取 server/uploads 下最新的一张照片（通常就是刚扫过的那张）。
 *
 * 作用：把一张真实照片重新走一遍「视觉模型 → 食物库匹配 → 双源交叉校验」全链路，
 *      并把每个食材的**数据来源**打印出来，用来验收匹配逻辑：
 *        source=library  → 命中食物库，热量按库值重算（可信）
 *        source=model    → 未命中或库值冲突被弃用，热量用模型估算
 *      conflict=true 表示「命中但库值相差 3 倍以上，已弃用库值」。
 *
 * 为什么需要它：手机上点一次识别要 2~3 秒且要真金白银调一次大模型，
 * 调匹配规则时不能每次都靠手点，所以把真实照片存下来做回归回放。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const API = process.env.API_URL || 'http://127.0.0.1:3000';

const args = process.argv.slice(2);
const uploadDir = path.join(ROOT, 'server', 'uploads');

/** 找到要回放的照片：命令行指定 > uploads 目录最新一张 */
function pickImage() {
  if (args[0]) return path.resolve(args[0]);
  const files = fs
    .readdirSync(uploadDir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(uploadDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) throw new Error('server/uploads 里没有图片，请手动指定一张');
  return path.join(uploadDir, files[0].f);
}

const imagePath = pickImage();
const username = args[1] || 'demo';
const password = args[2] || '123456';

/** 统一请求封装：后端约定 { code, message, data } */
async function call(method, url, body, token) {
  const res = await fetch(API + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (json.code !== 0) throw new Error(`${method} ${url} → ${res.status} ${json.message || ''}`);
  return json.data;
}

const t0 = Date.now();
const { token } = await call('POST', '/api/auth/login', { username, password });
console.log(`✓ 登录 ${username}`);

// 图片转 dataURL（与前端 canvas 压缩后的形态一致：image/jpeg;base64,...）
const mime = /\.png$/i.test(imagePath) ? 'image/png' : 'image/jpeg';
const dataUrl = `data:${mime};base64,${fs.readFileSync(imagePath).toString('base64')}`;
console.log(`✓ 回放照片：${path.basename(imagePath)}（${(dataUrl.length / 1024).toFixed(0)} KB base64）`);
console.log('  识别中（要真实调用一次视觉模型，约 3~10 秒）…\n');

const r = await call('POST', '/api/food-scan/analyze', { imageDataUrl: dataUrl }, token);

console.log(`场景：${r.scene || '-'}`);
console.log(`参照物：${r.referenceObject || '无'}（尺度可信度 ${r.scaleConfidence || '-'}）`);
console.log(`总共 ${r.items.length} 项，库匹配 ${r.meta.matchedCount}/${r.meta.totalItems}（${r.meta.libraryRatio}%），耗时 ${(r.meta.latencyMs / 1000).toFixed(1)}s\n`);

const pad = (s, n) => String(s ?? '').padEnd(n, ' ');
console.log(pad('食材', 16), pad('克数', 7), pad('kcal', 7), pad('来源', 10), '说明');
console.log('-'.repeat(96));
let conflicts = 0;
for (const it of r.items) {
  const from = it.source === 'library' ? '库内精确' : '模型估算';
  let note = it.libraryName ? `库：${it.libraryName}` : it.libraryCandidate ? `候选「${it.libraryCandidate}」已弃用（差 ${it.conflictRatio ?? '?'} 倍）` : '食物库未收录';
  if (it.conflict) {
    conflicts += 1;
    note = `⚠ ${note}；库值 ${it.conflictLibKcal ?? '?'} kcal vs 估算 ${it.modelKcal} kcal`;
  }
  console.log(pad(it.name, 16), pad(it.amountG + 'g', 7), pad(it.kcal, 7), pad(from, 10), note);
}
console.log('-'.repeat(96));
const t = r.totals;
console.log(`合计：${t.kcal} kcal　蛋白 ${t.protein}g　脂肪 ${t.fat}g　碳水 ${t.carb}g`);
console.log(`库匹配率 ${r.meta.libraryRatio}%　冲突弃用 ${conflicts} 项　总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`建议：${r.advice || '-'}`);
