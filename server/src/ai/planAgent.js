/**
 * 训练计划 Agent（多阶段编排 / Agentic Pipeline）
 * ===========================================================================
 * 这是本项目 AI 部分的核心：把「一次大模型调用」升级成「一条可观测、可校验、
 * 可降级的多 Agent 流水线」。六个阶段，每一步职责单一、可单独测试：
 *
 *   ┌─ ① 画像构建 Agent ────────────────────────────────────────────┐
 *   │  读取用户档案 + 最新身体数据 + 趋势，标准化为画像              │
 *   └───────────────────────────────────────────────────────────────┘
 *   ┌─ ② 指标计算（确定性规则，非 AI）────────────────────────────┐
 *   │  BMR / TDEE / 目标热量 / 三大营养素 / 心率区间                 │
 *   └───────────────────────────────────────────────────────────────┘
 *   ┌─ ③ 检索 Agent（RAG）────────────────────────────────────────┐
 *   │  按目标/器械/难度/伤病检索动作库 + 指南库，组装上下文与引用     │
 *   └───────────────────────────────────────────────────────────────┘
 *   ┌─ ④ 生成 Agent（LLM）────────────────────────────────────────┐
 *   │  JSON 模式输出；失败自动重试；仍失败则进入修复重试              │
 *   └───────────────────────────────────────────────────────────────┘
 *   ┌─ ⑤ 校验修复 Agent（Validator）──────────────────────────────┐
 *   │  容错解析 → 结构校验 → 拦截编造动作 → 补全周次 → 数值夹取       │
 *   └───────────────────────────────────────────────────────────────┘
 *   ┌─ ⑥ 安全审核 Agent（Guardrail）──────────────────────────────┐
 *   │  按伤病/慢病规则剔除禁忌动作，校验训练量，输出审核报告          │
 *   └───────────────────────────────────────────────────────────────┘
 *   任意阶段失败 → ⑦ 降级：本地规则引擎生成同构结果，用户无感
 *
 * 这套设计的价值（技术文档「技术创新点」）：
 *   · 把大模型的「不确定性」关进工程化的笼子里：输出必须过校验、过安全审核才落库；
 *   · 全链路可观测：每阶段耗时、RAG 命中、重试次数、是否降级都记录在 ai_call_logs；
 *   · 每一环都能独立替换：换模型只改 provider，换检索只改 rag.js，换校验只改 validators。
 */
import { all, get } from '../db/index.js';
import { config } from '../config/index.js';
import { chatComplete, AiError } from './provider.js';
import { PLAN_SYSTEM_PROMPT, buildPlanUserPrompt } from './prompts.js';
import { retrieveExercises, retrieveGuidelines, buildContext } from './rag.js';
import { parseJsonLoose, validatePlan } from './validators.js';
import { buildProfile, buildSafetyFilter } from './profile.js';
import { buildFallbackPlan } from './fallback.js';
import { cacheGet, cacheSet, fingerprint } from './cache.js';
import { logAiCall } from './observability.js';
import { savePlan } from '../modules/plan/service.js';
import { today } from '../db/index.js';

/** 把目标映射到优先训练的肌群，让检索更聚焦 */
const GOAL_GROUPS = {
  lose: ['腿', '核心', '心肺', '全身'],
  gain: ['胸', '背', '腿', '肩'],
  shape: ['臀', '腿', '核心', '肩'],
  keep: ['全身', '心肺', '核心'],
};

/** 目标 → 指南标签 */
const GOAL_GUIDE_TAGS = {
  lose: ['减脂', '有氧', '热量', '营养'],
  gain: ['增肌', '力量', '蛋白质', '恢复'],
  shape: ['塑形', '力量', '女性'],
  keep: ['指南', '心肺', '习惯'],
};

/**
 * 安全审核：剔除禁忌动作并给出审核报告
 * @param {object} plan 已通过结构校验的计划
 * @param {(ex:any)=>{safe:boolean,reason?:string}} safetyFilter
 * @param {Map<string, any>} exerciseMap
 */
function auditPlan(plan, safetyFilter, exerciseMap) {
  const notes = [];
  let removed = 0;
  let totalItems = 0;
  let strengthItems = 0;

  for (const day of plan.weeklySchedule) {
    const kept = [];
    for (const item of day.items) {
      totalItems += 1;
      const ex = exerciseMap.get(item.exerciseId);
      if (!ex) {
        removed += 1;
        continue;
      }
      const check = safetyFilter(ex);
      if (!check.safe) {
        removed += 1;
        notes.push(`已移除「${ex.name}」：${check.reason}`);
        continue;
      }
      if (['力量', '核心'].includes(ex.category)) strengthItems += 1;
      kept.push(item);
    }
    day.items = kept;
  }

  // 剔除后若某天动作过少，用当天已有的动作降级为「缩短时长 + 降低组数」提示
  const emptyDays = plan.weeklySchedule.filter((d) => d.items.length === 0);
  if (emptyDays.length) {
    notes.push(`有 ${emptyDays.length} 个训练日因安全原因无可用动作，已建议改为快走/拉伸等低强度活动`);
  }

  return {
    removed,
    totalItems,
    strengthItems,
    notes,
    passed: removed === 0,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * 生成训练计划主流程
 * @param {object} p
 * @param {number} p.userId
 * @param {object} p.req { goal, daysPerWeek, equipment, level, conditions, weeks, sessionMinutes, queryText }
 * @returns {Promise<{planId:number, plan:object, meta:object, audit:object, refs:Array}>}
 */
export async function generatePlan({ userId, req = {} }) {
  const pipelineStart = Date.now();
  const weeks = Math.min(12, Math.max(1, Number(req.weeks) || 4));
  const equipment = Array.isArray(req.equipment) && req.equipment.length ? req.equipment : ['徒手'];

  // ============ ① 画像 + ② 指标 ============
  const { profile, metrics } = buildProfile(userId, { ...req, daysPerWeek: req.daysPerWeek });
  const safetyFilter = buildSafetyFilter(profile.conditions);
  const exerciseMap = new Map(all('SELECT * FROM exercises').map((e) => [e.id, { ...e, muscleGroup: e.muscle_group, tags: JSON.parse(e.tags || '[]') }]));

  // ============ ③ RAG 检索 ============
  const ragQuery = [
    profile.goalText,
    profile.levelText,
    req.queryText || '',
    profile.conditionText.join(' '),
    equipment.join(' '),
  ].join(' ');
  const maxDifficulty = profile.level === 'advanced' ? 3 : profile.level === 'intermediate' ? 3 : 2;

  const candidates = retrieveExercises({
    query: ragQuery,
    equipment,
    maxDifficulty,
    preferGroups: GOAL_GROUPS[profile.goal] || GOAL_GROUPS.keep,
    topK: 16,
  }).filter((ex) => {
    // 检索结果也要先过安全过滤，避免把禁忌动作喂给模型
    const full = exerciseMap.get(ex.id);
    return full ? safetyFilter(full).safe : true;
  });

  const guides = retrieveGuidelines({
    query: `${ragQuery} 训练频率 渐进超负荷`,
    tags: GOAL_GUIDE_TAGS[profile.goal] || [],
    topK: config.ragTopK > 6 ? 4 : 3,
  });

  const { text: contextText, refs } = buildContext({ exercises: candidates, guidelines: guides });

  // ============ 语义缓存检查 ============
  const cacheKey = `plan:${userId}:${fingerprint({
    goal: profile.goal,
    weight: profile.weight,
    height: profile.height,
    age: profile.age,
    bodyFat: profile.bodyFat,
    days: profile.daysPerWeek,
    level: profile.level,
    equipment,
    conditions: profile.conditions,
    weeks,
    sessionMinutes: req.sessionMinutes || 45,
    query: req.queryText || '',
  })}`;

  if (config.aiCacheEnabled) {
    const cached = cacheGet(cacheKey);
    if (cached.hit) {
      const saved = savePlan({
        userId,
        plan: cached.value,
        source: 'cache',
        aiMeta: {
          ...cached.value._meta,
          cacheHit: true,
          totalLatencyMs: Date.now() - pipelineStart,
        },
        startDate: today(),
      });
      logAiCall({ userId, scene: 'plan', provider: 'cache', model: cached.value._meta?.model || '', latencyMs: Date.now() - pipelineStart, cacheHit: true, ragHits: refs.length });
      return {
        planId: saved.id,
        plan: saved,
        meta: { ...saved.aiMeta, cacheHit: true, pipelineStages: [{ stage: 'cache', ms: 0, note: '命中语义缓存，跳过模型调用' }] },
        audit: { passed: true, notes: ['命中缓存，使用历史审核通过的计划'], removed: 0 },
        refs,
      };
    }
  }

  // ============ ④ 生成 + ⑤ 校验（含一次修复重试）============
  let planObj = null;
  let provider = 'fallback';
  let model = 'rule-engine-v1';
  let fallback = false;
  let retryCount = 0;
  let validationErrors = [];
  let llmLatency = 0;
  const stages = [];

  if (config.ai.enabled) {
    const messages = [
      { role: 'system', content: PLAN_SYSTEM_PROMPT },
      { role: 'user', content: buildPlanUserPrompt(profile, metrics, contextText, {
        weeks,
        equipment,
        levelText: profile.levelText,
        sessionMinutes: req.sessionMinutes || 45,
      }) },
    ];

    try {
      const t1 = Date.now();
      // maxTokens 说明：模型只输出第 1 周模板（约 2000~2600 token），3800 足以留出余量，
      // 又不会因为上限过高而放任模型输出冗长内容。
      const res = await chatComplete({ messages, jsonMode: true, maxTokens: 3800 });
      llmLatency = res.latencyMs;
      retryCount += res.retryCount;
      stages.push({ stage: 'llm_generate', ms: Date.now() - t1, note: `模型 ${res.model}` });

      const parsed = parseJsonLoose(res.content);
      const v1 = validatePlan(parsed, { exerciseMap, weeks, daysPerWeek: profile.daysPerWeek });
      validationErrors = v1.errors;

      if (v1.ok && v1.repaired <= 2) {
        planObj = v1.plan;
        provider = 'llm';
        model = res.model;
        stages.push({
          stage: 'validate',
          ms: 0,
          note: `通过校验（自动修复 ${v1.repaired} 处${v1.expansionNote ? '；' + v1.expansionNote : ''}）`,
        });
      } else {
        // ---- 修复重试：把校验错误回灌给模型，要求只输出修正后的 JSON
        stages.push({ stage: 'validate', ms: 0, note: `校验未通过：${v1.errors.slice(0, 3).join('；')}` });
        const t2 = Date.now();
        const repair = await chatComplete({
          messages: [
            ...messages,
            { role: 'assistant', content: res.content },
            {
              role: 'user',
              content: `上面的 JSON 存在以下问题：${v1.errors.join('；')}。请修正后重新只输出完整 JSON，不要任何解释，exerciseId 必须是动作库中真实存在的 id。`,
            },
          ],
          jsonMode: true,
          maxTokens: 3200,
        });
        retryCount += 1 + repair.retryCount;
        const v2 = validatePlan(parseJsonLoose(repair.content), { exerciseMap, weeks, daysPerWeek: profile.daysPerWeek });
        stages.push({ stage: 'llm_repair', ms: Date.now() - t2, note: v2.ok ? '修复成功' : '修复失败' });
        if (v2.ok) {
          planObj = v2.plan;
          provider = 'llm';
          model = repair.model;
          validationErrors = v2.errors;
        } else {
          validationErrors = v2.errors;
        }
      }
    } catch (err) {
      validationErrors.push(err instanceof AiError ? err.message : String(err.message));
      stages.push({ stage: 'llm_generate', ms: llmLatency, note: `失败：${err.message}` });
    }
  } else {
    stages.push({ stage: 'llm_generate', ms: 0, note: '未配置 AI_API_KEY，直接使用本地规则引擎' });
  }

  // ============ ⑦ 降级：本地规则引擎 ============
  if (!planObj) {
    const t3 = Date.now();
    planObj = buildFallbackPlan({ profile, metrics, req: { ...req, weeks }, safetyFilter });
    provider = 'fallback';
    model = 'rule-engine-v1';
    fallback = true;
    stages.push({ stage: 'fallback_engine', ms: Date.now() - t3, note: '规则引擎生成同构计划' });
  }

  // ============ ⑥ 安全审核 ============
  // 统一用画像里的目标覆盖（模型可能返回其它目标，保持与用户设定一致）
  planObj.goal = profile.goal;
  const audit = auditPlan(planObj, safetyFilter, exerciseMap);
  stages.push({ stage: 'safety_audit', ms: 0, note: audit.passed ? '通过' : `移除 ${audit.removed} 个禁忌动作` });

  // ============ 落库 ============
  const aiMeta = {
    provider,
    model,
    fallback,
    cacheHit: false,
    llmLatencyMs: llmLatency,
    totalLatencyMs: Date.now() - pipelineStart,
    retryCount,
    ragHits: refs.length,
    validationErrors,
    audit: { removed: audit.removed, notes: audit.notes },
    stages,
    metrics,
  };

  const saved = savePlan({ userId, plan: planObj, source: fallback ? 'fallback' : 'ai', aiMeta, startDate: today() });

  if (config.aiCacheEnabled && planObj) {
    cacheSet(cacheKey, { ...planObj, _meta: aiMeta });
  }

  logAiCall({
    userId,
    scene: 'plan',
    provider,
    model,
    latencyMs: Date.now() - pipelineStart,
    cacheHit: false,
    fallback,
    retryCount,
    ragHits: refs.length,
    status: fallback && config.ai.enabled ? 'error' : 'ok',
    errorMsg: validationErrors.length ? validationErrors.slice(0, 3).join('；') : null,
  });

  return { planId: saved.id, plan: saved, meta: aiMeta, audit, refs };
}

/** 取用户最近一份计划（用于详情页/仪表盘） */
export function latestPlan(userId) {
  return get(`SELECT * FROM plans WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`, [userId]);
}
