/**
 * 全局错误处理中间件
 * - BizError：业务异常，直接返回给用户看的中文提示
 * - ZodError：参数校验失败，返回第一条校验错误，便于前端提示
 * - 其他：500，日志打印完整堆栈，但对外只返回「服务器内部错误」，避免泄露实现细节
 */
import { ZodError } from 'zod';
import { config } from '../config/index.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ code: 404, message: `接口不存在: ${req.method} ${req.originalUrl}`, data: null });
}

export function errorHandler(err, req, res, _next) {
  // 1) 参数校验错误
  if (err instanceof ZodError) {
    const first = err.errors[0];
    const field = first?.path?.join('.') || '参数';
    return res.status(400).json({ code: 400, message: `参数校验失败：${field} ${first?.message || ''}`.trim(), data: null });
  }

  // 2) 业务异常
  if (err.name === 'BizError' || err.httpStatus) {
    return res.status(err.httpStatus || 400).json({ code: err.code || 400, message: err.message, data: null });
  }

  // 3) 未知异常
  console.error('[未捕获异常]', req.method, req.originalUrl, err);
  return res.status(500).json({
    code: 500,
    message: config.isProd ? '服务器内部错误' : `服务器内部错误: ${err.message}`,
    data: null,
  });
}
