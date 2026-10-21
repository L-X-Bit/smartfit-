/**
 * AI 可观测性（Observability）
 * ---------------------------------------------------------------------------
 * 每一次 AI 调用都会落一条 ai_call_logs，记录：
 *   场景 / 供应商 / 模型 / 耗时 / 是否缓存命中 / 是否降级 / 重试次数 / RAG 命中数 / 状态
 * 这些数据在做技术文档的「优化策略」章节时是硬证据：
 *   例如「平均耗时从 8.2s 降到 0.3s（缓存命中率 42%）」，
 *   以及「大模型不可用时降级成功率 100%，用户无感」。
 */
import { run, get, all } from '../db/index.js';

/**
 * 记录一次 AI 调用
 * @param {object} p
 */
export function logAiCall({
  userId = null,
  scene,
  provider = 'llm',
  model = '',
  latencyMs = 0,
  cacheHit = false,
  fallback = false,
  retryCount = 0,
  ragHits = 0,
  status = 'ok',
  errorMsg = null,
} = {}) {
  try {
    run(
      `INSERT INTO ai_call_logs (user_id, scene, provider, model, latency_ms, cache_hit, fallback, retry_count, rag_hits, status, error_msg)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [userId, scene, provider, model, latencyMs, cacheHit ? 1 : 0, fallback ? 1 : 0, retryCount, ragHits, status, errorMsg],
    );
  } catch (err) {
    // 日志失败不能影响主流程
    console.warn('[AI日志写入失败]', err.message);
  }
}

/** AI 运行统计：给「AI 技术亮点」页面用的真实数据 */
export function aiStats(days = 7) {
  const rows = all(
    `SELECT scene,
            COUNT(*) AS total,
            SUM(cache_hit) AS cached,
            SUM(fallback) AS fallbackCount,
            AVG(latency_ms) AS avgLatency,
            SUM(rag_hits) AS ragHits,
            SUM(retry_count) AS retries
     FROM ai_call_logs
     WHERE created_at >= datetime('now','localtime', ?)
     GROUP BY scene`,
    [`-${days} days`],
  );
  const totalRow = get(
    `SELECT COUNT(*) AS total, SUM(cache_hit) AS cached, SUM(fallback) AS fb, AVG(latency_ms) AS avg
     FROM ai_call_logs WHERE created_at >= datetime('now','localtime', ?)`,
    [`-${days} days`],
  );
  return {
    days,
    totalCalls: totalRow?.total || 0,
    cacheHitRate: totalRow?.total ? Number(((totalRow.cached || 0) / totalRow.total).toFixed(2)) : 0,
    fallbackRate: totalRow?.total ? Number(((totalRow.fb || 0) / totalRow.total).toFixed(2)) : 0,
    avgLatencyMs: Math.round(totalRow?.avg || 0),
    byScene: rows.map((r) => ({
      scene: r.scene,
      total: r.total,
      cached: r.cached || 0,
      fallback: r.fallbackCount || 0,
      avgLatencyMs: Math.round(r.avgLatency || 0),
      ragHits: r.ragHits || 0,
      retries: r.retries || 0,
    })),
  };
}
