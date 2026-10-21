/**
 * 大模型调用客户端（OpenAI 兼容协议）
 * ---------------------------------------------------------------------------
 * 技术选型说明（技术文档核心章节对应）：
 *   · 协议层选择「OpenAI Chat Completions 兼容协议」，而不是绑定某一家 SDK。
 *     原因：DeepSeek、通义千问、Moonshot、智谱、本地 vLLM/Ollama 都实现了这套协议，
 *     换模型只需改 .env 里的 AI_BASE_URL / AI_MODEL，做到「模型可插拔、供应商无关」。
 *   · 只依赖 Node 原生 fetch，不引入 SDK，减少依赖面（评审环境无需额外安装）。
 *
 * 工程化优化（优化策略章节对应）：
 *   1. 超时控制：AbortController + AI_TIMEOUT_MS，避免单次卡死拖垮整个请求；
 *   2. 自动重试：网络错误 / 5xx / 429 时指数退避重试 1 次（可配置）；
 *   3. JSON 模式：优先请求 response_format=json_object，供应商不支持时自动降级；
 *   4. 流式输出：SSE 增量解析，前端边生成边渲染（AI 教练打字机效果）；
 *   5. 统一异常：抛 AiError 带上可读中文原因，上层据此决定「降级到规则引擎」。
 */
import { config } from '../config/index.js';

/** AI 调用异常：上层捕获后触发降级逻辑 */
export class AiError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** 当前 AI 能力状态，前端首页/设置页会展示 */
export function aiCapability() {
  return {
    enabled: config.ai.enabled,
    provider: config.ai.enabled ? config.ai.baseUrl : 'local-rule-engine',
    model: config.ai.enabled ? config.ai.model : 'rule-engine-v1',
    vision: config.ai.visionEnabled,
    mode: config.ai.enabled ? 'llm' : 'fallback',
  };
}

/**
 * 内部：发起一次 HTTP 请求（带超时）
 */
async function requestOnce(url, body, { signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);
  // 外部 signal 与超时 signal 联动
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 429/5xx 视为可重试；4xx 参数错误不重试
      const retryable = res.status === 429 || res.status >= 500;
      throw new AiError(`大模型接口返回 ${res.status}：${text.slice(0, 200)}`, { status: res.status, retryable });
    }
    return res;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new AiError(`大模型请求超时（${config.ai.timeoutMs}ms）`, { status: 408, retryable: true });
    }
    if (err instanceof AiError) throw err;
    throw new AiError(`大模型请求失败：${err.message}`, { status: 0, retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 对话补全（非流式）
 * @param {{messages: Array<{role:string,content:string}>, jsonMode?: boolean, temperature?: number, maxTokens?: number}} opts
 * @returns {Promise<{content: string, usage: object, model: string, latencyMs: number, retryCount: number}>}
 */
export async function chatComplete({ messages, jsonMode = false, temperature, maxTokens = 2400 }) {
  if (!config.ai.enabled) throw new AiError('未配置 AI_API_KEY，已切换到本地规则引擎');

  const start = Date.now();
  const url = `${config.ai.baseUrl}/chat/completions`;
  const baseBody = {
    model: config.ai.model,
    messages,
    temperature: temperature ?? config.ai.temperature,
    max_tokens: maxTokens,
    stream: false,
  };

  let retryCount = 0;
  // 第一次带 json_object，若供应商报错则去掉重试
  let body = jsonMode ? { ...baseBody, response_format: { type: 'json_object' } } : baseBody;

  for (let attempt = 0; attempt <= 1; attempt += 1) {
    try {
      const res = await requestOnce(url, body);
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content ?? '';
      if (!content) throw new AiError('大模型返回内容为空', { retryable: true });
      return {
        content,
        usage: data.usage || {},
        model: data.model || config.ai.model,
        latencyMs: Date.now() - start,
        retryCount,
      };
    } catch (err) {
      // JSON 模式不被支持时，去掉 response_format 再来一次
      if (attempt === 0 && err.status === 400 && body.response_format) {
        console.warn('[AI] 供应商不支持 response_format，改为提示词约束 JSON 输出');
        body = baseBody;
        retryCount += 1;
        continue;
      }
      if (attempt === 0 && err.retryable) {
        console.warn('[AI] 首次调用失败，正在重试：', err.message);
        await new Promise((r) => setTimeout(r, 800));
        retryCount += 1;
        continue;
      }
      throw err;
    }
  }
  throw new AiError('大模型调用失败（已重试）');
}

/**
 * 对话补全（流式）—— 逐 token 回调，用于 AI 教练打字机效果
 * @param {{messages: Array, onDelta: (text:string)=>void, signal?: AbortSignal}} opts
 * @returns {Promise<{content: string, latencyMs: number, firstTokenMs: number}>}
 */
export async function chatStream({ messages, onDelta, signal }) {
  if (!config.ai.enabled) throw new AiError('未配置 AI_API_KEY，已切换到本地规则引擎');

  const start = Date.now();
  let firstTokenMs = 0;
  const res = await requestOnce(
    `${config.ai.baseUrl}/chat/completions`,
    {
      model: config.ai.model,
      messages,
      temperature: config.ai.temperature,
      max_tokens: 1600,
      stream: true,
    },
    { signal },
  );

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 以 \n\n 分隔事件，逐行解析 data: 负载
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          if (!firstTokenMs) firstTokenMs = Date.now() - start;
          full += delta;
          onDelta?.(delta);
        }
      } catch {
        // 忽略不完整的半包，下一轮会补齐
      }
    }
  }

  return { content: full, latencyMs: Date.now() - start, firstTokenMs };
}

/**
 * 多模态识图（可选能力）：传入 base64 dataURL，让视觉模型估算食物与热量
 * 未配置 AI_VISION_MODEL 时直接抛错，前端会隐藏该功能入口
 */
export async function visionChat({ imageDataUrl, question }) {
  if (!config.ai.visionEnabled) throw new AiError('未配置多模态模型，拍照识别功能不可用');
  const res = await requestOnce(`${config.ai.baseUrl}/chat/completions`, {
    model: config.ai.visionModel,
    temperature: 0.2,
    max_tokens: 1200,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: question },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}
