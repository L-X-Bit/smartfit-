/**
 * 全局配置中心
 * ---------------------------------------------------------------------------
 * 设计说明（讲解要点）：
 * 1. 极简 .env 解析器：不引入 dotenv 依赖，Node 原生即可读取，减少依赖体积；
 * 2. 所有配置项集中在这里读取并给出默认值，业务代码只依赖 config，不直接读 process.env；
 * 3. AI 相关配置留空时会自动降级到「本地规则引擎」，保证无网络 / 无密钥时演示不中断。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** server 目录的绝对路径（用于定位 .env、数据库、上传目录） */
export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 解析 .env 文件为对象。
 * 支持：# 注释、KEY=VALUE、值两侧引号、行内注释。
 * @param {string} file .env 文件绝对路径
 * @returns {Record<string,string>}
 */
function parseEnvFile(file) {
  const result = {};
  if (!fs.existsSync(file)) return result;

  const content = fs.readFileSync(file, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue; // 跳过空行与注释
    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 去掉包裹的引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

// 先加载 server/.env，再用 process.env 覆盖（真实环境变量优先级更高，便于 CI/CD）
const fileEnv = parseEnvFile(path.join(SERVER_ROOT, '.env'));
const env = { ...fileEnv, ...process.env };

/**
 * 进程时区对齐业务时区（默认 Asia/Shanghai）
 * ---------------------------------------------------------------------------
 * 云平台（Render / 容器）默认是 UTC：SQLite 的 datetime('now','localtime')、
 * new Date() 的本地字段都会按 UTC 走，于是中国时间 00:00~08:00 之间的数据日期会少一天。
 * 这里在进程启动最早阶段就把 TZ 设成业务时区，让 Node 与 SQLite 的 localtime 完全一致；
 * 显式关闭：APP_TZ=UTC（或设成任意想要的时区）。
 */
if (!process.env.TZ) process.env.TZ = env.APP_TZ || 'Asia/Shanghai';

/** 字符串转布尔值的小工具 */
const bool = (v, def = false) =>
  v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
/** 字符串转数字的小工具 */
const num = (v, def) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? def : Number(v));

export const config = {
  /** 运行环境 */
  env: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  /** 后端端口 */
  port: num(env.PORT, 3000),
  /**
   * 监听地址：默认 0.0.0.0（IPv4 全地址）。
   * 踩过的坑：Node 在 `listen(port)` 不传 host 时会绑定到 `::`，某些环境（容器 / Render /
   * 沙箱）不开 IPv4-mapped，结果 `127.0.0.1:3000` 连不上、健康检查失败。显式写 0.0.0.0 最稳。
   */
  host: env.HOST || '0.0.0.0',
  /**
   * 业务时区：容器默认是 UTC，中国用户 08:00 前的「今天」会算成昨天（首页「今日」错位）。
   * 所有「今天」相关计算统一走这个时区。
   */
  timezone: env.APP_TZ || 'Asia/Shanghai',

  /** JWT 配置 */
  jwt: {
    secret: env.JWT_SECRET || 'smartfit-dev-secret-please-change-in-production',
    expiresIn: env.JWT_EXPIRES_IN || '7d',
  },

  /** 数据库文件绝对路径 */
  dbFile: path.isAbsolute(env.DB_FILE || '')
    ? env.DB_FILE
    : path.join(SERVER_ROOT, env.DB_FILE || 'data/smartfit.db'),

  /** 用户上传图片存放目录与对外访问前缀 */
  uploadDir: path.join(SERVER_ROOT, 'uploads'),
  uploadUrlPrefix: '/uploads',

  /**
   * 上传限制（拍照识热量的 base64 图片）
   *  · maxBodyBytes：express.json 的请求体上限，必须大于图片解码后体积 + base64 膨胀（约 1.37 倍）
   *  · maxImageBytes：单张图片解码后的上限
   * 踩过的坑：原来 body 限 10MB、图片限 6MB，手机原图恰好卡在边界，
   * 超限时 express 抛的是 413 却被打成 500「服务器内部错误」，用户完全看不出原因。
   */
  uploads: {
    maxBodyBytes: env.UPLOAD_MAX_BODY || '20mb',
    maxImageBytes: num(env.UPLOAD_MAX_IMAGE_MB, 12) * 1024 * 1024,
    /**
     * 最小体积只用来拦「空文件 / 明显损坏」，不做画质判断。
     * 踩过的坑：原来写 8KB，结果一张合法的纯色 PNG（几百字节）被直接判死并报 500；
     * 现在只拦 200 字节以下的垃圾数据，剩下的交给模型判断「这是不是食物」。
     */
    minImageBytes: num(env.UPLOAD_MIN_IMAGE_BYTES, 64),
  },

  /** 大模型配置（OpenAI 兼容协议） */
  ai: {
    apiKey: env.AI_API_KEY || '',
    baseUrl: (env.AI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    model: env.AI_MODEL || 'deepseek-chat',
    visionModel: env.AI_VISION_MODEL || '',
    timeoutMs: num(env.AI_TIMEOUT_MS, 45000),
    /**
     * 识图单独的超时：视觉模型一次要传几百 KB 的 base64，比纯文本慢，
     * 但不能像原来那样 60s 一起挂着——用户等 60 秒只拿到一个 500 是最差的体验。
     * 超时后由错误处理中间件转成 504 + 可读提示，前端可以引导用户换图重试。
     */
    visionTimeoutMs: num(env.AI_VISION_TIMEOUT_MS, 30000),
    temperature: num(env.AI_TEMPERATURE, 0.6),
    /** 是否具备真实大模型能力：没配 Key 就是 false，AI 层会自动降级 */
    get enabled() {
      return Boolean(env.AI_API_KEY);
    },
    get visionEnabled() {
      return Boolean(env.AI_API_KEY && env.AI_VISION_MODEL);
    },
  },

  /** RAG / 缓存 / 限流 */
  ragTopK: num(env.RAG_TOP_K, 6),
  aiCacheEnabled: bool(env.AI_CACHE_ENABLED, true),
  aiRateLimitPerMin: num(env.AI_RATE_LIMIT_PER_MIN, 20),

  /**
   * 演示数据保鲜：启动时若「最近一条演示数据」已经过期（部署很久没重启），
   * 自动把演示数据整体平移到今天，避免排行榜空、今日栏没数据。
   * 想彻底关闭：DEMO_AUTO_SHIFT=off
   */
  demoAutoShift: !['off', '0', 'false', 'no'].includes(String(env.DEMO_AUTO_SHIFT || 'on').toLowerCase()),
};

/** 启动时打印一次关键配置，方便排查「为什么没走大模型」这类问题 */
export function printConfigSummary() {
  const line = (k, v) => console.log(`  ${k.padEnd(18)} ${v}`);
  console.log('\n================ 智练 SmartFit 配置 ================');
  line('运行环境', config.env);
  line('监听端口', config.port);
  line('数据库文件', config.dbFile);
  line('大模型', config.ai.enabled ? `已启用（${config.ai.model}）` : '未配置密钥 → 本地规则引擎降级模式');
  line('多模态识别', config.ai.visionEnabled ? `已启用（${config.ai.visionModel}）` : '未启用');
  line('语义缓存', config.aiCacheEnabled ? '开启' : '关闭');
  console.log('===================================================\n');
}
