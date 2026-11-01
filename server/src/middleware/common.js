/**
 * 请求 ID：每个请求一个短 UUID，写进响应头 X-Request-Id、res.locals.requestId，
 * 并出现在错误响应体里。线上出问题时用户能直接报「请求 id」，运维按 id 搜日志即可定位，
 * 不用再对着时间点一页页翻日志（验收报告里「无 requestId」就是这条）。
 */
export function requestId(req, res, next) {
  const id = req.headers['x-request-id'] || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  req.id = id;
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

/**
 * 请求日志中间件：打印方法、路径、状态码、耗时（带 requestId 与错误码）
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
    const rid = res.locals.requestId ? ` \x1b[90m#${res.locals.requestId}\x1b[0m` : '';
    console.log(`${color}${res.statusCode}\x1b[0m ${req.method.padEnd(6)} ${url} \x1b[90m${ms}ms\x1b[0m${rid}`);
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
