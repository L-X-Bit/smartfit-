/**
 * 统一响应格式工具
 * ---------------------------------------------------------------------------
 * 所有接口返回 { code, message, data }：
 *   code = 0   成功
 *   code != 0  业务失败（HTTP 状态码同时给出，便于前端 axios 统一拦截）
 * 这样做的好处：前端只写一处拦截逻辑，AI 降级、参数错误、鉴权失败都有明确提示。
 */

/** 成功响应 */
export function ok(res, data = null, message = 'ok') {
  return res.json({ code: 0, message, data });
}

/** 失败响应（业务错误） */
export function fail(res, message = '请求失败', httpStatus = 400, code = httpStatus) {
  return res.status(httpStatus).json({ code, message, data: null });
}

/**
 * 业务异常类：在 service 层 throw new BizError('xxx', 400)，由全局错误中间件统一捕获
 */
export class BizError extends Error {
  constructor(message, httpStatus = 400, code = httpStatus) {
    super(message);
    this.name = 'BizError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

/** 包装 async 路由处理器，自动 catch 异常交给错误中间件（避免每个路由写 try/catch） */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
