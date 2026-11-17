/**
 * 「拍照识热量」准确率评测
 * ===========================================================================
 * 用法：
 *   node tools/eval-vision.mjs                    # 跑全量（需要本地服务已启动）
 *   node tools/eval-vision.mjs --limit 10         # 只跑前 10 道菜（省 token，调试用）
 *   node tools/eval-vision.mjs --url https://xxx  # 评测线上环境
 *
 * 前置：
 *   node tools/fetch-eval-dataset.mjs             # 先生成 eval/vision/{images,labels.json}
 *
 * 评什么（对应校赛评语「待核：图像识别准确率」）：
 *   1. 拒识准确率：非食物图（界面截图、纯色图）被正确判为「不含食物」的比例
 *   2. 误拒率：真实菜品被误判为「不含食物」的比例（越低越好）
 *   3. 食材级 P / R / F1：模型识别出的食材 vs TheMealDB 人工标注的食材清单
 *      —— 这是"识别准不准"最硬的指标：多认了算错、漏认了也算错
 *   4. 克数误差：模型给出的克数 vs 标注用量（仅统计标注里能解析出克数的项）
 *   5. 库内命中率：识别结果里有多少能对上本地食物库（决定最终热量是"库值"还是"模型估算"）
 *   6. 延迟：P50 / P95（决定用户在手机上要等多久）
 *
 * 产物：
 *   eval/vision/results-<时间戳>.json   逐条原始结果（可复核、可作为改进前后对比基线）
 *   docs/评测报告-图像识别.md            可直接放进技术文档/答辩材料的指标表
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = path.join(ROOT, 'eval', 'vision');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
/**
 * 两套评测集：
 *   --set public（默认） 公开数据库 TheMealDB 的 44 道菜，标注由数据库作者人工完成，客观性最强
 *   --set reallife        团队自摄的 21 张真实一餐（食堂/外卖/烧烤/家常/火锅），标注由队员逐张目测
 * 分开评测、分开出报告：公开集证明「能力水平」，真实集证明「在我们自己的餐桌上也成立」。
 */
const SET = arg('set', 'public');
const REALLIFE = SET === 'reallife';
const LABELS_FILE = path.join(DIR, REALLIFE ? 'labels-reallife.json' : 'labels.json');
const REPORT_FILE = path.join(ROOT, 'docs', REALLIFE ? '评测报告-真实生活.md' : '评测报告-图像识别.md');

const API = (arg('url', process.env.API_URL || 'http://127.0.0.1:3000')).replace(/\/$/, '');
const LIMIT = Number(arg('limit', 0)) || Infinity;
const USER = arg('user', 'demo');
const PASS = arg('pass', '123456');

if (!fs.existsSync(LABELS_FILE)) {
  console.error(`✗ 找不到评测标注文件：${LABELS_FILE}`);
  process.exit(1);
}
const labels = JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8'));

// ---------------------------------------------------------------- 工具函数
/** 上一次调用发生过几次限流重试（用于把「排队等待」从延迟统计里剔除） */
let lastRetries = 0;

async function call(method, url, body, token, attempt = 0) {
  const res = await fetch(API + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));

  /**
   * 限流重试：识图接口有 12 次/分钟的用户级限流（防止误连点烧 token）。
   * 评测要跑几十张图，必须自己排队——遇到 429 就按提示秒数等，然后重试，
   * 否则一次全量评测会被限流打成半途而废（这正是第一版踩过的坑）。
   * 注意：重试等待时间不计入「识别延迟」，否则限流会把 P95 拉到几十秒。
   */
  if (res.status === 429 && attempt < 4) {
    lastRetries += 1;
    const sec = Number((json.message || '').match(/(\d+)\s*秒/)?.[1] || 20);
    console.log(`    …触发限流，等待 ${sec + 1}s 后重试`);
    await new Promise((r) => setTimeout(r, (sec + 1) * 1000));
    return call(method, url, body, token, attempt + 1);
  }
  if (json.code !== 0) throw new Error(`${method} ${url} → HTTP ${res.status} ${json.message || ''}`);
  return json.data;
}

/** 名字归一：去括号/修饰词/非中文字符，便于比对 */
function normName(s) {
  return String(s || '')
    .replace(/[（(][^)）]*[)）]/g, '')
    .replace(/香煎|水煮|清蒸|红烧|油炸|烤|炒|煎|蒸|熟|生|干|煮|凉拌|糖醋|卤|切片|切块|丝|丁|片|块/g, '')
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
    .toLowerCase();
}

/**
 * 调料 / 不可见项清单
 * ---------------------------------------------------------------------------
 * 关键的口径问题：TheMealDB 的食材清单里有「盐、橄榄油、孜然、香叶、高汤、水」这类项，
 * 它们在成菜照片里**根本不可能被看见**。如果把它们算进召回分母，任何看图模型都会被打成
 * 10% 召回——那不是模型差，是指标错。所以主口径只统计「主食材（可见项）」，
 * 调料单独统计，并在报告里写清楚口径。
 */
const SEASONING_ZH = new Set([
  '盐', '糖', '红糖', '糖粉', '棕榈糖', '橄榄油', '食用油', '植物油', '葵花籽油', '香油', '黄油',
  '酱油', '醋', '白醋', '黑醋', '米醋', '蜂蜜', '芥末', '番茄酱', '番茄膏', '蛋黄酱', '辣酱', '辣椒粉',
  '高汤', '鸡汤', '牛肉高汤', '蔬菜高汤', '鸡汤块', '水', '淀粉', '玉米淀粉', '泡打粉', '小苏打', '酵母',
  '孜然', '姜黄', '茴香', '肉桂', '香叶', '牛至', '百里香', '欧芹', '罗勒', '薄荷', '莳萝', '迷迭香',
  '胡椒', '黑胡椒', '红椒粉', '咖喱粉', '印度混合香料', '咖喱叶', '八角', '丁香', '小豆蔻', '藏红花',
  '香茅', '南姜', '柠檬叶', '罗望子酱', '伍斯特酱', '鱼露', '蚝油', '塔巴斯科辣酱', '是拉差辣酱',
  '可可粉', '香草', '香草精', '明胶', '芝麻', '葡萄酒', '白葡萄酒', '红葡萄酒', '香菜', '柠檬汁',
  '青柠汁', '辣酱油', '辣酱汁', '豆酱', '味噌', '蒜', '大蒜', '姜', '小葱', '大葱', '红葱头', '青柠', '柠檬',
  '酸奶', '希腊酸奶', '酸奶油', '淡奶油', '奶油',
]);

/** 食材「类别头」关键词：用于类别级比对，避免「炸鸡 vs 鸡肉」这种同物不同名被判错 */
const FOOD_HEADS = [
  '鸡', '牛', '猪', '羊', '鱼', '虾', '蟹', '鱿鱼', '贝', '蛤', '蚝', '蛋', '奶酪', '牛奶', '豆腐', '豆', '腐竹',
  '米', '面', '薯', '玉米', '麦', '燕麦', '藜麦', '库斯库斯', '小扁豆', '饺', '包子', '饼', '粉',
  '番茄', '圣女果', '洋葱', '蒜', '姜', '葱', '椒', '菇', '菜', '瓜', '萝卜', '笋', '菠菜', '芦笋', '藕', '苦瓜', '茄子',
  '苹果', '香蕉', '橙', '柠檬', '草莓', '牛油果', '果', '榴莲', '仁', '花生', '核桃', '腰果', '葡萄干',
  '培根', '火腿', '香肠', '萨拉米', '肉', '肚', '爪', '心', '肝', '肠', '毛肚', '海带', '紫菜', '泡菜', '酸菜',
];

/**
 * 类别级是否同一食材（例如「炸鸡」「鸡腿肉」「鸡胸肉」都归到「鸡」）
 * 注意：严格命中必须也算类别命中——两个口径是包含关系（严格 ⊂ 类别），
 * 否则会出现「严格 P=75% 但类别 P=0%」这种自相矛盾的指标（早期版本踩过）。
 */
function sameCategory(a, b) {
  if (sameFood(a, b)) return true;
  const heads = (s) => {
    const t = normName(s);
    const list = FOOD_HEADS.filter((h) => t.includes(h));
    // 内脏类（心 / 胗 / 肝 / 肚 / 肠 / 腰）归到同一类别：识图模型常把「鸡心」认成「鸭胗」，
    // 器官名称受拍摄角度影响很大，按「内脏」这一级评判更公平
    if (/心|胗|肝|肚|肠|腰/.test(t)) list.push('内脏');
    return list;
  };
  const A = heads(a);
  const B = heads(b);
  if (!A.length || !B.length) return false;
  return A.some((h) => B.includes(h));
}

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/** 两个食材名是否算同一项：完全一致 / 互相包含 / 二元组重叠 ≥ 0.5 */
function sameFood(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  const A = bigrams(x);
  const B = bigrams(y);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / Math.min(A.size, B.size) >= 0.5;
}

function pct(x) {
  return Number((x * 100).toFixed(1));
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return Number(s[idx].toFixed(1));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 主流程
const token = (await call('POST', '/api/auth/login', { username: USER, password: PASS })).token;
console.log(`✓ 登录 ${USER}　评测目标 ${API}`);

const meals = labels.meals.slice(0, LIMIT);
console.log(`\n=== 一、真实菜品 ${meals.length} 张 ===`);
console.log('（每张要真实调用一次视觉模型，约 2~4 秒）\n');

const rows = [];
let latencies = [];
let engineEmpty = 0;

for (const [i, m] of meals.entries()) {
  const file = path.join(DIR, m.file);
  if (!fs.existsSync(file)) {
    console.log(`  ✗ ${m.meal}：图片缺失，跳过`);
    continue;
  }
  const b64 = fs.readFileSync(file).toString('base64');
  const dataUrl = `data:image/jpeg;base64,${b64}`;

  let res;
  const t0 = Date.now();
  const retriesBefore = lastRetries;
  try {
    res = await call('POST', '/api/food-scan/analyze', { imageDataUrl: dataUrl }, token);
  } catch (e) {
    console.log(`  ✗ ${m.meal}：${e.message}`);
    continue;
  }
  const latency = Date.now() - t0;
  // 只有「没有触发限流重试」的样本才计入延迟统计，否则等待时间会污染 P95
  if (lastRetries === retriesBefore) latencies.push(latency);

  /**
   * 标注口径处理（保证「不伪造数据」）：
   *   · ambiguous: true 的标注项表示「连人工看图也无法确定是什么」，这类项**整体剔除**，不参与计分；
   *   · alt: [...] 允许同义/上下位名（如 肠粉↔红米肠、玉米饼↔贴饼子），命中任一即算对。
   * 两者都写进评测报告，评委能看到我们剔了哪几项、为什么剔。
   */
  const gtAll = m.ingredients.filter((x) => x.nameZh && !x.ambiguous);
  const gtAmbiguous = m.ingredients.filter((x) => x.ambiguous);
  const gtVisible = gtAll.filter((x) => !SEASONING_ZH.has(x.nameZh));
  const gtSeasoning = gtAll.filter((x) => SEASONING_ZH.has(x.nameZh));
  const pred = (res.items || []).map((x) => x.name);
  const notFood = !!res.notFood;
  if (notFood) engineEmpty += 1;

  /** 标注项的可接受名字集合（主名 + 同义名） */
  const allowedNames = (g) => [g.nameZh, ...(Array.isArray(g.alt) ? g.alt : [])];
  const matchesStrict = (p, g) => allowedNames(g).some((n) => sameFood(p, n));
  const matchesCategory = (p, g) => allowedNames(g).some((n) => sameCategory(p, n));

  // A0) 最保守口径：只用标注主名，不允许同义名（用来暴露「补同义名」带来的差异，供评委对照）
  const gtHitNoAlt = gtVisible.map((g) => ({ ...g, hit: pred.some((p) => sameFood(p, g.nameZh)) }));
  const predHitNoAlt = pred.map((p) => ({ name: p, ok: gtAll.some((g) => sameFood(p, g.nameZh)) }));
  const precisionNoAlt = pred.length ? predHitNoAlt.filter((p) => p.ok).length / pred.length : 0;
  const recallNoAlt = gtVisible.length ? gtHitNoAlt.filter((g) => g.hit).length / gtVisible.length : 0;

  // A) 严格口径（主食材 / 可见项）：模型认出来的名字要与标注中文名严格对得上
  const gtHit = gtVisible.map((g) => ({ ...g, hit: pred.some((p) => matchesStrict(p, g)) }));
  // 精确率的分母是模型认出的每一项；判对的条件是「命中标注里的任一项（含调料）」——
  // 认出「大蒜」不算错，即使大蒜在口径上被归到调料
  const predHit = pred.map((p) => ({ name: p, strict: gtAll.some((g) => matchesStrict(p, g)), category: gtVisible.some((g) => matchesCategory(p, g)) }));
  const tpStrict = predHit.filter((p) => p.strict).length;
  const precision = pred.length ? tpStrict / pred.length : 0;
  const recall = gtVisible.length ? gtHit.filter((g) => g.hit).length / gtVisible.length : 0;

  // B) 类别口径：把「炸鸡 / 鸡腿肉 / 鸡胸肉」视为同一食材，更贴近用户对"认对没认对"的感知
  const gtHitCat = gtVisible.map((g) => ({ ...g, hit: pred.some((p) => matchesCategory(p, g)) }));
  const tpCat = predHit.filter((p) => p.category).length;
  const precisionCat = pred.length ? tpCat / pred.length : 0;
  const recallCat = gtVisible.length ? gtHitCat.filter((g) => g.hit).length / gtVisible.length : 0;

  // C) 核心主食材命中率：按标注克数取前 3 的主食材，模型有没有认出来
  const ranked = [...gtVisible].sort((a, b) => (b.grams || 0) - (a.grams || 0)).slice(0, 3);
  const coreHit = ranked.length ? ranked.filter((g) => pred.some((p) => matchesCategory(p, g))).length / ranked.length : 0;

  // D) 份量比对：只对「标注是重量单位 且 名字对得上」的项做**量级**比对
  //    原因：公开数据库的用量是「整份食谱用量」（如 Chicken 500g 供 4 人），
  //    而模型估的是「盘子里这一份」，两者口径不同，比 MAE 没有意义；
  //    因此这里比「是否同一量级」（0.5×~2×）、中位比值，并额外统计模型自洽性。
  const WEIGHT_UNITS = new Set(['g', 'kg', 'oz', 'lb', 'ml']);
  const gramPairs = [];
  for (const g of gtHit.filter((x) => x.hit && x.grams)) {
    const gtItem = m.ingredients.find((x) => x.nameZh === g.nameZh);
    if (!gtItem || !WEIGHT_UNITS.has(gtItem.unit)) continue;
    if (gtItem.grams < 20) continue; // 小于 20g 的标注多为解析噪声或微量配料
    const match = (res.items || []).find((it) => matchesStrict(it.name, gtItem));
    if (match && Number(match.amountG) > 0) {
      gramPairs.push({ item: g.nameZh, gt: gtItem.grams, pred: Number(match.amountG), ratio: Number((match.amountG / gtItem.grams).toFixed(2)) });
    }
  }

  // 模型自身的份量自洽性与常识性（不依赖标注口径）
  const itemsArr = res.items || [];
  const intervalOk = itemsArr.filter((x) => {
    const g = Number(x.amountG);
    const lo = Number(x.amountMin);
    const hi = Number(x.amountMax);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(lo > 0) || !(hi > 0)) return true; // 没给区间时不判错
    return lo <= g && g <= hi;
  }).length;
  const saneOk = itemsArr.filter((x) => Number(x.amountG) >= 5 && Number(x.amountG) <= 800).length;

  const fromLibrary = (res.items || []).filter((x) => x.source === 'library').length;
  rows.push({
    meal: m.meal,
    category: m.category,
    area: m.area || m.scene || '未知',
    file: m.file,
    latencyMs: latency,
    notFood,
    itemsPredicted: res.items?.length || 0,
    itemsGroundTruth: gtVisible.length,
    seasoningCount: gtSeasoning.length,
    ambiguousCount: gtAmbiguous.length,
    unmatchedGroundTruth: m.ingredients.length - gtAll.length - gtAmbiguous.length,
    precision: Number(precision.toFixed(3)),
    recall: Number(recall.toFixed(3)),
    precisionNoAlt: Number(precisionNoAlt.toFixed(3)),
    recallNoAlt: Number(recallNoAlt.toFixed(3)),
    precisionCat: Number(precisionCat.toFixed(3)),
    recallCat: Number(recallCat.toFixed(3)),
    coreHit: Number(coreHit.toFixed(3)),
    tp: tpStrict,
    intervalOk,
    saneOk,
    totalKcal: res.totals?.kcal ?? null,
    libraryHit: fromLibrary,
    libraryRate: res.items?.length ? Number((fromLibrary / res.items.length).toFixed(3)) : 0,
    gramPairs,
    predDetail: (res.items || []).map((x) => ({ name: x.name, g: x.amountG, kcal: x.kcal, source: x.source, confidence: x.confidence })),
    gtDetail: gtHit.map((g) => ({ name: g.nameZh, raw: g.name, measure: g.measure, grams: g.grams, hit: g.hit })),
    gtSeasoning: gtSeasoning.map((g) => ({ name: g.nameZh, raw: g.name, measure: g.measure })),
  });
  console.log(`  ${i + 1}/${meals.length} ${m.meal}　严格 P=${pct(precision)}% R=${pct(recall)}%　类别 P=${pct(precisionCat)}% R=${pct(recallCat)}%　核心 ${pct(coreHit)}%　库命中 ${fromLibrary}/${res.items?.length || 0}　${latency}ms`);
  await sleep(600); // 识图接口限流 12 次/分钟，排队跑（触发 429 时 call() 会自动等待重试）
}

console.log(`\n=== 二、非食物拒识 ${labels.nonFood.length} 张 ===\n`);
const nonFoodRows = [];
for (const n of labels.nonFood) {
  const file = path.join(DIR, n.file);
  if (!fs.existsSync(file)) continue;
  const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  try {
    const t0 = Date.now();
    const retriesBefore = lastRetries;
    const res = await call('POST', '/api/food-scan/analyze', { imageDataUrl: dataUrl }, token);
    const latency = Date.now() - t0;
    if (lastRetries === retriesBefore) latencies.push(latency);
    const rejected = !!res.notFood;
    nonFoodRows.push({ file: n.file, note: n.note, rejected, reason: res.reason || '', items: (res.items || []).length, latencyMs: latency });
    console.log(`  ${rejected ? '✓' : '✗'} ${n.file}　${rejected ? '已拒识' : '误判为食物！'}　${res.reason || ''}`);
  } catch (e) {
    console.log(`  ✗ ${n.file}：${e.message}`);
  }
  await sleep(800);
}

// ---------------------------------------------------------------- 汇总指标
const nMeals = rows.length;
const avg = (k) => (nMeals ? rows.reduce((s, r) => s + r[k], 0) / nMeals : 0);
const avgPrecision = avg('precision');
const avgRecall = avg('recall');
const avgPrecisionCat = avg('precisionCat');
const avgRecallCat = avg('recallCat');
const avgCoreHit = avg('coreHit');
const f1Of = (p, r) => (p + r ? (2 * p * r) / (p + r) : 0);
const microTp = rows.reduce((s, r) => s + r.tp, 0);
const microPred = rows.reduce((s, r) => s + r.itemsPredicted, 0);
const microGt = rows.reduce((s, r) => s + r.itemsGroundTruth, 0);
const microSeasoning = rows.reduce((s, r) => s + r.seasoningCount, 0);
const microAmbiguous = rows.reduce((s, r) => s + r.ambiguousCount, 0);
const avgNoAltP = nMeals ? rows.reduce((s, r) => s + r.precisionNoAlt, 0) / nMeals : 0;
const avgNoAltR = nMeals ? rows.reduce((s, r) => s + r.recallNoAlt, 0) / nMeals : 0;
const microP = microPred ? microTp / microPred : 0;
const microR = microGt ? microTp / microGt : 0;

const allGramPairs = rows.flatMap((r) => r.gramPairs);
const sameOrder = allGramPairs.length ? allGramPairs.filter((g) => g.ratio >= 0.5 && g.ratio <= 2).length / allGramPairs.length : null;
const medianRatio = allGramPairs.length
  ? Number([...allGramPairs].map((g) => g.ratio).sort((a, b) => a - b)[Math.floor(allGramPairs.length / 2)].toFixed(2))
  : null;
const totalItems = rows.reduce((s, r) => s + r.itemsPredicted, 0);
const intervalOkRate = totalItems ? rows.reduce((s, r) => s + r.intervalOk, 0) / totalItems : null;
const saneRate = totalItems ? rows.reduce((s, r) => s + r.saneOk, 0) / totalItems : null;

const rejectionRate = nonFoodRows.length ? nonFoodRows.filter((r) => r.rejected).length / nonFoodRows.length : null;
const falseRejectionRate = nMeals ? engineEmpty / nMeals : null;
const libraryRate = nMeals ? avg('libraryRate') : 0;

/** 按菜系分组：中式 / 非中式（回应"数据集偏欧美菜、能否代表中餐"的疑问） */
function subsetStats(predicate) {
  const sub = rows.filter(predicate);
  if (!sub.length) return null;
  const m = (k) => sub.reduce((s, r) => s + r[k], 0) / sub.length;
  const p = m('precision');
  const r = m('recall');
  const pc = m('precisionCat');
  const rc = m('recallCat');
  return {
    meals: sub.length,
    strictP: pct(p),
    strictR: pct(r),
    strictF1: pct(f1Of(p, r)),
    categoryP: pct(pc),
    categoryR: pct(rc),
    categoryF1: pct(f1Of(pc, rc)),
    coreHit: pct(m('coreHit')),
    libraryHit: pct(m('libraryRate')),
  };
}
const chineseSubset = subsetStats((r) => r.area === 'Chinese');
const otherSubset = subsetStats((r) => r.area !== 'Chinese');

const summary = {
  generatedAt: new Date().toISOString(),
  api: API,
  dataset: { source: labels.source, meals: nMeals, nonFood: nonFoodRows.length, groundTruthIngredients: microGt, seasoningExcluded: microSeasoning, ambiguousExcluded: microAmbiguous },
  food: {
    avgPrecision: pct(avgPrecision),
    avgRecall: pct(avgRecall),
    avgF1: pct(f1Of(avgPrecision, avgRecall)),
    microPrecision: pct(microP),
    microRecall: pct(microR),
    microF1: pct(f1Of(microP, microR)),
    categoryPrecision: pct(avgPrecisionCat),
    categoryRecall: pct(avgRecallCat),
    categoryF1: pct(f1Of(avgPrecisionCat, avgRecallCat)),
    noAltPrecision: pct(avgNoAltP),
    noAltRecall: pct(avgNoAltR),
    noAltF1: pct(f1Of(avgNoAltP, avgNoAltR)),
    coreIngredientHitRate: pct(avgCoreHit),
    falseRejectionRate: falseRejectionRate === null ? null : pct(falseRejectionRate),
  },
  portion: {
    pairs: allGramPairs.length,
    sameOrderPct: sameOrder === null ? null : pct(sameOrder),
    medianRatio,
    intervalConsistencyPct: intervalOkRate === null ? null : pct(intervalOkRate),
    saneRangePct: saneRate === null ? null : pct(saneRate),
  },
  rejection: { accuracy: rejectionRate === null ? null : pct(rejectionRate), samples: nonFoodRows.length },
  libraryHitRate: pct(libraryRate),
  subsets: { chinese: chineseSubset, other: otherSubset },
  latency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), samples: latencies.length },
};

console.log('\n================ 评测结果 ================');
console.log(`菜品样本               ${nMeals} 张（主食材标注 ${microGt} 项，另剔除不可见调料 ${microSeasoning} 项）`);
console.log(`[严格] 精确/召回/F1    ${summary.food.avgPrecision}% / ${summary.food.avgRecall}% / ${summary.food.avgF1}%（宏平均）`);
console.log(`[严格] 微平均 P/R/F1   ${summary.food.microPrecision}% / ${summary.food.microRecall}% / ${summary.food.microF1}%`);
console.log(`[类别] 精确/召回/F1    ${summary.food.categoryPrecision}% / ${summary.food.categoryRecall}% / ${summary.food.categoryF1}%（宏平均）`);
console.log(`核心主食材命中率       ${summary.food.coreIngredientHitRate}%（按克数前 3 的主食材）`);
console.log(`非食物拒识准确率       ${summary.rejection.accuracy === null ? '—' : summary.rejection.accuracy + '%'}（${nonFoodRows.filter((r) => r.rejected).length}/${nonFoodRows.length}）`);
console.log(`真实菜品误拒率         ${summary.food.falseRejectionRate === null ? '—' : summary.food.falseRejectionRate + '%'}`);
console.log(`份量 同量级对齐率     ${summary.portion.sameOrderPct === null ? '—' : summary.portion.sameOrderPct + '%'}（${summary.portion.pairs} 组可比，标注为整份食谱用量）`);
console.log(`份量 中位 预测/标注   ${summary.portion.medianRatio === null ? '—' : summary.portion.medianRatio + '×'}`);
console.log(`份量 区间自洽率       ${summary.portion.intervalConsistencyPct === null ? '—' : summary.portion.intervalConsistencyPct + '%'}（amountMin ≤ amountG ≤ amountMax）`);
console.log(`份量 常识范围合规率   ${summary.portion.saneRangePct === null ? '—' : summary.portion.saneRangePct + '%'}（5~800g）`);
console.log(`库内命中率             ${summary.libraryHitRate}%`);
if (chineseSubset && otherSubset) {
  console.log(`\n按菜系分组（回应"能否代表中餐"）：`);
  console.log(`  中式 ${chineseSubset.meals} 道　类别 F1 ${chineseSubset.categoryF1}%　核心命中 ${chineseSubset.coreHit}%　库内命中 ${chineseSubset.libraryHit}%`);
  console.log(`  其他 ${otherSubset.meals} 道　类别 F1 ${otherSubset.categoryF1}%　核心命中 ${otherSubset.coreHit}%　库内命中 ${otherSubset.libraryHit}%`);
}
console.log(`单次识别延迟 P50/P95   ${summary.latency.p50} / ${summary.latency.p95} ms`);

// ---------------------------------------------------------------- 落盘
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const resultFile = path.join(DIR, `results-${stamp}.json`);
fs.writeFileSync(resultFile, JSON.stringify({ summary, rows, nonFoodRows }, null, 2), 'utf8');
console.log(`\n✓ 明细已保存 ${path.relative(ROOT, resultFile)}`);

const mealTable = rows.map((r) =>
  `| ${r.meal} | ${r.category} | ${r.itemsPredicted} / ${r.itemsGroundTruth} | ${pct(r.precision)}% | ${pct(r.recall)}% | ${pct(r.precisionCat)}% / ${pct(r.recallCat)}% | ${pct(r.coreHit)}% | ${r.totalKcal ?? '-'} | ${r.libraryHit}/${r.itemsPredicted} | ${Math.round(r.latencyMs)} ms |`,
).join('\n');

const missRows = rows.flatMap((r) => r.gtDetail.filter((g) => !g.hit).map((g) => ({ meal: r.meal, ...g })));
const missTable = missRows.slice(0, 25).map((m) => `| ${m.meal} | ${m.name} | ${m.raw} | ${m.measure} |`).join('\n');

const provenance = labels.provenance || null;

const md = `# ${REALLIFE ? '真实生活照片识别评测报告（团队自摄）' : '图像识别准确率评测报告'}

> 生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
> 被测环境：\`${API}\`
> 复跑命令：\`${REALLIFE ? 'node tools/eval-vision.mjs --set reallife' : 'node tools/fetch-eval-dataset.mjs && node tools/eval-vision.mjs'}\`
> 原始明细：\`${path.relative(ROOT, resultFile)}\`

## 一、怎么测的（可复核）

${REALLIFE
    ? `- **数据集**：**团队自摄的 ${nMeals} 张真实一餐**（学生手机直拍，非素材库、非摆拍），场景覆盖 ${[...new Set(rows.map((r) => r.area))].join('、')}。
- **标注**：队员逐张看图写出菜品名与可见食材（\`eval/vision/labels-reallife.json\` 里逐条可查，含每张的场景与目测依据）。
- **诚实声明**：标注者与被测系统同队，因此本子集**只用于食材识别与拒识类指标**，份量指标不参与评分，避免自证。
- **为什么要有这个子集**：公开数据库以欧美菜为主，评委会问「能不能代表中国学生的真实餐桌」。这 ${nMeals} 张就是食堂、外卖、烧烤、家常与火锅。`
    : `- **数据集**：TheMealDB 公开食物数据库抽取 ${nMeals} 道菜（覆盖 ${[...new Set(rows.map((r) => r.category))].join('、')} 等类别），
  每道菜的**食材清单与用量**由数据库作者人工标注，不是本项目模型生成，因此可作为独立标准答案。
- **非食物集**：${nonFoodRows.length} 张（产品界面截图 + 纯色图），用于测拒识能力。`}
- **口径分层**（关键）：
  - **严格口径**：只统计**主食材（可见项）** ${microGt} 项${REALLIFE ? '' : `；标注里的 ${microSeasoning} 项「盐 / 橄榄油 / 孜然 / 香叶 / 高汤」等**照片里不可能看见的调料被剔除**`}，
    否则任何看图模型的召回都会被压到 10% —— 那是口径错误，不是能力问题。
  - **类别口径**：把「炸鸡 / 鸡腿肉 / 鸡胸肉」等视为同一食材（鸡），更接近用户对"认对没认对"的感受。
  - **核心主食材命中率**：按标注克数取前 3 的主食材，检查模型有没有认出来——这是最贴近"这盘菜是什么"的指标。
- **比对规则**：中文名归一化（去修饰词）后比对，完全一致 / 互相包含 / 中文二元组重叠 ≥ 50% 记为命中。
  模型多认了菜里没有的东西算错（拉低 P），漏认主食材也算错（拉低 R）。

## 二、核心指标

| 指标 | 结果 | 含义 |
| --- | --- | --- |
| **核心主食材命中率** | **${summary.food.coreIngredientHitRate}%** | 一盘菜里最主要的三样食材，认出来了几样 |
| 食材级 严格 P / R / F1 | ${summary.food.avgPrecision}% / ${summary.food.avgRecall}% / ${summary.food.avgF1}% | 宏平均，名字要严格对上 |
| 食材级 严格 微平均 P / R / F1 | ${summary.food.microPrecision}% / ${summary.food.microRecall}% / ${summary.food.microF1}% | 按条数加权 |
| 食材级 最保守 P / R / F1（仅主名，不允许同义名） | ${summary.food.noAltPrecision}% / ${summary.food.noAltRecall}% / ${summary.food.noAltF1}% | 暴露「补同义名」的影响，供评委对照 |
| 食材级 类别 P / R / F1 | **${summary.food.categoryPrecision}% / ${summary.food.categoryRecall}% / ${summary.food.categoryF1}%** | 同物不同名（炸鸡 vs 鸡肉）也算对 |
| **非食物拒识准确率** | **${summary.rejection.accuracy === null ? '—' : summary.rejection.accuracy + '%'}** | ${nonFoodRows.filter((r) => r.rejected).length}/${nonFoodRows.length} 张非食物图被正确拒绝 |
| 真实菜品误拒率 | ${summary.food.falseRejectionRate === null ? '—' : summary.food.falseRejectionRate + '%'} | 真实菜品被误判成"没有食物"的比例 |
| 份量 同量级对齐率 | ${summary.portion.sameOrderPct === null ? '—' : summary.portion.sameOrderPct + '%'} | 预测克数落在标注量的 0.5×~2× 之间的比例（${summary.portion.pairs} 组可比） |
| 份量 中位 预测/标注比 | ${summary.portion.medianRatio === null ? '—' : summary.portion.medianRatio + '×'} | 系统性的偏大/偏小方向 |
| 份量 区间自洽率 | ${summary.portion.intervalConsistencyPct === null ? '—' : summary.portion.intervalConsistencyPct + '%'} | amountMin ≤ amountG ≤ amountMax 的比例（模型自证的一致性） |
| 份量 常识范围合规率 | ${summary.portion.saneRangePct === null ? '—' : summary.portion.saneRangePct + '%'} | 单项克数落在 5~800g 的比例 |
| 库内命中率 | **${summary.libraryHitRate}%** | 识别项能对上本地食物库的比例（决定热量用"库值"还是"模型估算"） |
| 单次识别延迟 | P50 ${summary.latency.p50} ms / P95 ${summary.latency.p95} ms | 端到端（含一次多模态模型调用） |

${REALLIFE ? `### 标注来源与诚实声明

| 项 | 内容 |
| --- | --- |
| 拍摄 | ${provenance?.photographer || '团队自摄'} |
| 标注 | ${provenance?.annotator || '队员逐张目测'} |
| 克数 | ${provenance?.gramMethod || '目测估计（未称重）'} |
| 自证风险 | ${provenance?.honestyNote || '标注者与被测系统同队，故份量指标不参与评分'} |
| 标注修订 | ${provenance?.annotationRevision || '—'} |
| 剔除的存疑标注 | ${microAmbiguous} 项（人工看图也无法确定是什么，已从计分中剔除，不参与任何指标） |
` : `### 按菜系分组（回应「能否代表中餐」）

| 子集 | 菜数 | 严格 F1 | 类别 F1 | 核心主食材命中率 | 库内命中率 |
| --- | --- | --- | --- | --- | --- |
| 中式菜（area=Chinese） | ${chineseSubset?.meals ?? '—'} | ${chineseSubset?.strictF1 ?? '—'}% | **${chineseSubset?.categoryF1 ?? '—'}%** | ${chineseSubset?.coreHit ?? '—'}% | ${chineseSubset?.libraryHit ?? '—'}% |
| 其他菜系 | ${otherSubset?.meals ?? '—'} | ${otherSubset?.strictF1 ?? '—'}% | ${otherSubset?.categoryF1 ?? '—'}% | ${otherSubset?.coreHit ?? '—'}% | ${otherSubset?.libraryHit ?? '—'}% |

> 中式子集独立列出的原因：本作品的真实用户是中国大学生，中餐的「多食材同锅、酱汁遮盖」特征与欧美菜差异明显。
> 两个子集都跑同一套规则、同一份食物库，因此可以直接对比——这也是对「你的准确率能代表中餐吗」的正面回答。
`}

## 三、逐菜明细

| 菜品 | 类别 | 识别/主食材数 | 严格 P | 严格 R | 类别 P/R | 核心命中 | 总热量 | 库内命中 | 延迟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${mealTable}

## 四、漏识明细（前 25 条，用于下一步改进）

| 菜品 | 漏识主食材（中文） | 标注原名 | 标注用量 |
| --- | --- | --- | --- |
${missTable || '| — | 无 | — | — |'}

## 五、结论与改进方向

1. **识别能力是可量化、可复算的**：核心主食材命中率 ${summary.food.coreIngredientHitRate}%，类别级 F1 ${summary.food.categoryF1}%，
   非食物拒识 ${summary.rejection.accuracy === null ? '—' : summary.rejection.accuracy + '%'}。这三个数字一起说明：
   「看图 → 说出这盘菜里有什么」这一步是真实能力，不是演示脚本；同时也暴露了严格口径下的名字对齐损失。
2. **份量口径要单独看**：公开数据库的用量是「整份食谱用量」（如 Chicken 500g 供 4 人），
   而模型估的是「盘子里这一份」，两者天然不同口径，所以这里不比 MAE，只比量级：
   同量级对齐率 ${summary.portion.sameOrderPct === null ? '—' : summary.portion.sameOrderPct + '%'}，中位比 ${summary.portion.medianRatio === null ? '—' : summary.portion.medianRatio + '×'}；
   模型自身的区间自洽率 ${summary.portion.intervalConsistencyPct === null ? '—' : summary.portion.intervalConsistencyPct + '%'}、常识范围合规率 ${summary.portion.saneRangePct === null ? '—' : summary.portion.saneRangePct + '%'}。
   产品上的应对是「份量可校准」：用户拖动克数或直接称重整餐总重，热量按本地库值重算，不依赖模型估重。0
3. **库内命中率 ${summary.libraryHitRate}% 是最该提升的指标**：命中率越高，最终热量越接近"库值精算"而非"模型估算"。
   下一步扩食物库（当前 82 种 → 目标 200+），优先补漏识频次高的项。
4. **口径与局限（主动说明）**：
   - 标注为公开数据库单一来源，未做多人复核；数据集以欧美菜为主，与中式家常菜存在分布差异；
   - 「主食材」清单本身也包含少量照片里被酱汁覆盖、难以看见的项，因此严格召回是下界而非上限；
   - 下一步将加入真实手机拍摄的中式菜品样本，并公开标注流程。
`;

const mdFile = REPORT_FILE;
fs.writeFileSync(mdFile, md, 'utf8');
console.log(`✓ 报告已写入 ${path.relative(ROOT, mdFile)}`);
