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

  /** 大模型配置（OpenAI 兼容协议） */
  ai: {
    apiKey: env.AI_API_KEY || '',
    baseUrl: (env.AI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    model: env.AI_MODEL || 'deepseek-chat',
    visionModel: env.AI_VISION_MODEL || '',
    timeoutMs: num(env.AI_TIMEOUT_MS, 45000),
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
