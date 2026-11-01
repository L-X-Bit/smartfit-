/**
 * 全局错误处理中间件
 * ---------------------------------------------------------------------------
 * 线上验收报告里提到「错误处理太糙：除 400 外全部裸 500，无细分、无 requestId」，
 * 这里按「谁的问题、用户该怎么办」重新分级，并统一带上 requestId：
 *
 *   400 参数不合法            —— ZodError / JSON 解析失败，告诉用户哪个字段不对
 *   401 未登录 / 凭证失效     —— BizError(401)
 *   404 资源不存在            —— BizError(404) / 未匹配路由
 *   413 请求体或图片过大      —— express 的 entity.too.large、图片超限
 *   415 不支持的图片格式      —— 上传的不是 png/jpg/webp
 *   429 限流                  —— 调用太频繁
 *   502 AI 上游失败           —— 大模型返回错误 / 网络不通（可重试）
 *   503 服务暂时不可用        —— 数据库忙等瞬态问题（带 Retry-After）
 *   504 AI 上游超时           —— 大模型超时（可重试）
 *   500 真正的未知异常        —— 对外只说「服务器内部错误」，但给出 requestId 便于排查
 *
 * 对外绝不返回堆栈（避免泄露实现细节），日志里则打印完整堆栈 + requestId。
 */
import { ZodError } from 'zod';
import { config } from '../config/index.js';

/** 统一错误响应体：{ code, message, requestId, data: null } */
function sendError(res, status, message, extra = {}) {
  const requestId = res.locals?.requestId || null;
  return res.status(status).json({ code: extra.code ?? status, message, requestId, data: null, ...extra });
}

export function notFoundHandler(req, res) {
  return sendError(res, 404, `接口不存在: ${req.method} ${req.originalUrl}`);
}

export function errorHandler(err, req, res, _next) {
  const requestId = res.locals?.requestId || req.id || null;
  const log = (tag, extra = '') => console.error(`[${tag}] #${requestId} ${req.method} ${req.originalUrl} ${extra}`, err?.stack || err);

  // 1) 参数校验错误：明确告诉是哪个字段
  if (err instanceof ZodError) {
    const first = err.errors?.[0];
    const field = first?.path?.join('.') || '参数';
    return sendError(res, 400, `参数校验失败：${field} ${first?.message || ''}`.trim(), {
      field,
      errors: err.errors?.slice(0, 5).map((e) => ({ path: e.path?.join('.'), message: e.message })),
    });
  }

  // 2) 请求体问题（express.json / body-parser 抛出的）
  if (err.type === 'entity.too.large' || err.status === 413) {
    return sendError(res, 413, `上传内容过大（上限 ${config.uploads.maxBodyBytes}）。手机照片请先压缩，或改用「拍照」按钮自动压到 1280px`);
  }
  if (err.type === 'entity.parse.failed') {
    return sendError(res, 400, '请求体不是合法 JSON，请检查后重试');
  }

  // 3) AI 上游异常（AiError）：按「能不能重试」翻译成 502/504/429
  if (err.name === 'AiError') {
    const msg = String(err.message || '');
    if (err.status === 408 || /超时|timeout|aborted/i.test(msg)) {
      return sendError(res, 504, `AI 识别超时（${Math.round(config.ai.visionTimeoutMs / 1000)}s 未返回），请换一张更小的照片或稍后重试`, { retryable: true });
    }
    if (err.status === 429) {
      return sendError(res, 429, 'AI 服务当前限流，请稍后再试', { retryable: true });
    }
    if (!err.status) {
      log('AI网络异常');
      return sendError(res, 502, `AI 服务连接失败：${msg || '网络异常'}（可重试）`, { retryable: true });
    }
    log('AI上游异常', `status=${err.status}`);
    return sendError(res, 502, `AI 服务返回异常：${msg}`, { retryable: Boolean(err.retryable), upstreamStatus: err.status });
  }

  // 4) 业务异常（可预期的、要展示给用户的）
  if (err.name === 'BizError' || err.httpStatus) {
    const status = err.httpStatus || err.status || 400;
    return sendError(res, status, err.message);
  }

  // 5) 数据库瞬态问题：SQLite 写锁竞争 / 忙等 → 503 + Retry-After，让前端重试
  if (/SQLITE_BUSY|database is locked|SQLITE_LOCKED/i.test(err?.message || '')) {
    log('数据库繁忙');
    res.setHeader('Retry-After', '2');
    return sendError(res, 503, '数据库繁忙，请 2 秒后重试', { retryable: true });
  }

  // 6) 其他未知异常：对外只给通用提示 + requestId，堆栈只进日志
  log('未捕获异常');
  return sendError(
    res,
    500,
    config.isProd
      ? `服务器内部错误，请把请求号 ${requestId} 反馈给开发者`
      : `服务器内部错误：${err.message}（#${requestId}）`,
    { requestId },
  );
}
