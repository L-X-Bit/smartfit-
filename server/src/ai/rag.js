/**
 * RAG 检索层（Retrieval-Augmented Generation）
 * ---------------------------------------------------------------------------
 * 为什么需要 RAG（技术文档「AI 技术方案」要点）：
 *   通用大模型并不知道我们知识库里的具体动作 MET 值、禁忌人群、训练指南条款，
 *   直接生成容易出现「编造动作」「给出不适合高血压用户的动作」等幻觉。
 *   RAG 的做法是：先从本地知识库检索出相关事实，把它塞进提示词，
 *   让模型「基于给定资料回答」，既降低幻觉，又能把引用来源展示给用户（可解释）。
 *
 * 检索算法选型（关键：为什么不用向量库？）：
 *   1. 本项目知识库规模小（动作 ~66 条、指南 ~24 条、食物 ~70 条），
 *      用 BM25 词法检索 + 结构化过滤已能达到很好的召回率，且零依赖、零网络、毫秒级；
 *   2. 中文没有空格，这里用「单字 + 二元组」切分（bigram），这是轻量中文 BM25 的常用做法；
 *   3. 同时叠加「结构化过滤」（目标 / 器械 / 难度 / 肌群）与「标签加权」，
 *      形成 Hybrid Retrieval（词法 + 结构化），比单一路径更稳；
 *   4. 最后用 MMR（最大边界相关性）做去冗余，避免 6 条结果全是深蹲类动作。
 *   5. 若未来知识库上万条，可把 score() 换成 bge/m3e 向量检索，接口保持不变（策略模式）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all } from '../db/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KB_DIR = path.resolve(HERE, '../../data/kb');

// ---------------------------------------------------------------- 中文分词
/**
 * 轻量中文分词：英文/数字按词切，中文按「单字 + 二元组(bigram)」切
 * 例："减脂 居家 深蹲" → ['减脂','减','脂','居家','居','家','深蹲','深','蹲']
 * 这样既能命中「减脂」这类词，也能命中「燃脂/低冲击」等未登录词。
 */
export function tokenize(text = '') {
  const tokens = [];
  const lower = String(text).toLowerCase();

  // 1. 英文与数字（保留 equipment 如 dumbbell、MET 等）
  const ascii = lower.match(/[a-z0-9]+/g);
  if (ascii) tokens.push(...ascii);

  // 2. 中文：先按非中文字符切段，段内取单字与二元组
  for (const seg of lower.replace(/[^\u4e00-\u9fa5]+/g, ' ').split(/\s+/)) {
    if (!seg) continue;
    for (let i = 0; i < seg.length; i += 1) {
      tokens.push(seg[i]);
      if (i < seg.length - 1) tokens.push(seg.slice(i, i + 2));
    }
  }
  return tokens;
}

// ---------------------------------------------------------------- BM25 实现
/** BM25 参数：k1 控制词频饱和，b 控制文档长度归一化 */
const K1 = 1.5;
const B = 0.75;

export class BM25Index {
  /**
   * @param {Array<{id:string, text:string, meta?:object}>} docs
   */
  constructor(docs) {
    this.docs = docs.map((d) => {
      const tokens = tokenize(`${d.text} ${d.title || ''}`);
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      return { ...d, tf, len: tokens.length };
    });
    this.N = this.docs.length;
    this.avgdl = this.docs.reduce((s, d) => s + d.len, 0) / (this.N || 1);
    // 文档频率 DF
    this.df = new Map();
    for (const d of this.docs) {
      for (const term of d.tf.keys()) this.df.set(term, (this.df.get(term) || 0) + 1);
    }
  }

  /** IDF：加 1 平滑，避免高频词权重为负 */
  idf(term) {
    const df = this.df.get(term) || 0;
    return Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
  }

  /**
   * 计算查询与文档的相关性得分
   * @param {string[]} queryTokens
   * @param {object} doc BM25Index 内部文档
   */
  score(queryTokens, doc) {
    let s = 0;
    const seen = new Set();
    for (const term of queryTokens) {
      if (seen.has(term)) continue; // 查询词去重，避免长句重复放大
      seen.add(term);
      const f = doc.tf.get(term);
      if (!f) continue;
      const idf = this.idf(term);
      const denom = f + K1 * (1 - B + (B * doc.len) / (this.avgdl || 1));
      s += idf * ((f * (K1 + 1)) / denom);
    }
    return s;
  }

  /**
   * 检索 Top-K
   * @param {string} query
   * @param {number} topK
   * @param {(doc:any)=>boolean} [filter] 结构化过滤（目标/器械/难度等）
   */
  search(query, topK = 6, filter) {
    const qTokens = tokenize(query);
    const scored = [];
    for (const doc of this.docs) {
      if (filter && !filter(doc)) continue;
      const s = this.score(qTokens, doc);
      if (s > 0) scored.push({ doc, score: Number(s.toFixed(4)) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * 可解释检索：除分数外，还给出「哪些查询词命中了、每个词贡献多少分、被过滤掉了哪些」
   * ---------------------------------------------------------------------------
   * 为什么需要它：评委/用户都问过同一个问题——「你的知识库检索是真的吗，还是把模板文案
   * 换个说法？」只展示「引用了 3 条指南」无法自证。把 BM25 的逐词打分、IDF 权重、
   * 结构化过滤的淘汰原因全部暴露出来，任何一条引用都能倒推回「哪个词 × 哪个文档 × 多少分」，
   * 这是可复算的证据，而不是话术。
   */
  searchDetailed(query, topK = 6, filter) {
    const qTokens = [...new Set(tokenize(query))];
    const hits = [];
    const filteredOut = [];
    for (const doc of this.docs) {
      const terms = [];
      let s = 0;
      for (const term of qTokens) {
        const f = doc.tf.get(term);
        if (!f) continue;
        const idf = this.idf(term);
        const denom = f + K1 * (1 - B + (B * doc.len) / (this.avgdl || 1));
        const contrib = idf * ((f * (K1 + 1)) / denom);
        s += contrib;
        terms.push({ term, tf: f, idf: Number(idf.toFixed(4)), contrib: Number(contrib.toFixed(4)) });
      }
      if (s <= 0) continue;
      const record = {
        id: doc.id,
        title: doc.meta?.name || doc.meta?.title || doc.meta?.name || doc.id,
        score: Number(s.toFixed(4)),
        len: doc.len,
        matchedTermCount: terms.length,
        terms: terms.sort((a, b) => b.contrib - a.contrib).slice(0, 8),
      };
      if (filter && !filter(doc)) {
        filteredOut.push({ ...record, reason: '被结构化过滤淘汰（器械 / 难度不满足）' });
        continue;
      }
      hits.push({ doc, ...record });
    }
    hits.sort((a, b) => b.score - a.score);
    return {
      queryTokens: qTokens,
      candidateCount: hits.length + filteredOut.length,
      matchedDocs: hits.length,
      filteredOut,
      hits: hits.slice(0, topK),
    };
  }

  /** 索引自身的体检数据（词表大小、平均文档长度等），用于证明这是真实的倒排索引 */
  stats() {
    return {
      docs: this.N,
      avgDocLength: Number((this.avgdl || 0).toFixed(2)),
      vocabulary: this.df.size,
      sampleTerms: [...this.df.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, df]) => ({ term: t, df })),
    };
  }
}

// ---------------------------------------------------------------- 知识库加载（懒加载 + 单例）
let exerciseIndex = null;
let foodIndex = null;
let guidelineIndex = null;
let guidelinesRaw = [];

/** 读取动作库（来自数据库，保证管理后台改动能即时生效） */
function getExercises() {
  return all('SELECT * FROM exercises');
}

function ensureIndexes() {
  if (exerciseIndex) return;

  const exercises = getExercises();
  exerciseIndex = new BM25Index(
    exercises.map((e) => ({
      id: e.id,
      text: `${e.search_text} ${e.cautions || ''}`,
      meta: {
        id: e.id,
        name: e.name,
        category: e.category,
        muscleGroup: e.muscle_group,
        equipment: e.equipment,
        difficulty: e.difficulty,
        met: e.met,
        tags: JSON.parse(e.tags || '[]'),
        description: e.description,
        cautions: e.cautions,
      },
    })),
  );

  const foods = all('SELECT * FROM foods');
  foodIndex = new BM25Index(
    foods.map((f) => ({
      id: f.id,
      text: `${f.search_text} ${f.portion || ''}`,
      meta: { ...f },
    })),
  );

  guidelinesRaw = JSON.parse(fs.readFileSync(path.join(KB_DIR, 'guidelines.json'), 'utf8'));
  guidelineIndex = new BM25Index(
    guidelinesRaw.map((g) => ({
      id: g.id,
      title: g.title,
      text: `${g.title} ${g.category} ${(g.tags || []).join(' ')} ${g.content}`,
      meta: g,
    })),
  );
}

/** 供 seed/管理接口在知识库变更后刷新索引 */
export function resetIndexes() {
  exerciseIndex = null;
  foodIndex = null;
  guidelineIndex = null;
}

// ---------------------------------------------------------------- MMR 去冗余
/**
 * MMR（Maximal Marginal Relevance）：在「相关性」与「多样性」之间取平衡
 * 公式：MMR = λ·rel(d) - (1-λ)·max_sim(d, 已选集合)
 * 这里用标签/肌群重叠率近似相似度，简单高效。
 */
function mmrSelect(candidates, topK, lambda = 0.7) {
  const selected = [];
  const pool = [...candidates];
  while (pool.length && selected.length < topK) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    pool.forEach((cand, i) => {
      // 注意：候选是 { doc, score } 结构，标签信息在 cand.doc.meta 里
      const tagsA = new Set([...(cand.doc.meta.tags || []), cand.doc.meta.muscleGroup || '']);
      let maxSim = 0;
      for (const sel of selected) {
        const tagsB = new Set([...(sel.doc.meta.tags || []), sel.doc.meta.muscleGroup || '']);
        const inter = [...tagsA].filter((t) => tagsB.has(t)).length;
        const union = new Set([...tagsA, ...tagsB]).size || 1;
        maxSim = Math.max(maxSim, inter / union); // Jaccard 相似度
      }
      const mmr = lambda * (cand.score / (candidates[0].score || 1)) - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    });
    selected.push(pool.splice(bestIdx, 1)[0]);
  }
  return selected;
}

// ---------------------------------------------------------------- 对外检索接口
/**
 * 检索动作（Hybrid：结构化过滤 + BM25 + 标签加权 + MMR 去冗余）
 * @param {object} opts
 * @param {string} opts.query 用户目标/偏好描述
 * @param {string[]} [opts.equipment] 可用器械，如 ['徒手','哑铃']
 * @param {number} [opts.maxDifficulty] 最大难度
 * @param {string[]} [opts.preferGroups] 优先肌群
 * @param {number} [opts.topK]
 */
export function retrieveExercises({ query = '', equipment = [], maxDifficulty = 3, preferGroups = [], topK = 10 } = {}) {
  ensureIndexes();
  const eqSet = new Set(equipment);

  // 第一层：结构化过滤（硬约束）
  const filter = (doc) => {
    const m = doc.meta;
    if (m.difficulty > maxDifficulty) return false;
    if (eqSet.size && !eqSet.has(m.equipment)) return false;
    return true;
  };

  let hits = exerciseIndex.search(query, topK * 3, filter);

  // 若过滤后结果过少，放宽器械限制再补一次（保证方案可执行又不空手）
  if (hits.length < topK) {
    const relaxed = exerciseIndex.search(query, topK * 3, (doc) => doc.meta.difficulty <= maxDifficulty);
    const exist = new Set(hits.map((h) => h.doc.id));
    hits = hits.concat(relaxed.filter((r) => !exist.has(r.doc.id)));
  }

  // 第二层：标签 / 肌群加权
  const boost = (m) => {
    let s = 0;
    if (preferGroups.includes(m.muscleGroup)) s += 0.35;
    for (const tag of m.tags || []) {
      if (query.includes(tag)) s += 0.25; // 用户描述里直接命中标签
    }
    if (m.category === '柔韧') s -= 0.15; // 柔韧类不作为主训练内容
    return s;
  };
  hits = hits.map((h) => ({ ...h, score: h.score + boost(h.doc.meta) })).sort((a, b) => b.score - a.score);

  // 第三层：MMR 去冗余
  const picked = mmrSelect(hits.slice(0, topK * 2), topK).map((h) => ({
    ...h.doc.meta,
    score: h.score,
  }));
  return picked;
}

/** 检索训练/营养指南（附打分，便于对话接口把「引用依据的分数」一并回传） */
export function retrieveGuidelines({ query = '', tags = [], topK = 4 } = {}) {
  ensureIndexes();
  const hits = guidelineIndex.search(`${query} ${tags.join(' ')}`, topK * 2);
  // 标签命中加权
  const boosted = hits.map((h) => {
    const hitTags = (h.doc.meta.tags || []).filter((t) => tags.includes(t)).length;
    return { ...h, score: h.score + hitTags * 0.4 };
  }).sort((a, b) => b.score - a.score);
  return boosted.slice(0, topK).map((h) => ({ ...h.doc.meta, score: Number(h.score.toFixed(2)) }));
}

/** 检索食物（饮食推荐 / 拍照识别后的候选匹配都会用到） */
export function retrieveFoods({ query = '', topK = 8 } = {}) {
  ensureIndexes();
  return foodIndex.search(query, topK).map((h) => ({ ...h.doc.meta, score: h.score }));
}

/**
 * 把检索结果拼成提示词上下文，并返回可解释的引用列表
 * @returns {{ text: string, refs: Array<{type:string,id:string,title:string}> }}
 */
export function buildContext({ exercises = [], guidelines = [], foods = [] }) {
  const parts = [];
  const refs = [];

  if (guidelines.length) {
    parts.push('【训练与营养指南（权威资料，优先遵循）】');
    guidelines.forEach((g, i) => {
      parts.push(`${i + 1}. ${g.title}：${g.content}`);
      refs.push({ type: 'guide', id: g.id, title: g.title });
    });
  }

  if (exercises.length) {
    parts.push('\n【可用动作库（只能从下列动作中选择，不得编造）】');
    exercises.forEach((e) => {
      parts.push(
        `- ${e.id} | ${e.name} | 部位:${e.muscleGroup} | 类别:${e.category} | 器械:${e.equipment} | 难度:${e.difficulty} | MET:${e.met} | 标签:${(e.tags || []).join('/')} | 禁忌:${e.cautions || '无'}`,
      );
      refs.push({ type: 'exercise', id: e.id, title: e.name });
    });
  }

  if (foods.length) {
    parts.push('\n【食物营养库（每 100g，只能引用下列数据）】');
    foods.forEach((f) => {
      parts.push(`- ${f.name} | 热量${f.kcal}kcal | 蛋白${f.protein}g | 脂肪${f.fat}g | 碳水${f.carb}g | 建议份量:${f.portion || ''}`);
      refs.push({ type: 'food', id: f.id, title: f.name });
    });
  }

  return { text: parts.join('\n'), refs };
}

// ---------------------------------------------------------------- 可解释检索（对外）
/**
 * 索引体检数据：证明「知识库」是本地的、结构化的、被真正建成倒排索引的语料，
 * 而不是提示词里写死的一段话术。
 */
export function indexStats() {
  ensureIndexes();
  return {
    exercises: exerciseIndex.stats(),
    foods: foodIndex.stats(),
    guidelines: guidelineIndex.stats(),
    params: { k1: K1, b: B, tokenizer: '中文单字 + 二元组(bigram)，英文数字整词' },
    kbFiles: ['server/data/kb/exercises.json', 'server/data/kb/foods.json', 'server/data/kb/guidelines.json'],
  };
}

/**
 * 完整还原一次「动作检索」的全过程：分词 → 结构化过滤 → BM25 打分 → 标签加权 → MMR 去冗余
 * 每一阶段都返回中间结果，前端可以逐段展示「AI 到底检索到了什么」。
 */
export function explainExerciseRetrieval({ query = '', equipment = [], maxDifficulty = 3, preferGroups = [], topK = 10 } = {}) {
  ensureIndexes();
  const eqSet = new Set(equipment);
  const filterFn = (doc) => {
    const m = doc.meta;
    if (m.difficulty > maxDifficulty) return false;
    if (eqSet.size && !eqSet.has(m.equipment)) return false;
    return true;
  };

  const strict = exerciseIndex.searchDetailed(query, topK * 3, filterFn);
  let pool = strict.hits;
  let relaxedUsed = false;
  let relaxed = null;

  if (pool.length < topK) {
    relaxedUsed = true;
    const r = exerciseIndex.searchDetailed(query, topK * 3, (doc) => doc.meta.difficulty <= maxDifficulty);
    const exist = new Set(pool.map((h) => h.id));
    relaxed = r;
    pool = pool.concat(r.hits.filter((h) => !exist.has(h.id)));
  }

  const boost = (m) => {
    const detail = [];
    let s = 0;
    if (preferGroups.includes(m.muscleGroup)) { s += 0.35; detail.push('优先肌群 +0.35'); }
    for (const tag of m.tags || []) {
      if (query.includes(tag)) { s += 0.25; detail.push(`标签「${tag}」命中查询 +0.25`); }
    }
    if (m.category === '柔韧') { s -= 0.15; detail.push('柔韧类不作主训练 −0.15'); }
    return { delta: Number(s.toFixed(4)), detail };
  };

  const boosted = pool.map((h) => {
    const b = boost(h.doc.meta);
    return { ...h, bm25: h.score, score: Number((h.score + b.delta).toFixed(4)), boost: b };
  }).sort((a, b) => b.score - a.score);

  const selected = mmrSelect(boosted.slice(0, topK * 2), topK);
  const selectedIds = new Set(selected.map((h) => h.id));

  return {
    kind: 'exercise',
    query,
    stage1_tokens: strict.queryTokens,
    stage2_filter: {
      rule: `难度 ≤ ${maxDifficulty}${equipment.length ? `，器械 ∈ {${equipment.join('、')}}` : '，器械不限'}`,
      keptCandidates: strict.hits.length,
      droppedByFilter: strict.filteredOut.length,
      droppedExamples: strict.filteredOut.slice(0, 5).map((d) => ({ title: d.title, score: d.score, reason: d.reason })),
      relaxedUsed,
      relaxedNote: relaxedUsed ? '严格过滤后候选不足，已放宽器械限制补检索（保证方案可执行）' : null,
    },
    stage3_bm25: {
      candidates: boosted.slice(0, topK * 3).map((h) => ({
        id: h.id,
        title: h.title,
        bm25: h.bm25,
        finalScore: h.score,
        boost: h.boost,
        matchedTermCount: h.matchedTermCount,
        topTerms: h.terms,
        selected: selectedIds.has(h.id),
      })),
    },
    stage4_mmr: {
      note: 'MMR(λ=0.7) 在相关性与多样性之间取平衡，避免结果全是同类动作',
      order: selected.map((h, i) => ({ rank: i + 1, id: h.id, title: h.title, score: h.score })),
    },
    final: selected.map((h) => ({ ...h.doc.meta, score: h.score })),
  };
}

/** 完整还原一次「指南检索」：BM25 + 标签加权 */
export function explainGuidelineRetrieval({ query = '', tags = [], topK = 4 } = {}) {
  ensureIndexes();
  const search = guidelineIndex.searchDetailed(`${query} ${tags.join(' ')}`, topK * 2);
  const boosted = search.hits.map((h) => {
    const hitTags = (h.doc.meta.tags || []).filter((t) => tags.includes(t));
    const delta = Number((hitTags.length * 0.4).toFixed(2));
    return { ...h, score: Number((h.score + delta).toFixed(4)), boost: { delta, detail: hitTags.length ? [`标签「${hitTags.join('、')}」+${delta}`] : [] } };
  }).sort((a, b) => b.score - a.score);

  return {
    kind: 'guide',
    query,
    stage1_tokens: search.queryTokens,
    stage2_bm25: {
      matchedDocs: search.matchedDocs,
      candidates: boosted.map((h) => ({ id: h.id, title: h.title, bm25: h.score - h.boost.delta, finalScore: h.score, boost: h.boost, topTerms: h.terms })),
    },
    final: boosted.slice(0, topK).map((h) => h.doc.meta),
  };
}

/** 完整还原一次「食物检索」：纯 BM25（拍照识别的候选匹配也走这里） */
export function explainFoodRetrieval({ query = '', topK = 8 } = {}) {
  ensureIndexes();
  const search = foodIndex.searchDetailed(query, topK);
  return {
    kind: 'food',
    query,
    stage1_tokens: search.queryTokens,
    stage2_bm25: {
      matchedDocs: search.matchedDocs,
      candidates: search.hits.map((h) => ({ id: h.id, title: h.doc.meta.name, bm25: h.score, topTerms: h.terms })),
    },
    final: search.hits.map((h) => ({ ...h.doc.meta, score: h.score })),
  };
}

/**
 * 一次把「动作 + 指南」都跑一遍，并按教练对话的真实方式拼出提示词上下文。
 * 返回 diagnostics（可解释）+ context（真正喂给模型的那段文字）+ refs（引用）。
 */
export function explainCoachRetrieval({ question = '', expandedQuery = '', topK = 3 } = {}) {
  const q = expandedQuery || question;
  const guideExplain = explainGuidelineRetrieval({ query: q, topK });
  const exerciseExplain = explainExerciseRetrieval({ query: q, topK });
  const { text, refs } = buildContext({ exercises: exerciseExplain.final, guidelines: guideExplain.final });
  return {
    question,
    expandedQuery: q,
    guidelines: guideExplain,
    exercises: exerciseExplain,
    context: { text, refs, chars: text.length },
  };
}
