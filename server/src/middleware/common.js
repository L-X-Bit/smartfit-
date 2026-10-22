/**
 * 请求日志中间件：打印方法、路径、状态码、耗时
 * 开发时能直观看到每个请求的走向，演示时也能展示「前后端联调」过程
 *
 * 注意脱敏：自动同步支持用 ?token=sft_xxx 传令牌（iPhone 快捷指令拼请求头很麻烦），
 * 但日志会被 Render / 终端长期保存，所以这里把 token 值打码，只保留是否传了令牌。
 */
export function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const color = res.statusCode >= 500 ? '\x1b[31m' : res.statusCode >= 400 ? '\x1b[33m' : '\x1b[32m';
    const url = String(req.originalUrl || '').replace(/([?&](?:token|syncToken)=)[^&]*/gi, '$1***');
    console.log(`${color}${res.statusCode}\x1b[0m ${req.method.padEnd(6)} ${url} \x1b[90m${ms}ms\x1b[0m`);
  });
  next();
}

/**
 * 简单的内存限流器（针对 AI 接口）
 * 目的：防止演示时误刷产生大量大模型调用费用；生产可替换为 Redis 方案。
 */
const buckets = new Map(); // key -> { count, resetAt }

export function rateLimit({ limit = 20, windowMs = 60_000 } = {}) {
  return (req, res, next) => {
    const key = `${req.user?.id ?? req.ip}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (bucket.count >= limit) {
      const seconds = Math.ceil((bucket.resetAt - now) / 1000);
      return res.status(429).json({ code: 429, message: `操作太频繁，请 ${seconds} 秒后再试`, data: null });
    }
    bucket.count += 1;
    return next();
  };
}
