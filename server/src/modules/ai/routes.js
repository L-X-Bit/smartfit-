/**
 * AI 能力路由
 * ---------------------------------------------------------------------------
 * GET    /api/ai/status        AI 能力状态（是否启用大模型 / 模型名 / 降级模式）
 * GET    /api/ai/stats         运行统计（调用次数、缓存命中率、平均耗时、降级率）
 * POST   /api/ai/coach         AI 教练对话（SSE 流式输出）
 * GET    /api/ai/history       对话历史
 * DELETE /api/ai/history       清空历史
 * GET    /api/ai/suggestions   首页 AI 建议
 * POST   /api/ai/upload        图片上传（base64 → 落盘 → 返回 URL）
 * POST   /api/ai/vision-food   多模态食物识别（需配置 AI_VISION_MODEL）
 *
 * 关于 SSE（Server-Sent Events）：
 *   相比 WebSocket，SSE 更轻量、天然支持断线重连、且只需 HTTP 协议。
 *   AI 对话是「服务端单向持续推送」的典型场景，SSE 是业界主流选择（ChatGPT 同款方案）。
 *   这里用 POST + fetch 读流的方式，而不是 EventSource（EventSource 只支持 GET）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import { asyncHandler, ok, BizError } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/common.js';
import { config } from '../../config/index.js';
import { aiCapability, visionChat } from '../../ai/provider.js';
import { coachReply, getHistory, clearHistory, quickSuggestions } from '../../ai/coachAgent.js';
import { aiStats, logAiCall } from '../../ai/observability.js';
import { cacheStats } from '../../ai/cache.js';
import { retrieveFoods } from '../../ai/rag.js';

const router = Router();
router.use(requireAuth);

/**
 * 名称相似度（用于把模型识别的口语名对齐到食物库标准名）
 * ---------------------------------------------------------------------------
 * 为什么必须有这一层：BM25 是词法检索，中文单字会误导——
 *   实测「紫甘蓝」被匹配到「紫薯」（只共享一个"紫"字）、
 *   「圣女果」被匹配到「苹果」（只共享一个"果"字）、「鹌鹑蛋」被匹配到「蛋清」。
 * 所以这里再算一次「去修饰词后的字符重叠率」，只有 BM25 分高且名字真的像，
 * 才认为匹配成功；否则标记为未匹配，交给用户在下拉里手动选。
 * @param {string} recognized 模型识别出的名字，如「香煎鸡胸肉」
 * @param {string} standard 食物库标准名，如「鸡胸肉（熟）」
 * @returns {number} 0~1 的相似度
 */
function nameSimilarity(recognized, standard) {
  const clean = (s) =>
    String(s)
      // 去掉括号说明与常见烹饪方式修饰，只留食材主体
      .replace(/[（(][^)）]*[)）]/g, '')
      .replace(/香煎|水煮|清蒸|红烧|油炸|烤|炒|煎|蒸|熟|生|干|煮|凉拌|糖醋|卤/g, '')
      .replace(/[^\u4e00-\u9fa5]/g, '');
  const a = clean(recognized);
  const b = clean(standard);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  // 字符重叠率：按较短串长度归一化
  const setB = new Set(b.split(''));
  const hit = a.split('').filter((ch) => setB.has(ch)).length;
  return hit / Math.min(a.length, b.length);
}

router.get('/status', asyncHandler((req, res) => ok(res, { ...aiCapability(), cache: cacheStats(), rateLimitPerMin: config.aiRateLimitPerMin })));

router.get('/stats', asyncHandler((req, res) => ok(res, { ...aiStats(Number(req.query.days) || 7), cache: cacheStats() })));

router.get('/suggestions', asyncHandler((req, res) => ok(res, quickSuggestions(req.user.id))));

router.get('/history', asyncHandler((req, res) => ok(res, getHistory(req.user.id, Number(req.query.limit) || 30))));

router.delete(
  '/history',
  asyncHandler((req, res) => {
    clearHistory(req.user.id);
    return ok(res, null, '对话历史已清空');
  }),
);

/**
 * AI 教练对话（SSE）
 * 事件序列：meta → delta(多次) → done
 */
router.post(
  '/coach',
  rateLimit({ limit: config.aiRateLimitPerMin, windowMs: 60_000 }),
  asyncHandler(async (req, res) => {
    const question = String(req.body?.question || '').trim();
    if (!question) throw new BizError('请输入你的问题');
    if (question.length > 500) throw new BizError('问题不要超过 500 字');

    // 1. 建立 SSE 通道
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 关闭 Nginx 缓冲，保证逐字下发
    res.flushHeaders?.();

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('meta', { ai: aiCapability(), question });

    try {
      // 2. 调用 Coach Agent（内部会自动降级）
      const result = await coachReply({
        userId: req.user.id,
        question,
        onDelta: (text, type) => send('delta', { text, type }),
      });
      // 3. 结束事件：带上引用来源，前端可展示「知识库依据」
      send('done', { provider: result.provider, latencyMs: result.latencyMs, refs: result.refs });
    } catch (err) {
      send('error', { message: err.message || 'AI 服务异常' });
    } finally {
      res.end();
    }
  }),
);

/**
 * 图片上传：前端把图片压缩成 base64 dataURL 传来，后端落盘并返回可访问 URL
 * 说明：用 JSON + base64 而不用 multipart，是为了减少依赖（无需 multer），
 *      且前端可用 canvas 先压缩，减少体积；限制 5MB 以防滥用。
 */
router.post(
  '/upload',
  asyncHandler((req, res) => {
    const dataUrl = String(req.body?.dataUrl || '');
    const match = dataUrl.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i);
    if (!match) throw new BizError('图片格式不支持（仅支持 png/jpg/webp/gif）');

    const ext = match[1].toLowerCase().replace('jpeg', 'jpg');
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 5 * 1024 * 1024) throw new BizError('图片过大，请小于 5MB');

    fs.mkdirSync(config.uploadDir, { recursive: true });
    const filename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(config.uploadDir, filename), buffer);
    return ok(res, { url: `${config.uploadUrlPrefix}/${filename}`, size: buffer.length }, '上传成功');
  }),
);

/**
 * 多模态食物识别（可选能力，未配置视觉模型时前端隐藏入口）
 * 返回识别出的食物与热量估算，并自动匹配食物库中的标准条目，便于一键记录
 */
router.post(
  '/vision-food',
  rateLimit({ limit: 10, windowMs: 60_000 }),
  asyncHandler(async (req, res) => {
    if (!config.ai.visionEnabled) {
      throw new BizError('未配置多模态模型（AI_VISION_MODEL），该功能不可用。请在 server/.env 中配置后重启后端', 501);
    }
    const dataUrl = String(req.body?.imageDataUrl || '');
    const match = dataUrl.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i);
    if (!match) throw new BizError('请上传图片（支持 png / jpg / webp / gif）');
    if (match[2].length > 8 * 1024 * 1024) throw new BizError('图片过大，请压缩到 6MB 以内（前端会自动压缩）');

    const start = Date.now();

    // 提示词要点：① 强制简体中文；② 强制 JSON；③ 明确"只识别食物"；
    // ④ 让模型给出可直接对标的份量，便于与本地食物库匹配后换算
    const prompt = `你是注册营养师，请识别这张照片里的食物。
要求：
1. 使用中国大陆通用的简体中文命名（例如写"鸡胸肉"而不是"雞胸肉"）；
2. 逐项列出图中可见的食物，估算每种的份量（克）、热量与三大营养素；
3. 份量按常见餐具大小合理估算，不要给极端值（单种食物 10~600g）；
4. 若图中没有食物，items 返回空数组；
5. 只输出 JSON，不要任何解释文字、不要 markdown 代码块。

输出结构：
{"items":[{"name":"食物名","amountG":150,"kcal":220,"protein":20,"fat":5,"carb":10}],"totalKcal":220,"advice":"一句饮食建议"}`;

    let text = '';
    try {
      text = await visionChat({ imageDataUrl: dataUrl, question: prompt });
    } catch (err) {
      logAiCall({ userId: req.user.id, scene: 'vision', provider: 'llm', model: config.ai.visionModel, latencyMs: Date.now() - start, status: 'error', errorMsg: err.message });
      throw new BizError(`图像识别失败：${err.message}`, 502);
    }

    // 容错解析（模型可能返回代码块或前后带解释）
    let parsed = null;
    try {
      const body = String(text).replace(/```(?:json)?/gi, '').trim();
      const jsonStr = body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1);
      parsed = JSON.parse(jsonStr.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      logAiCall({ userId: req.user.id, scene: 'vision', provider: 'llm', model: config.ai.visionModel, latencyMs: Date.now() - start, status: 'error', errorMsg: '模型未返回合法 JSON' });
      return ok(res, { items: [], totalKcal: 0, advice: '', raw: String(text).slice(0, 500), matched: false }, '识别完成，但模型未返回结构化结果，可重试或手动记录');
    }

    /**
     * 与本地食物营养库做匹配（这一步很关键）：
     *   · 模型给的是"香煎鸡胸肉""水煮蛋"这类带烹饪方式的名字，库里的标准名是"鸡胸肉（熟）""鸡蛋"；
     *   · 用 BM25 取前 3 个候选，取分数最高者为默认匹配，同时把候选一并返回，
     *     前端允许用户在下拉里改选，避免匹配错导致热量记错；
     *   · 有匹配时用「库内每 100g 营养值 × 识别克数」重算热量，保证与全站数据一致。
     */
    const items = (Array.isArray(parsed.items) ? parsed.items : []).slice(0, 12).map((it) => {
      const name = String(it?.name || '').slice(0, 30);
      const candidates = retrieveFoods({ query: name, topK: 4 }).map((f) => ({
        id: f.id,
        name: f.name,
        kcal: f.kcal,
        protein: f.protein,
        fat: f.fat,
        carb: f.carb,
        score: Number((f.score || 0).toFixed(2)),
      }));
      const best = candidates.find((c) => c.score >= 1.0 && nameSimilarity(name, c.name) >= 0.6) || null;
      const confident = Boolean(best);
      const amountG = Math.min(800, Math.max(10, Math.round(Number(it?.amountG) || 100)));
      return {
        name,
        amountG,
        // 模型原始估算（作为兜底展示）
        modelKcal: Math.round(Number(it?.kcal) || 0),
        modelProtein: Number(it?.protein) || 0,
        modelFat: Number(it?.fat) || 0,
        modelCarb: Number(it?.carb) || 0,
        matchedFoodId: confident ? best.id : null,
        matchedFoodName: confident ? best.name : null,
        matchScore: best ? best.score : 0,
        confidence: confident ? Number(nameSimilarity(name, best.name).toFixed(2)) : 0,
        candidates,
        // 命中库内食物时，按库值重算（与饮食记录逻辑完全一致）
        kcal: confident ? Math.round((best.kcal * amountG) / 100) : Math.round(Number(it?.kcal) || 0),
        protein: confident ? Number(((best.protein * amountG) / 100).toFixed(1)) : Number(it?.protein) || 0,
        fat: confident ? Number(((best.fat * amountG) / 100).toFixed(1)) : Number(it?.fat) || 0,
        carb: confident ? Number(((best.carb * amountG) / 100).toFixed(1)) : Number(it?.carb) || 0,
      };
    });

    const totalKcal = Math.round(items.reduce((s, i) => s + i.kcal, 0));
    const matchedCount = items.filter((i) => i.matchedFoodId).length;

    logAiCall({
      userId: req.user.id,
      scene: 'vision',
      provider: 'llm',
      model: config.ai.visionModel,
      latencyMs: Date.now() - start,
      ragHits: matchedCount,
      status: 'ok',
    });

    return ok(
      res,
      {
        items,
        totalKcal,
        advice: String(parsed.advice || '').slice(0, 200),
        matchedCount,
        totalCount: items.length,
        raw: process.env.NODE_ENV === 'production' ? undefined : String(text).slice(0, 500),
      },
      items.length ? `识别到 ${items.length} 种食物，其中 ${matchedCount} 种已匹配食物库` : '未识别到食物，请换一张更清晰的照片',
    );
  }),
);

export default router;
