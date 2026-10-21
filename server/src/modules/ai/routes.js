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
import { aiStats } from '../../ai/observability.js';
import { cacheStats } from '../../ai/cache.js';
import { retrieveFoods } from '../../ai/rag.js';

const router = Router();
router.use(requireAuth);

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
    if (!config.ai.visionEnabled) throw new BizError('未配置多模态模型（AI_VISION_MODEL），该功能不可用', 501);
    const dataUrl = String(req.body?.imageDataUrl || '');
    if (!dataUrl.startsWith('data:image/')) throw new BizError('请上传图片');

    const prompt = `你是营养师。请识别图片中的食物，估算每种食物的份量（克）与热量。
只输出 JSON，结构：{"items":[{"name":"食物名","amountG":150,"kcal":220,"protein":20,"fat":5,"carb":10}],"totalKcal":220,"advice":"一句饮食建议"}`;
    const text = await visionChat({ imageDataUrl: dataUrl, question: prompt });

    // 容错解析
    let parsed = null;
    try {
      const jsonStr = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
      parsed = JSON.parse(jsonStr);
    } catch {
      return ok(res, { raw: text, items: [], matched: false }, '识别完成（模型未返回结构化结果）');
    }

    // 与本地食物库做匹配，方便一键写入饮食记录
    const items = (parsed.items || []).map((it) => {
      const candidates = retrieveFoods({ query: String(it.name || ''), topK: 1 });
      const match = candidates[0] || null;
      return {
        ...it,
        matchedFoodId: match?.id || null,
        matchedFoodName: match?.name || null,
        matchScore: match?.score ? Number(match.score.toFixed(2)) : 0,
      };
    });

    return ok(res, { items, totalKcal: parsed.totalKcal || 0, advice: parsed.advice || '', matched: true }, '识别完成');
  }),
);

export default router;
