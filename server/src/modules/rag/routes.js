/**
 * 检索可解释路由（RAG Explain）
 * ---------------------------------------------------------------------------
 * 这一组接口存在的唯一目的：把「知识库检索」从一句宣称变成可复算的证据。
 *
 *  GET  /api/rag/stats    索引体检：文档数 / 词表大小 / 平均文档长度 / 高频词 DF 与 BM25 参数
 *  POST /api/rag/explain  还原一次检索的全过程（分词 → 过滤 → BM25 逐词打分 → 加权 → MMR）
 *  GET  /api/rag/bench    跑人工标注基准集，返回 Recall@1/3/5 与 MRR（含关闭查询扩展的对照）
 *  POST /api/rag/ablation 同一问题的「有 RAG / 无 RAG」双答案对照（真实调用大模型，限流）
 *
 * 为什么这些接口要放在线上、给前端用：
 *   评审在自己电脑上点「检索实验室」就能看到分数、命中词、引用原文，
 *   不需要相信任何 PPT 上的数字。
 */
import { Router } from 'express';
import { asyncHandler, ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/common.js';
import { config } from '../../config/index.js';
import {
  indexStats,
  explainExerciseRetrieval,
  explainGuidelineRetrieval,
  explainFoodRetrieval,
  explainCoachRetrieval,
} from '../../ai/rag.js';
import { expandQueryDetailed } from '../../ai/queryExpansion.js';
import { runRagBench, runRagBenchWithAblation } from '../../ai/ragBench.js';
import { chatComplete, AiError } from '../../ai/provider.js';
import { buildProfile } from '../../ai/profile.js';
import { logAiCall } from '../../ai/observability.js';

const router = Router();
router.use(requireAuth);

/** 人类可读的画像摘要，只用于对照实验的提示词 */
function profileSummary(userId) {
  const { profile, metrics } = buildProfile(userId);
  return [
    `${profile.genderText} ${profile.age} 岁，身高 ${profile.height}cm，体重 ${profile.weight}kg`,
    profile.bodyFat ? `体脂 ${profile.bodyFat}%` : '',
    `BMI ${metrics.bmi}（${metrics.bmiLevel}）`,
    `目标：${profile.goalText}，每周 ${profile.daysPerWeek} 练`,
    profile.conditionText?.length ? `健康状况：${profile.conditionText.join('、')}` : '',
    `每日目标热量 ${metrics.targetCalories}kcal`,
    profile.recentTrendText || '',
  ].filter(Boolean).join('；');
}

/** 索引体检 */
router.get('/stats', asyncHandler(async (req, res) => {
  ok(res, {
    ...indexStats(),
    note: '以上均为运行时从 server/data/kb/*.json 与 SQLite 真实建索引的结果，可直接复算',
  });
}));

/**
 * 检索全过程还原
 * body: { kind: 'coach'|'exercise'|'guide'|'food', query, equipment?, maxDifficulty?, preferGroups?, topK?, expand? }
 */
router.post('/explain', asyncHandler(async (req, res) => {
  const kind = String(req.body?.kind || 'coach');
  const query = String(req.body?.query || '').slice(0, 300);
  const topK = Math.min(Math.max(Number(req.body?.topK) || 5, 1), 12);
  const expand = req.body?.expand !== false;

  if (!query.trim()) {
    return res.status(400).json({ code: 400, message: '请先输入要检索的问题', data: null });
  }

  const t0 = Date.now();
  const expansion = expandQueryDetailed(query);
  const effectiveQuery = expand ? expansion.expanded : query;

  let result;
  if (kind === 'exercise') {
    result = explainExerciseRetrieval({
      query: effectiveQuery,
      equipment: Array.isArray(req.body?.equipment) ? req.body.equipment : [],
      maxDifficulty: Number(req.body?.maxDifficulty) || 3,
      preferGroups: Array.isArray(req.body?.preferGroups) ? req.body.preferGroups : [],
      topK,
    });
  } else if (kind === 'guide') {
    result = explainGuidelineRetrieval({ query: effectiveQuery, tags: [], topK });
  } else if (kind === 'food') {
    result = explainFoodRetrieval({ query: effectiveQuery, topK });
  } else {
    result = explainCoachRetrieval({ question: query, expandedQuery: effectiveQuery, topK });
  }

  ok(res, {
    kind,
    query,
    expansion: {
      enabled: expand,
      appliedRules: expansion.appliedRules,
      expandedQuery: expansion.expanded,
      note: expand
        ? '查询扩展把口语提问映射到知识库用词；关掉它可直接看到召回下降（见 /api/rag/bench 的对照）'
        : '已关闭查询扩展，仅用原始问句检索',
    },
    latencyMs: Date.now() - t0,
    result,
  });
}));

/** 基准评测（默认返回开 / 关查询扩展的对照） */
router.get('/bench', asyncHandler(async (req, res) => {
  const withAblation = req.query.ablation !== '0';
  if (withAblation) return ok(res, runRagBenchWithAblation());
  return ok(res, runRagBench({ useExpansion: req.query.expand !== '0' }));
}));

/**
 * RAG 消融实验：同一个问题，一次给模型知识库上下文、一次不给，把两个答案摆在评审面前。
 * 这是回应「是不是话术模板」最直接的一个实验——如果知识库只是装饰，去掉它答案不会有变化。
 * 每次调用都真的花 token，所以限 3 次/分钟。
 */
router.post('/ablation', rateLimit({ limit: 3, windowMs: 60_000 }), asyncHandler(async (req, res) => {
  const question = String(req.body?.question || '').slice(0, 300);
  if (!question.trim()) {
    return res.status(400).json({ code: 400, message: '请输入要对照的问题', data: null });
  }
  if (!config.ai.enabled) {
    return res.status(400).json({ code: 400, message: '未配置大模型，无法做在线对照实验（仍可离线查看检索打分）', data: null });
  }

  const { expanded, appliedRules } = expandQueryDetailed(question);
  const rag = explainCoachRetrieval({ question, expandedQuery: expanded, topK: 3 });
  const userSummary = profileSummary(req.user.id);
  const systemBase = '你是专业、谨慎的健身与营养教练。回答用中文，条理清晰，控制在 200 字以内，不要编造具体数值来源。';

  const withRagPrompt = `${systemBase}

以下是平台知识库检索到的资料，请优先依据这些资料回答，并可点名引用条目：
${rag.context.text}

用户画像：${userSummary}`;
  const withoutRagPrompt = `${systemBase}

本次回答不使用任何知识库资料，只能凭通用知识回答。
用户画像：${userSummary}`;

  const started = Date.now();
  try {
    const [withRag, withoutRag] = await Promise.all([
      chatComplete({ messages: [{ role: 'system', content: withRagPrompt }, { role: 'user', content: question }], temperature: 0.3 }),
      chatComplete({ messages: [{ role: 'system', content: withoutRagPrompt }, { role: 'user', content: question }], temperature: 0.3 }),
    ]);
    const latencyMs = Date.now() - started;
    logAiCall({
      userId: req.user.id,
      scene: 'rag_ablation',
      provider: withRag.provider,
      model: config.ai.model,
      latencyMs,
      ragHits: rag.context.refs.length,
      status: 'ok',
    });

    ok(res, {
      question,
      expandedQuery: expanded,
      appliedRules,
      latencyMs,
      withRag: { answer: withRag.content, refs: rag.context.refs, contextChars: rag.context.chars, contextText: rag.context.text },
      withoutRag: { answer: withoutRag.content },
      howToRead: '对比两份答案：有 RAG 的版本会出现知识库里的具体条目（如「关节不适人群的替代动作」及其数字），无 RAG 的版本通常更笼统，甚至给出不适合伤病人群的建议。',
    });
  } catch (e) {
    const msg = e instanceof AiError ? e.message : String(e?.message || e);
    logAiCall({
      userId: req.user.id,
      scene: 'rag_ablation',
      provider: 'error',
      latencyMs: Date.now() - started,
      status: 'error',
      errorMsg: msg,
    });
    res.status(502).json({ code: 502, message: `对照实验暂不可用：${msg}`, data: null });
  }
}));

export default router;
