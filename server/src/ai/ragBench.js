/**
 * 检索质量基准（Retrieval Benchmark）
 * ---------------------------------------------------------------------------
 * 为什么要有这个文件：
 *   校赛评语里有一条「待核：知识库是真实检索还是话术模板」。答辩时只口头说「我们用了
 *   BM25 + 查询扩展」没有说服力——必须能给出「问 N 个真实问题，正确指南被排在第几位」
 *   的量化结果，并且这个结果随时能当场重跑。
 *
 * 这个基准集是人工标注的「口语提问 → 应该命中哪条指南」，只有 golden id 一个答案来源，
 * 不依赖大模型打分，所以结论可复现、可质疑、可推翻后再改。
 *
 * 指标：
 *   · Recall@K：正确指南出现在前 K 条里的比例（K=1/3/5）
 *   · MRR：正确指南排名倒数的平均值（越接近 1 越好）
 *   · 对照：关闭「查询扩展」后同样的指标，用来证明扩展规则真的在起作用
 */
import { retrieveGuidelines } from './rag.js';
import { expandQuery } from './queryExpansion.js';

/**
 * 人工标注基准集：query 是用户会真的问出来的口语，expect 允许有多个正确答案
 * （同一问题命中任一条即算对，避免把一个知识点拆成多条指南时误判）。
 */
export const RAG_BENCH_CASES = [
  { query: '膝盖疼还能练腿吗', expect: ['gl_safety_joint'] },
  { query: '我高血压，能做有氧吗', expect: ['gl_safety_hypertension'] },
  { query: '减脂每天热量缺口留多少合适', expect: ['gl_calorie_deficit'] },
  { query: '增肌蛋白质每天吃多少克', expect: ['gl_protein'] },
  { query: '一周练几次力量比较合适', expect: ['gl_resistance_freq'] },
  { query: '练完肌肉酸痛第二天要不要继续练', expect: ['gl_doms'] },
  { query: '为什么体重卡住不动了', expect: ['gl_fatigue_plateau'] },
  { query: '训练前应该吃什么', expect: ['gl_food_timing'] },
  { query: '心率多少算中等强度', expect: ['gl_hr_zone'] },
  { query: '睡眠不够会影响增肌吗', expect: ['gl_rest_sleep'] },
  { query: '我是零基础新手该怎么开始练', expect: ['gl_beginner_progression'] },
  { query: '体脂率多少算正常', expect: ['gl_bmi_bodyfat'] },
  { query: '孕期可以运动吗', expect: ['gl_safety_pregnancy'] },
  { query: '中老年人练力量要注意什么', expect: ['gl_safety_senior'] },
  { query: '有氧和力量训练先做哪个', expect: ['gl_cardio_strength_order'] },
  { query: '热身需要多长时间', expect: ['gl_warmup'] },
  { query: '运动时喝什么水比较好', expect: ['gl_hydration'] },
  { query: '肌酸有必要吃吗', expect: ['gl_supplement'] },
  { query: '大体重怎么减脂不伤膝盖', expect: ['gl_safety_bigweight', 'gl_safety_joint'] },
  { query: '经期要不要停止训练', expect: ['gl_female_cycle'] },
  { query: '基础代谢怎么算', expect: ['gl_bmr_formula'] },
  { query: '碳水蛋白脂肪怎么分配', expect: ['gl_macro_split'] },
  { query: '总是坚持不下来怎么办', expect: ['gl_habits'] },
  { query: '每周应该做多少有氧', expect: ['gl_acsm_cardio'] },
  { query: '每次都要练到力竭吗，渐进超负荷怎么加重量', expect: ['gl_overload'] },
  { query: '肩关节疼怎么做推举', expect: ['gl_safety_joint'] },
  { query: '健身要不要吃蛋白粉', expect: ['gl_protein', 'gl_supplement'] },
];

/** 找出正确 id 在排名里的位置（1 起，找不到返回 null） */
function rankOf(ids, expect) {
  for (let i = 0; i < ids.length; i += 1) {
    if (expect.includes(ids[i])) return i + 1;
  }
  return null;
}

/**
 * 跑一次基准
 * @param {object} [opts]
 * @param {boolean} [opts.useExpansion=true] 是否启用查询扩展（用于消融对照）
 * @param {number} [opts.topK=5]
 */
export function runRagBench({ useExpansion = true, topK = 5 } = {}) {
  const started = Date.now();
  const rows = [];
  let hit1 = 0;
  let hit3 = 0;
  let hit5 = 0;
  let mrrSum = 0;
  let totalLatency = 0;

  for (const c of RAG_BENCH_CASES) {
    const query = useExpansion ? expandQuery(c.query) : c.query;
    const t0 = process.hrtime.bigint();
    const top = retrieveGuidelines({ query, topK });
    const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
    totalLatency += latencyMs;

    const ids = top.map((g) => g.id);
    const rank = rankOf(ids, c.expect);
    if (rank === 1) hit1 += 1;
    if (rank && rank <= 3) hit3 += 1;
    if (rank && rank <= 5) hit5 += 1;
    if (rank) mrrSum += 1 / rank;

    rows.push({
      query: c.query,
      expect: c.expect,
      rank,
      hitAt5: !!rank,
      latencyMs: Number(latencyMs.toFixed(2)),
      top: top.slice(0, 5).map((g) => ({ id: g.id, title: g.title })),
    });
  }

  const n = rows.length;
  const pct = (x) => Number(((x / n) * 100).toFixed(1));
  return {
    useExpansion,
    cases: n,
    topK,
    recallAt1: pct(hit1),
    recallAt3: pct(hit3),
    recallAt5: pct(hit5),
    mrr: Number((mrrSum / n).toFixed(4)),
    avgLatencyMs: Number((totalLatency / n).toFixed(2)),
    totalLatencyMs: Date.now() - started,
    misses: rows.filter((r) => !r.hitAt5).map((r) => ({ query: r.query, expect: r.expect, got: r.top.map((t) => t.id) })),
    rows,
  };
}

/** 基准 + 消融（开/关查询扩展）一次性跑完，供接口与测试脚本共用 */
export function runRagBenchWithAblation() {
  const withExpansion = runRagBench({ useExpansion: true });
  const withoutExpansion = runRagBench({ useExpansion: false });
  return {
    generatedAt: new Date().toISOString(),
    kbSize: { guidelines: 25, exercises: 65, foods: 82 },
    withExpansion,
    withoutExpansion,
    delta: {
      recallAt1: Number((withExpansion.recallAt1 - withoutExpansion.recallAt1).toFixed(1)),
      recallAt3: Number((withExpansion.recallAt3 - withoutExpansion.recallAt3).toFixed(1)),
      recallAt5: Number((withExpansion.recallAt5 - withoutExpansion.recallAt5).toFixed(1)),
      mrr: Number((withExpansion.mrr - withoutExpansion.mrr).toFixed(4)),
    },
  };
}
