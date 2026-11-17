/**
 * 食物库增量同步（不重建数据库）
 * ===========================================================================
 * 用法：
 *   node tools/sync-foods.mjs            # 把 foods.json + foods.extra.json 里的食物 upsert 进现有数据库
 *   node tools/sync-foods.mjs --dry      # 只看会新增/更新多少条，不写库
 *
 * 为什么需要它：
 *   `npm run init:db` 会重建整个数据库（把演示数据也一起重置）。省赛前扩充食物库时，
 *   我们希望**只补食物**、不动用户数据，所以这里用 INSERT OR REPLACE 做增量 upsert，
 *   并顺手刷新 RAG 内存索引（否则检索还在用旧词表）。
 *
 * 与 seed.js 的关系：
 *   seed.js 负责「从零建库」，本脚本负责「已有库的增量升级」，两者读同一批 JSON 文件，
 *   保证新克隆的仓库和已有环境最终一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KB = path.join(ROOT, 'server', 'data', 'kb');
const mod = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

const { initSchema, run, get, all } = await import(mod('server/src/db/index.js'));
const { resetIndexes } = await import(mod('server/src/ai/rag.js'));

const dry = process.argv.includes('--dry');

const readJson = (file) => {
  const p = path.join(KB, file);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8'));
};

initSchema();

const base = readJson('foods.json');
const extra = readJson('foods.extra.json');
const foodAliases = readJson('food-aliases.json', {});
const merged = [...base, ...extra.filter((f) => !base.some((b) => b.id === f.id))].map((f) => ({
  ...f,
  aliases: [...new Set([...(Array.isArray(f.aliases) ? f.aliases : []), ...(foodAliases[f.id] || [])])],
}));

const before = get('SELECT COUNT(*) AS c FROM foods').c;
const existing = new Map(all('SELECT id, name FROM foods').map((r) => [r.id, r.name]));

// 数据完整性检查：id 唯一、必填字段存在、三大营养素与热量大致自洽（4/9/4 估算偏差 ≤35%）
// 例外：含酒精的食物不能用 4/9/4 估算（乙醇 7 kcal/g 且不计入三大营养素），单独放行。
const ALCOHOL_IDS = new Set(['fd_beer', 'fd_x_beer', 'fd_wine', 'fd_x_wine', 'fd_baijiu', 'fd_x_cooking_wine']);
const problems = [];
const seen = new Set();
for (const f of merged) {
  if (!f.id || !f.name) problems.push(`缺少 id 或 name：${JSON.stringify(f).slice(0, 60)}`);
  if (seen.has(f.id)) problems.push(`id 重复：${f.id}`);
  seen.add(f.id);
  for (const k of ['kcal', 'protein', 'fat', 'carb']) {
    if (!Number.isFinite(Number(f[k]))) problems.push(`${f.id} 的 ${k} 不是数字`);
  }
  if (ALCOHOL_IDS.has(f.id)) continue;
  const est = Number(f.protein) * 4 + Number(f.fat) * 9 + Number(f.carb) * 4;
  if (Number(f.kcal) > 20 && est > 0) {
    const dev = Math.abs(est - Number(f.kcal)) / Number(f.kcal);
    if (dev > 0.35) problems.push(`${f.id}（${f.name}）热量与三大营养素不自洽：${f.kcal}kcal vs 换算 ${est.toFixed(0)}kcal（偏差 ${(dev * 100).toFixed(0)}%）`);
  }
}
if (problems.length) {
  console.log(`⚠ 数据检查发现 ${problems.length} 个问题：`);
  problems.slice(0, 20).forEach((p) => console.log('  · ' + p));
  if (!dry) {
    console.log('已中止写库，请先修正上述问题（或加 --dry 只查看）。');
    process.exit(1);
  }
}

const toInsert = merged.filter((f) => !existing.has(f.id));
const toUpdate = merged.filter((f) => existing.has(f.id));

console.log(`现有食物 ${before} 条；待处理 ${merged.length} 条（新增 ${toInsert.length} / 更新 ${toUpdate.length}）`);
if (dry) {
  console.log('（--dry 模式，不写库）');
  process.exit(0);
}

let inserted = 0;
let updated = 0;
for (const f of merged) {
  const aliases = Array.isArray(f.aliases) ? f.aliases : [];
  const isNew = !existing.has(f.id);
  run(
    `INSERT INTO foods (id, name, category, kcal, protein, fat, carb, fiber, sodium, portion, aliases, search_text)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, category=excluded.category, kcal=excluded.kcal, protein=excluded.protein,
       fat=excluded.fat, carb=excluded.carb, fiber=excluded.fiber, sodium=excluded.sodium,
       portion=excluded.portion, aliases=excluded.aliases, search_text=excluded.search_text`,
    [f.id, f.name, f.category, f.kcal, f.protein, f.fat, f.carb, f.fiber, f.sodium, f.portion, JSON.stringify(aliases), `${f.name} ${f.category} ${aliases.join(' ')}`],
  );
  if (isNew) inserted += 1;
  else updated += 1;
}

/**
 * 清理历史遗留的扩展条目：之前用「未去重」的 foods.extra.json 写过一批重复食物
 * （id 以 fd_x_ 开头）。现在合并规则变了，这些 id 可能已经不在最新语料里，
 * 会把它们删掉——但**只在没有任何饮食记录引用它时才删**，否则保留并提示，
 * 避免破坏用户既有饮食数据。
 */
const keepIds = new Set(merged.map((f) => f.id));
const stale = all("SELECT id, name FROM foods WHERE id LIKE 'fd_x_%'").filter((r) => !keepIds.has(r.id));
let removed = 0;
let keptForRefs = 0;
for (const s of stale) {
  const refs = get('SELECT COUNT(*) AS c FROM diet_logs WHERE food_id = ?', [s.id]).c;
  if (refs > 0) {
    keptForRefs += 1;
    continue;
  }
  run('DELETE FROM foods WHERE id = ?', [s.id]);
  removed += 1;
}
if (stale.length) console.log(`清理过期条目：删除 ${removed} 条${keptForRefs ? `，因被饮食记录引用而保留 ${keptForRefs} 条` : ''}`);

resetIndexes(); // 让 BM25 立刻用上新语料

const after = get('SELECT COUNT(*) AS c FROM foods').c;
const aliasCount = get("SELECT COUNT(*) AS c FROM foods WHERE aliases IS NOT NULL AND aliases != '[]'").c;
console.log(`✓ 食物库同步完成：${before} → ${after} 条（新增 ${inserted}，更新 ${updated}，其中带别名 ${aliasCount} 条）`);
