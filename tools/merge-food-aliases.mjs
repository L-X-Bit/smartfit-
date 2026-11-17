/**
 * 食物库别名合并（把「扩展条目」的别名归并到「基础条目」，并剔除重复条目）
 * ===========================================================================
 * 用法：
 *   node tools/merge-food-aliases.mjs          # 重算别名文件（幂等，可重复执行）
 *   node tools/merge-food-aliases.mjs --dry    # 只看会改什么
 *
 * 背景（真实踩坑）：
 *   省赛前扩充食物库时，我按常见中式菜写了 172 条新食物，但基础库里已经有 82 条，
 *   其中 47 条是同一个东西（馒头、番茄、鸡胸肉…），直接入库会出现「两条鸡胸肉」，
 *   视觉模型匹配到哪条全看运气，指标反而更差。
 *
 * 做法：
 *   1. 同名的扩展条目丢弃，但把它写好的**别名**归并到基础条目上
 *      （例如基础「番茄」拿到「西红柿 / 番茄块 / tomato」，识图命中率立刻提升）；
 *   2. 近义但不同名的（鸡腿肉 vs 去皮鸡腿肉（熟））按 NEAR_DUP 表人工指定归属；
 *   3. 产出两份文件：
 *      · server/data/kb/foods.extra.json    —— 只保留真正新增的食物
 *      · server/data/kb/food-aliases.json   —— { 食物id: [别名…] }，seed / sync 都会应用
 *
 * 为什么不用脚本自动判断近义：中文食物名没有可靠规则（「牛奶巧克力」vs「牛奶」），
 * 自动判断会误合，宁可人工列一张小表，把判断依据留在代码里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KB = path.join(ROOT, 'server', 'data', 'kb');
const DRY = process.argv.includes('--dry');

/** 去掉「（熟）」「（干）」等括号说明，用于同名判断 */
const norm = (s) => String(s).replace(/[（(].*?[）)]/g, '').trim();

/**
 * 近义条目归属表：key = 扩展条目的 id，value = 基础库条目的 id
 * 这些是「同一个食物、不同叫法」，扩展条目的别名归并到基础条目后，扩展条目删除。
 */
const NEAR_DUP = {
  fd_x_chicken_thigh: 'fd_chicken_thigh', // 鸡腿肉 → 去皮鸡腿肉（熟）
  fd_x_beef_lean: 'fd_beef_lean', // 牛肉（瘦，熟）→ 瘦牛肉（熟）
  fd_x_tofu_firm: 'fd_tofu', // 豆腐（北豆腐）→ 北豆腐
  fd_x_tofu_silken: null, // 嫩豆腐是另一种食物，保留
  fd_x_soymilk: 'fd_soy_milk', // 豆浆（无糖）→ 无糖豆浆
  fd_x_shrimp: 'fd_shrimp', // 虾（熟）→ 基围虾
  fd_x_greek_yogurt: 'fd_greek_yogurt', // 希腊酸奶（无糖）→ 无糖希腊酸奶
  fd_x_milk_whole: 'fd_milk', // 牛奶（全脂）→ 全脂牛奶
  fd_x_milk_skim: 'fd_skim_milk', // 牛奶（脱脂）→ 脱脂牛奶
  fd_x_americano: 'fd_coffee', // 美式咖啡（无糖）→ 黑咖啡（无糖）
  fd_x_milk_tea: 'fd_milk_tea', // 奶茶（含糖）→ 全糖奶茶
  fd_x_chocolate: 'fd_chocolate', // 巧克力 → 牛奶巧克力
  fd_x_cake: 'fd_cake', // 蛋糕 → 奶油蛋糕
  fd_x_yogurt: 'fd_yogurt_drink', // 酸奶（含糖）→ 风味酸奶（含糖）
  fd_x_oatmeal: 'fd_oats', // 燕麦片（干）→ 燕麦片（干）
  fd_x_beer: 'fd_beer', // 啤酒
};

const base = JSON.parse(fs.readFileSync(path.join(KB, 'foods.json'), 'utf8'));
const extra = JSON.parse(fs.readFileSync(path.join(KB, 'foods.extra.json'), 'utf8'));
const aliasFile = path.join(KB, 'food-aliases.json');
const existingAliases = fs.existsSync(aliasFile) ? JSON.parse(fs.readFileSync(aliasFile, 'utf8')) : {};

const baseByName = new Map(base.map((f) => [norm(f.name), f]));
const aliasMap = { ...existingAliases }; // 累积，保留人工加过的别名
const addAliases = (id, list) => {
  if (!id) return;
  const set = new Set(aliasMap[id] || []);
  list.filter(Boolean).forEach((a) => set.add(String(a)));
  aliasMap[id] = [...set];
};

const kept = [];
const dropped = [];

for (const f of extra) {
  const nearTarget = NEAR_DUP[f.id];
  const sameName = baseByName.get(norm(f.name));

  if (nearTarget === null) { // 明确保留
    kept.push(f);
    addAliases(f.id, f.aliases || []);
    continue;
  }
  const target = nearTarget || sameName?.id;
  if (target) {
    // 归并别名到基础条目，丢弃扩展条目
    addAliases(target, f.aliases || []);
    addAliases(target, [f.name.replace(/[（(].*?[）)]/g, '').trim()]); // 扩展条目的主名也当作别名
    dropped.push({ from: f.id, to: target, name: f.name });
    continue;
  }
  kept.push(f);
  addAliases(f.id, f.aliases || []);
}

// 基础库自身的常用口语别名（人工整理，命中率提升最直接的一批）
const BASE_ALIASES = {
  fd_rice: ['白米饭', '大米饭', '米饭'],
  fd_noodle_soup: ['牛肉面', '拉面', '汤面', '面条'],
  fd_pasta: ['意大利面', '意面', 'pasta', 'spaghetti'],
  fd_potato: ['土豆', '马铃薯', '洋芋'],
  fd_sweet_potato: ['红薯', '地瓜', '番薯'],
  fd_corn: ['玉米', '甜玉米', '玉米棒'],
  fd_egg: ['鸡蛋', '水煮蛋', '煮鸡蛋', '煎蛋', 'egg'],
  fd_chicken_breast: ['鸡胸肉', '鸡胸', '水煮鸡胸'],
  fd_chicken_thigh: ['鸡腿肉', '鸡腿'],
  fd_beef_lean: ['牛肉', '牛肉块', '牛肉片', '酱牛肉'],
  fd_pork_loin: ['猪里脊', '里脊肉', '瘦猪肉', '猪肉'],
  fd_salmon: ['三文鱼', '鲑鱼'],
  fd_shrimp: ['虾', '虾仁', '大虾', '白灼虾', '基围虾'],
  fd_tofu: ['豆腐', '老豆腐', '北豆腐'],
  fd_soy_milk: ['豆浆', '豆奶'],
  fd_tomato: ['西红柿', '番茄块', 'tomato'],
  fd_cherry_tomato: ['圣女果', '小番茄', '樱桃番茄'],
  fd_pepper: ['青椒', '彩椒', '甜椒', '柿子椒'],
  fd_cabbage: ['白菜', '大白菜', '圆白菜', '卷心菜', '包菜'],
  fd_lettuce: ['生菜', '油麦菜', '沙拉菜'],
  fd_mushroom: ['香菇', '冬菇', '蘑菇'],
  fd_kelp: ['海带', '海带丝', '裙带菜'],
  fd_edamame: ['毛豆', '毛豆仁'],
  fd_chickpea: ['鹰嘴豆'],
  fd_cola: ['可乐', '可口可乐', '汽水'],
  fd_beer: ['啤酒', '生啤'],
  fd_coffee: ['咖啡', '黑咖啡', '美式', '美式咖啡'],
  fd_milk_tea: ['奶茶', '珍珠奶茶', '红茶拿铁'],
  fd_chips: ['薯片', '土豆片'],
  fd_chocolate: ['巧克力', '黑巧克力', '牛奶巧克力'],
  fd_cake: ['蛋糕', '奶油蛋糕', '海绵蛋糕'],
  fd_ice_cream: ['冰淇淋', '雪糕', '冰激凌'],
  fd_olive_oil: ['橄榄油'],
  fd_honey: ['蜂蜜', '蜜糖'],
  fd_peanut: ['花生', '花生米'],
  fd_walnut: ['核桃', '核桃仁'],
  fd_almond: ['杏仁', '巴旦木'],
  fd_fried_chicken: ['炸鸡', '肯德基炸鸡', '炸鸡块', 'fried chicken'],
  fd_milk: ['牛奶', '纯牛奶', '全脂牛奶'],
  fd_skim_milk: ['脱脂牛奶', '低脂牛奶'],
  fd_greek_yogurt: ['希腊酸奶'],
  fd_yogurt_drink: ['酸奶', '含糖酸奶', '风味酸奶'],
  fd_yogurt: ['酸奶'],
  fd_quinoa: ['藜麦', '藜麦饭'],
  fd_buckwheat: ['荞麦面', '荞麦面条'],
  fd_rice_noodle: ['米粉', '米线', '河粉'],
  fd_whole_bread: ['全麦面包', '全麦吐司'],
  fd_avocado: ['牛油果', '鳄梨'],
  fd_raspberry: [],
};
for (const [id, list] of Object.entries(BASE_ALIASES)) {
  if (!base.some((f) => f.id === id)) continue;
  addAliases(id, list);
}

// 清理空数组
for (const id of Object.keys(aliasMap)) if (!aliasMap[id]?.length) delete aliasMap[id];

const total = base.length + kept.length;
const aliasCount = Object.keys(aliasMap).length;
console.log(`基础库 ${base.length} 条 + 新增 ${kept.length} 条 = ${total} 条食物（丢弃重复 ${dropped.length} 条）`);
console.log(`带别名的食物 ${aliasCount} 条，别名总数 ${Object.values(aliasMap).reduce((s, v) => s + v.length, 0)} 个`);
if (dropped.length) console.log('丢弃的重复条目：\n' + dropped.map((d) => `  · ${d.from}（${d.name}）→ ${d.to}`).join('\n'));

if (DRY) {
  console.log('（--dry 模式，不写文件）');
  process.exit(0);
}

fs.writeFileSync(path.join(KB, 'foods.extra.json'), JSON.stringify(kept, null, 2) + '\n', 'utf8');
fs.writeFileSync(aliasFile, JSON.stringify(aliasMap, null, 2) + '\n', 'utf8');
console.log(`✓ 已写入 foods.extra.json（${kept.length} 条）与 food-aliases.json（${aliasCount} 条映射）`);
