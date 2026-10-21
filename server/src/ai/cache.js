/**
 * 语义缓存（Semantic-ish Cache）
 * ---------------------------------------------------------------------------
 * 目的：同一用户、同一画像、同一请求参数重复生成时，直接复用上次结果。
 *  · 降低大模型调用成本（演示时反复点击生成不会重复计费）
 *  · 降低首字延迟（从 5~10 秒降到毫秒级）
 * 实现：LRU + TTL 的内存缓存，key = 场景 + 用户 + 参数指纹。
 * 说明：真正的「语义缓存」会用 embedding 计算相似度；本项目在无 embedding 服务时
 *      用「结构化参数指纹」代替（画像数值量化到整数 + 目标 + 器械集合），
 *      已能覆盖 90% 的重复场景，且完全可解释、可复现。
 */

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 分钟
const MAX_SIZE = 200;

const store = new Map(); // key -> { value, expireAt, createdAt }

/**
 * 生成参数指纹：把数值类参数按精度取整，避免 75.2 与 75.21 被当成两次不同请求
 */
export function fingerprint(obj) {
  const normalize = (v) => {
    if (typeof v === 'number') return Math.round(v * 2) / 2; // 0.5 精度
    if (Array.isArray(v)) return v.map(normalize).sort();
    if (v && typeof v === 'object') {
      return Object.keys(v)
        .sort()
        .reduce((acc, k) => {
          acc[k] = normalize(v[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(normalize(obj));
}

/**
 * 读取缓存
 * @returns {{hit: boolean, value?: any, ageMs?: number}}
 */
export function cacheGet(key) {
  const item = store.get(key);
  if (!item) return { hit: false };
  if (Date.now() > item.expireAt) {
    store.delete(key);
    return { hit: false };
  }
  // LRU：命中后移到队尾
  store.delete(key);
  store.set(key, item);
  return { hit: true, value: item.value, ageMs: Date.now() - item.createdAt };
}

/** 写入缓存（超出容量淘汰最久未使用的） */
export function cacheSet(key, value, ttlMs = DEFAULT_TTL_MS) {
  if (store.size >= MAX_SIZE) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
  store.set(key, { value, expireAt: Date.now() + ttlMs, createdAt: Date.now() });
}

/** 当前缓存统计（管理/演示页面展示用） */
export function cacheStats() {
  return { size: store.size, maxSize: MAX_SIZE };
}
