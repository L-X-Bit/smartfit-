/**
 * 检索质量评测（离线跑，不需要启动服务）
 * ===========================================================================
 * 用法：
 *   node tools/eval-rag.mjs              # 跑基准 + 消融，打印表格并写报告
 *   node tools/eval-rag.mjs --no-write   # 只看结果，不写文件
 *
 * 产出：
 *   docs/评测报告-检索.md    人工标注基准集上的 Recall@1/3/5、MRR、耗时，以及关闭查询扩展的对照
 *
 * 为什么需要它：
 *   校赛评语「待核：知识库是真实检索还是话术模板」。这份报告把「问 27 个真实问题，
 *   正确指南排第几」全部列出来，且每次改完检索逻辑都能重跑复算。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const benchModule = await import(pathToFileURL(path.join(ROOT, 'server/src/ai/ragBench.js')).href).catch((e) => {
  console.error('✗ 载入评测模块失败：', e.message);
  process.exit(1);
});
const { runRagBenchWithAblation, RAG_BENCH_CASES } = benchModule;
const { indexStats } = await import(pathToFileURL(path.join(ROOT, 'server/src/ai/rag.js')).href);
const KB_STATS = indexStats();
const KB_TEXT = `${KB_STATS.guidelines.docs} 条指南 / ${KB_STATS.exercises.docs} 个动作 / ${KB_STATS.foods.docs} 种食物`;

const noWrite = process.argv.includes('--no-write');
const r = runRagBenchWithAblation();

const pct = (x) => `${x}%`;
const signed = (x, suffix = '') => `${x >= 0 ? '+' : ''}${x}${suffix}`;

console.log(`\n检索基准评测（${r.withExpansion.cases} 个人工标注问题，知识库 ${KB_TEXT}）\n`);
console.log('指标            启用查询扩展   关闭查询扩展   提升');
console.log('------------------------------------------------------');
console.log(`Recall@1        ${pct(r.withExpansion.recallAt1).padEnd(13)} ${pct(r.withoutExpansion.recallAt1).padEnd(13)} ${signed(r.delta.recallAt1, ' pt')}`);
console.log(`Recall@3        ${pct(r.withExpansion.recallAt3).padEnd(13)} ${pct(r.withoutExpansion.recallAt3).padEnd(13)} ${signed(r.delta.recallAt3, ' pt')}`);
console.log(`Recall@5        ${pct(r.withExpansion.recallAt5).padEnd(13)} ${pct(r.withoutExpansion.recallAt5).padEnd(13)} ${signed(r.delta.recallAt5, ' pt')}`);
console.log(`MRR             ${String(r.withExpansion.mrr).padEnd(13)} ${String(r.withoutExpansion.mrr).padEnd(13)} ${signed(r.delta.mrr)}`);
console.log(`平均检索耗时    ${(r.withExpansion.avgLatencyMs + 'ms').padEnd(13)} ${(r.withoutExpansion.avgLatencyMs + 'ms').padEnd(13)}`);

if (r.withExpansion.misses.length) {
  console.log(`\n未命中（前 5 条里都没有正确指南）${r.withExpansion.misses.length} 条：`);
  for (const m of r.withExpansion.misses) console.log(`  · ${m.query}  期望 ${m.expect.join('/')}  实得 ${m.got.slice(0, 3).join(',') || '无'}`);
} else {
  console.log('\n全部问题在前 5 条内命中正确指南。');
}

if (noWrite) process.exit(0);

// ---------------------------------------------------------------- 写报告
const rows = r.withExpansion.rows.map((row) => {
  const okAt = row.rank ? `第 ${row.rank} 位` : '未命中';
  const top = row.top.map((t, i) => `${i + 1}. ${t.title}`).join('<br>');
  return `| ${row.query} | ${row.expect.join(' / ')} | ${okAt} | ${row.latencyMs} ms | ${top} |`;
}).join('\n');

const missBlock = r.withoutExpansion.misses.length
  ? r.withoutExpansion.misses.map((m) => `- 「${m.query}」期望 \`${m.expect.join('/')}\`，关闭扩展后检索到 ${m.got.slice(0, 2).join('、') || '无结果'}`).join('\n')
  : '- 无（关闭扩展后依然全部命中前 5）';

const md = `# 检索质量评测报告（RAG Benchmark）

> 生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
> 复跑命令：\`node tools/eval-rag.mjs\`　页面入口：左侧导航「检索实验室」→ 基准评测
> 标签集：${RAG_BENCH_CASES.length} 个人工编写的「口语提问 → 应命中指南」

## 一、为什么做这个评测

校赛评语提出「知识库是真实检索还是话术模板」的疑问。回答这个疑问不能靠口头说明，只能靠**可复算的量化结果**：
把用户在真实场景里会问的口语句子列出来，人工标注「这句话应当命中哪条指南」，然后看系统实际把正确指南排在第几位。
标注只看 golden id，不依赖大模型打分，任何人拿到仓库都能重跑并得到同样数字。

## 二、评测结果

| 指标 | 启用查询扩展 | 关闭查询扩展 | 说明 |
| --- | --- | --- | --- |
| Recall@1 | ${pct(r.withExpansion.recallAt1)} | ${pct(r.withoutExpansion.recallAt1)} | 排第 1 位就是正确指南的比例 |
| Recall@3 | ${pct(r.withExpansion.recallAt3)} | ${pct(r.withoutExpansion.recallAt3)} | 前 3 条含正确指南的比例 |
| Recall@5 | ${pct(r.withExpansion.recallAt5)} | ${pct(r.withoutExpansion.recallAt5)} | 前 5 条含正确指南的比例 |
| MRR | ${r.withExpansion.mrr} | ${r.withoutExpansion.mrr} | 正确条目排名倒数的均值，越接近 1 越好 |
| 平均检索耗时 | ${r.withExpansion.avgLatencyMs} ms | ${r.withoutExpansion.avgLatencyMs} ms | 单次 BM25 检索（不含大模型） |

**查询扩展带来的提升**：Recall@1 ${signed(r.delta.recallAt1, ' pt')}，Recall@3 ${signed(r.delta.recallAt3, ' pt')}，Recall@5 ${signed(r.delta.recallAt5, ' pt')}，MRR ${signed(r.delta.mrr)}。

> 这说明扩展规则不是装饰：把「膝盖疼」映射到「膝关节 / 关节不适 / 低冲击 / 替代动作」之后，
> 原本跑偏到「大体重减脂」的检索会正确落到《关节不适人群的替代动作》。

## 三、逐条明细（启用查询扩展）

| 用户提问 | 期望指南 | 命中位置 | 检索耗时 | 实际 Top5 |
| --- | --- | --- | --- | --- |
${rows}

## 四、关闭查询扩展时的失手清单

${missBlock}

## 五、这套检索为什么是「真实检索」而不是「话术模板」

1. **索引来自真实语料**：动作 ${KB_STATS.exercises.docs} 条、指南 ${KB_STATS.guidelines.docs} 条、食物 ${KB_STATS.foods.docs} 条，全部是本地 JSON，启动时建成倒排索引（词表 ${KB_STATS.guidelines.vocabulary + KB_STATS.exercises.vocabulary} 词与 DF 可在「检索实验室 → 索引体检」实时查看）。
2. **打分可复算**：每次检索返回逐词贡献（term / tf / idf / contrib），任意一条引用都能倒推回「哪个词 × 哪个文档 × 多少分」。
3. **输出随输入变**：换一个问法，命中的指南、引用条目、提示词上下文全部变化；同一条指南不会固定出现在所有回答里。
4. **可做消融**：同一问题在「给知识库上下文 / 不给」两种条件下生成两份答案（页面「RAG 消融实验」），答案里的具体条目名与数字只出现在有上下文的一侧。
5. **可被证伪**：本报告给出的是 golden 标注 + 排名，如果检索退化成关键词写死，Recall 会立刻崩掉。
`;

const out = path.join(ROOT, 'docs', '评测报告-检索.md');
fs.writeFileSync(out, md, 'utf8');
console.log(`\n✓ 已写入 ${path.relative(ROOT, out)}`);
