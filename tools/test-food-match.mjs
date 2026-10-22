/**
 * 食物名匹配单元测试
 * ---------------------------------------------------------------------------
 * 背景：拍照识别会把「迷你碗仔面（海鲜风味）」错配到「风味酸奶（含糖）」，
 *      两者只共享「风味」这个泛化词。修复后加了泛化词表 + 字符重叠率双重过滤。
 * 本脚本用于回归验证：正确的匹配要命中，错误的匹配必须拒绝。
 *
 * 用法：node tools/test-food-match.mjs
 */
import { matchLibraryFood } from '../server/src/ai/foodVision.js';
import { all } from '../server/src/db/index.js';

const foods = all('SELECT * FROM foods');

/** 用例：name = 模型识别出的食物名；expect = 期望匹配到的库名（null 表示应当拒绝匹配） */
const CASES = [
  // —— 应当拒绝（曾出现过误配）——
  { name: '迷你碗仔面（海鲜风味）', expect: null, why: '只与"风味酸奶"共享泛化词"风味"' },
  { name: '面汤', expect: null, why: '曾错配到"意面（熟）"，导致 300g 算出 474kcal' },
  { name: '青豆', expect: null, why: '曾错配到"青椒"' },
  { name: '葱花', expect: null, why: '曾错配到"西兰花"' },
  { name: '麻辣香锅', expect: null, why: '库中无对应条目' },

  // —— 应当命中 ——
  { name: '牛肉块', expect: '瘦牛肉（熟）', why: '共享"牛肉"且字符重叠≥0.5' },
  { name: '鸡胸肉', expect: '鸡胸肉（熟）', why: '名称包含' },
  { name: '米饭', expect: '米饭（熟）', why: '名称包含' },
  { name: '鸡蛋', expect: '鸡蛋', why: '完全一致' },
  { name: '西兰花', expect: '西兰花', why: '完全一致' },
  { name: '全麦面包', expect: '全麦面包', why: '完全一致' },
  { name: '牛油果', expect: '牛油果', why: '完全一致' },
  { name: '三文鱼', expect: '三文鱼', why: '完全一致' },
];

let pass = 0;
let fail = 0;
console.log(`食物库共 ${foods.length} 条\n`);

for (const c of CASES) {
  const hit = matchLibraryFood(c.name, foods);
  const got = hit ? hit.food.name : null;
  const ok = got === c.expect;
  if (ok) {
    pass += 1;
    console.log(`  ✓ "${c.name}" → ${got || '（正确拒绝匹配）'}`);
  } else {
    fail += 1;
    console.log(`  ✗ "${c.name}" → 期望 ${c.expect || '（拒绝）'}，实际 ${got || '（拒绝）'}  ← ${c.why}`);
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
