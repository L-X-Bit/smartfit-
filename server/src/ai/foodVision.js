/**
 * 多模态食物识别 Agent（拍照识热量）
 * ===========================================================================
 * 这是本项目继「文本大模型」之后的第二种模态能力：图片 → 结构化营养数据。
 *
 * 流水线（与训练计划 Agent 同构，可复用同一套工程思想）：
 *   ① 图片校验与落盘       —— base64 解码、尺寸/大小校验，存 uploads 供历史回溯
 *   ② 视觉模型识别（多模态）—— image_url + base64 直接进模型，要求输出 JSON
 *   ③ 容错解析与归一化     —— 复用 parseJsonLoose，处理代码块/尾逗号/字段缺失
 *   ④ 与本地食物库做匹配   —— 名称包含 + BM25 混合匹配，命中则改用库内营养值
 *   ⑤ 二次换算与校验       —— 以「克数 × 库值 / 100」重算，杜绝模型算错
 *   ⑥ 落库并返回           —— 可解释元信息（模型、耗时、命中数、来源标记）
 *
 * 设计要点（技术文档可讲）：
 *   · **以库为准**：模型负责"这是什么食物、大概多少克"，具体热量用本地食物库换算。
 *     模型擅长识别与估份量，但不擅长精确算术——这与训练计划里的"算术外移"是同一原则。
 *   · **不匹配也能用**：库里没有的食物（如"麻辣香锅"）保留模型估算值，并标注「模型估算」，
 *     让用户看到数据来源，而不是偷偷混在一起。
 *   · **非食物图片**：提示词要求返回 {"notFood":true}，前端给友好提示，避免瞎编。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { all, get, run } from '../db/index.js';
import { config } from '../config/index.js';
import { visionChat, AiError } from './provider.js';
import { parseJsonLoose } from './validators.js';
import { retrieveFoods } from './rag.js';
import { logAiCall } from './observability.js';

/** 识别提示词：约束输出结构 + 份量估算规则 + 语言要求 + 非食物处理 */
export const FOOD_VISION_PROMPT = `你是一位专业营养师，擅长从照片估算食物份量与热量。

【语言要求】必须使用中国大陆通用的简体中文，不要输出繁体字。

【份量估算方法（最重要，直接决定热量准不准）】
照片是二维的，没有尺度参照就无法判断真实大小。你必须按下面的顺序推理：

第 1 步 —— 找尺度参照物（找到就以它为基准，准确性会高很多）：
  · 筷子（标准 25cm）、汤勺（约 20cm）、一元硬币（直径 2.5cm）、一次性纸杯（高 9cm）
  · 人手（成人手掌宽约 8~9cm、张开拇指到小指约 18~20cm）
  · 标准餐盘（直径 20~26cm）、饭碗（口径 11~13cm，满碗约 250ml，装米饭约 200g）
  · 易拉罐（高 12cm）、手机（宽约 7.5cm）

第 2 步 —— 用参照物推算容器尺寸与食物体积，再结合食物密度换算重量：
  · 体积 × 密度 才是重量（米饭约 0.8g/cm³、炒菜约 0.6~0.8、汤约 1.0、肉类约 0.9）
  · 堆高、铺平、压实都会影响实际克数，按"松散盛装"估

第 3 步 —— 必须给出「估计值 + 区间 + 依据」：
  · amountG：最优估计（克）
  · amountMin / amountMax：合理区间，必须满足 amountMin ≤ amountG ≤ amountMax；
    有参照物时区间宽度控制在估计值的 ±30% 内，无参照物时放宽到 ±50%
  · reference：一句话写清凭什么这么估（如"以筷子长度推算碗口约 18cm，米饭铺平至七分满"）
  · confidence：high（有明确参照物 + 常规餐具）/ medium（有餐具但尺寸不典型）/ low（无参照物）

第 4 步 —— 图中若找不到任何参照物：
  · reference 写"无参照物，按常见餐盘尺寸保守估算"，confidence 必须为 low
  · 不要为了显得自信而虚报 confidence

【其它规则】
1. 分别列出每一种可辨认的食物（例如米饭、红烧肉、西兰花），不要合并成一整餐；
2. 中餐菜品若含明显油脂，按同类家常做法估算（如红烧肉按每 100g 约 450 kcal）；
3. 份量必须符合常识（一碗米饭 150~250g、一份炒菜 150~300g、一块肉 80~150g）。

【输出格式】只输出一个 JSON 对象，不要任何解释文字、不要用 markdown 代码块包裹：
{
  "isFood": true,
  "scene": "一句话描述你看到的这餐（如：一份中式快餐，米饭+红烧肉+青菜）",
  "referenceObject": "筷子（标准 25cm）",
  "scaleConfidence": "high",
  "items": [
    {
      "name": "米饭", "amountG": 200, "amountMin": 150, "amountMax": 250,
      "kcal": 232, "protein": 5.2, "fat": 0.6, "carb": 51.8,
      "reference": "以筷子长度推算碗口约 12cm、米饭七分满", "confidence": "high"
    }
  ],
  "totalKcal": 232,
  "advice": "一句话饮食建议（40 字以内，结合这一餐的营养特点）"
}

【非食物图片】
如果图片里没有食物（例如人物、风景、文档、截图），只输出：{"isFood": false, "reason": "简要说明你看到的是什么"}`;

/** 取字符串的中文/字母二元组集合（用于判断两个名字是否真的相似） */
function bigramSet(text) {
  const t = String(text || '').replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '');
  const set = new Set();
  if (t.length === 1) set.add(t);
  for (let i = 0; i < t.length - 1; i += 1) set.add(t.slice(i, i + 2));
  return set;
}

/** 两个名字是否共享至少一个二元组；返回共享的那个词或 null */
function sharedBigram(a, b) {
  const A = bigramSet(a);
  const B = bigramSet(b);
  for (const x of A) if (B.has(x)) return x;
  return null;
}

/**
 * 把识别到的食物名称与本地食物库做匹配
 * ---------------------------------------------------------------------------
 * 匹配策略（由严格到宽松，宁可匹配不上也不乱匹配）：
 *   ① 名称包含匹配：去掉库名括号说明后互相包含，且双方都 ≥2 字（避免"汤"命中一堆）
 *   ② BM25 兜底：分数 ≥3.0 **且** 与库名共享至少一个二元组
 * 为什么加 ② 的"共享二元组"条件：
 *   实测「面汤」会被 BM25 匹配到「意面（熟）」，导致 300g 算出 474kcal（真实约 30kcal）；
 *   「青豆」会被匹配到「青椒」。中文单字碰撞在词法检索里很常见，
 *   加上二元组重叠校验后，"面汤/意面"（无共同词）会被拒绝，而"牛肉块/瘦牛肉"（共享"牛肉"）仍能命中。
 * @param {string} name 模型识别出的食物名
 * @param {Array} foods 全量食物库（调用方传入，避免每项都查库）
 */
function matchLibraryFood(name, foods) {
  const raw = String(name || '').trim();
  if (!raw || raw.length < 2) return null;

  // ① 名称包含匹配（最可靠）
  let best = null;
  let bestLen = 0;
  for (const f of foods) {
    const base = f.name.replace(/[（(].*?[）)]/g, '').trim(); // 去掉「（熟）」「（干）」等说明
    if (base.length < 2) continue;
    if (raw.includes(base) || base.includes(raw)) {
      if (base.length > bestLen) {
        best = f;
        bestLen = base.length;
      }
    }
  }
  if (best) return { food: best, how: 'name', score: bestLen, shared: best.name };

  // ② BM25 兜底（严格模式：高分 + 二元组重叠）
  const hits = retrieveFoods({ query: raw, topK: 3 });
  for (const h of hits) {
    if ((h.score || 0) < 3.0) continue;
    const shared = sharedBigram(raw, h.name);
    if (!shared) continue;
    return { food: h, how: 'bm25', score: Number(h.score.toFixed(2)), shared };
  }
  return null;
}

/** 数值收敛：非负、保留 1 位小数 */
const num = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Number(n.toFixed(1)) : def;
};

/**
 * 分析一张食物照片
 * @param {object} p
 * @param {number} p.userId
 * @param {string} p.imageDataUrl base64 dataURL
 * @returns {Promise<{scanId:number, scan:object, items:Array, meta:object}>}
 */
export async function analyzeFoodImage({ userId, imageDataUrl }) {
  const start = Date.now();

  // ---------- ① 校验并落盘 ----------
  const matched = String(imageDataUrl || '').match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
  if (!matched) throw new AiError('图片格式不支持（仅支持 png / jpg / webp）');

  const ext = matched[1].toLowerCase().replace('jpeg', 'jpg');
  const buffer = Buffer.from(matched[2], 'base64');
  if (buffer.length < 8 * 1024) throw new AiError('图片太小，请上传清晰的食物照片');
  if (buffer.length > 6 * 1024 * 1024) throw new AiError('图片过大（请小于 6MB）');

  fs.mkdirSync(config.uploadDir, { recursive: true });
  const filename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(config.uploadDir, filename), buffer);
  const imageUrl = `${config.uploadUrlPrefix}/${filename}`;

  if (!config.ai.visionEnabled) {
    throw new AiError('未配置多模态视觉模型（AI_VISION_MODEL），拍照识别功能暂不可用');
  }

  // ---------- ② 视觉模型识别 ----------
  let raw;
  try {
    raw = await visionChat({ imageDataUrl, question: FOOD_VISION_PROMPT });
  } catch (err) {
    logAiCall({ userId, scene: 'vision', provider: 'vision', model: config.ai.visionModel, latencyMs: Date.now() - start, status: 'error', errorMsg: err.message });
    throw err;
  }
  const llmLatency = Date.now() - start;

  // ---------- ③ 容错解析 ----------
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== 'object') {
    logAiCall({ userId, scene: 'vision', provider: 'vision', model: config.ai.visionModel, latencyMs: llmLatency, status: 'error', errorMsg: '模型输出不是合法 JSON' });
    throw new AiError('识别结果解析失败，请换一张更清晰的照片重试');
  }

  // 非食物图片：如实告知，不编造
  if (parsed.isFood === false || !Array.isArray(parsed.items) || parsed.items.length === 0) {
    logAiCall({ userId, scene: 'vision', provider: 'vision', model: config.ai.visionModel, latencyMs: llmLatency, status: 'ok', errorMsg: parsed.reason || 'not food' });
    return {
      scanId: null,
      notFood: true,
      reason: parsed.reason || '图片里没有识别到食物',
      imageUrl,
      items: [],
      meta: { provider: 'vision', model: config.ai.visionModel, latencyMs: llmLatency },
    };
  }

  // ---------- ④⑤ 库匹配 + 以库为准重算 ----------
  const foods = all('SELECT * FROM foods');
  const items = [];
  let matchedCount = 0;

  for (const it of parsed.items.slice(0, 12)) {
    const name = String(it.name || '').slice(0, 30) || '未识别食物';
    const amountG = Math.min(2000, Math.max(5, Math.round(num(it.amountG, 100) / 5) * 5));
    const modelKcal = Math.round(num(it.kcal, 0));
    const hit = matchLibraryFood(name, foods);

    // ---- 份量不确定性：区间 + 判断依据 ----
    // 照片无法直接量出重量，模型只能基于参照物估算，所以必须把「不确定度」一起交给用户，
    // 而不是给一个看起来很确定的数字。这里先做自洽性校验：
    // 模型给的区间若不满足 min ≤ 估计 ≤ max，就用 ±30% 兜底，避免出现 150g(200~300g) 这种矛盾。
    let amountMin = Math.round(num(it.amountMin, 0));
    let amountMax = Math.round(num(it.amountMax, 0));
    if (!amountMin || !amountMax || amountMin > amountG || amountMax < amountG) {
      amountMin = Math.max(5, Math.round((amountG * 0.7) / 5) * 5);
      amountMax = Math.round((amountG * 1.3) / 5) * 5;
    }
    const reference = String(it.reference || '').slice(0, 60);

    // ---- 双源交叉校验 ----
    // 库值与模型估算相差过大（>3 倍）时，说明大概率匹配错了食物（例如「面汤」→「意面」），
    // 此时以模型估算为准，并把候选库项记录下来，供用户/后续人工纠正。
    if (hit) {
      const k = amountG / 100;
      const libKcal = Math.round(hit.food.kcal * k);
      const hi = Math.max(libKcal, modelKcal) || 1;
      const lo = Math.min(libKcal, modelKcal);
      const ratio = hi / Math.max(lo, 1);
      const trustLibrary = modelKcal === 0 || ratio <= 3;

      if (trustLibrary) {
        matchedCount += 1;
        items.push({
          name,
          amountG,
          amountMin,
          amountMax,
          reference,
          kcal: libKcal,
          protein: num(hit.food.protein * k),
          fat: num(hit.food.fat * k),
          carb: num(hit.food.carb * k),
          source: 'library',                 // 数据来源：本地食物库（可信）
          foodId: hit.food.id,
          libraryName: hit.food.name,
          matchHow: hit.how,
          modelKcal,
          confidence: ['high', 'medium', 'low'].includes(it.confidence) ? it.confidence : 'medium',
          // ---- 以下为兼容「饮食页内嵌识别面板」旧字段，避免旧面板失效 ----
          matchedFoodId: hit.food.id,
          matchedFoodName: hit.food.name,
          matchScore: hit.score,
        });
      } else {
        // 匹配到但数值严重冲突 → 不采用库值，保留模型估算并标注
        items.push({
          name,
          amountG,
          amountMin,
          amountMax,
          reference,
          kcal: modelKcal,
          protein: num(it.protein, 0),
          fat: num(it.fat, 0),
          carb: num(it.carb, 0),
          source: 'model',
          foodId: null,
          libraryName: null,
          libraryCandidate: hit.food.name,   // 仅作参考，不参与计算
          matchHow: `${hit.how}-rejected`,
          modelKcal,
          conflict: true,                    // 标记「库值与估算冲突」
          confidence: ['high', 'medium', 'low'].includes(it.confidence) ? it.confidence : 'medium',
          matchedFoodId: null,
          matchedFoodName: null,
          matchScore: 0,
        });
      }
      continue;
    }

    // ---- 未匹配：保留模型估算值，明确标注来源 ----
    items.push({
      name,
      amountG,
      kcal: modelKcal,
      protein: num(it.protein, 0),
      fat: num(it.fat, 0),
      carb: num(it.carb, 0),
      amountMin,
      amountMax,
      reference,
      source: 'model',                       // 数据来源：模型估算
      foodId: null,
      libraryName: null,
      matchHow: null,
      modelKcal,
      confidence: ['high', 'medium', 'low'].includes(it.confidence) ? it.confidence : 'medium',
      matchedFoodId: null,
      matchedFoodName: null,
      matchScore: 0,
    });
  }

  const sum = (key) => Math.round(items.reduce((s, i) => s + (i[key] || 0), 0));
  const totalKcal = sum('kcal');
  const totalProtein = Number(items.reduce((s, i) => s + (i.protein || 0), 0).toFixed(1));
  const totalFat = Number(items.reduce((s, i) => s + (i.fat || 0), 0).toFixed(1));
  const totalCarb = Number(items.reduce((s, i) => s + (i.carb || 0), 0).toFixed(1));

  // ---------- ⑥ 落库 ----------
  const referenceObject = parsed.referenceObject ? String(parsed.referenceObject).slice(0, 40) : null;
  const scaleConfidence = ['high', 'medium', 'low'].includes(parsed.scaleConfidence) ? parsed.scaleConfidence : null;

  const scanId = run(
    `INSERT INTO food_scans (user_id, image_url, items, total_kcal, total_protein, total_fat, total_carb, advice, provider, model, matched_count, latency_ms, ref_object, scale_confidence)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      userId,
      imageUrl,
      JSON.stringify(items),
      totalKcal,
      totalProtein,
      totalFat,
      totalCarb,
      String(parsed.advice || '').slice(0, 200),
      'vision',
      config.ai.visionModel,
      matchedCount,
      llmLatency,
      referenceObject,
      scaleConfidence,
    ],
  ).lastInsertRowid;

  logAiCall({
    userId,
    scene: 'vision',
    provider: 'vision',
    model: config.ai.visionModel,
    latencyMs: Date.now() - start,
    ragHits: matchedCount,
    status: 'ok',
  });

  return {
    scanId,
    notFood: false,
    scene: String(parsed.scene || '').slice(0, 120),
    imageUrl,
    items,
    totals: { kcal: totalKcal, protein: totalProtein, fat: totalFat, carb: totalCarb },
    advice: String(parsed.advice || '').slice(0, 200),
    // ---- 尺度参照信息（重量估算可信度的来源）----
    // 照片无法直接称重，模型只能靠参照物推算；把「找到了什么参照物、整体可信度如何」如实告诉用户，
    // 并在缺少参照物时主动提示，引导用户手动校准或下次拍摄时放入参照物。
    referenceObject,
    scaleConfidence,
    scaleWarning: !scaleConfidence || scaleConfidence === 'low'
      ? '照片里没有明确的尺度参照物，份量是按常见餐具尺寸估算的，误差可能较大。建议手动确认克数；下次拍摄时把筷子、勺子或硬币放在餐盘旁边，判断会准很多。'
      : null,
    // ---- 兼容「饮食页内嵌识别面板」的旧字段 ----
    totalKcal,
    matched: matchedCount > 0,
    meta: {
      provider: 'vision',
      model: config.ai.visionModel,
      latencyMs: Date.now() - start,
      llmLatency,
      matchedCount,
      totalItems: items.length,
      libraryRatio: items.length ? Number(((matchedCount / items.length) * 100).toFixed(0)) : 0,
    },
  };
}

/** 识别历史（列表，倒序） */
export function listScans(userId, limit = 20) {
  return all('SELECT * FROM food_scans WHERE user_id = ? ORDER BY id DESC LIMIT ?', [userId, limit]).map((row) => ({
    id: row.id,
    imageUrl: row.image_url,
    items: safeParse(row.items),
    totalKcal: row.total_kcal,
    totalProtein: row.total_protein,
    totalFat: row.total_fat,
    totalCarb: row.total_carb,
    advice: row.advice,
    provider: row.provider,
    model: row.model,
    matchedCount: row.matched_count,
    latencyMs: row.latency_ms,
    loggedMeal: row.logged_meal,
    referenceObject: row.ref_object || null,
    scaleConfidence: row.scale_confidence || null,
    createdAt: row.created_at,
  }));
}

/** 单条识别记录 */
export function getScan(userId, id) {
  const row = get('SELECT * FROM food_scans WHERE id = ? AND user_id = ?', [id, userId]);
  if (!row) return null;
  return {
    id: row.id,
    imageUrl: row.image_url,
    items: safeParse(row.items),
    totals: { kcal: row.total_kcal, protein: row.total_protein, fat: row.total_fat, carb: row.total_carb },
    advice: row.advice,
    loggedMeal: row.logged_meal,
    referenceObject: row.ref_object || null,
    scaleConfidence: row.scale_confidence || null,
    createdAt: row.created_at,
  };
}

/** 删除识别记录 */
export function removeScan(userId, id) {
  const row = get('SELECT * FROM food_scans WHERE id = ? AND user_id = ?', [id, userId]);
  if (!row) return false;
  run('DELETE FROM food_scans WHERE id = ?', [id]);
  return true;
}

/** 标记该记录已写入饮食（避免重复记入） */
export function markScanLogged(userId, id, mealType) {
  run('UPDATE food_scans SET logged_meal = ? WHERE id = ? AND user_id = ?', [mealType, id, userId]);
}

function safeParse(str) {
  try {
    return JSON.parse(str || '[]');
  } catch {
    return [];
  }
}
