/**
 * 构建「拍照识热量」评测集
 * ===========================================================================
 * 数据来源：TheMealDB（https://www.themealdb.com/api.php，公开免费食物数据库）
 *   · 每道菜带有人工编写的菜名、菜系、以及**逐项食材 + 用量**（如 "Chicken" 500g）
 *   · 这些字段是数据库作者标注的，不是我们模型生成的，因此可以作为独立的标准答案（golden）
 *
 * 用法：
 *   node tools/fetch-eval-dataset.mjs              # 抓 18 道菜
 *   node tools/fetch-eval-dataset.mjs --count 30   # 抓更多
 *   node tools/fetch-eval-dataset.mjs --offline    # 只重建 labels.json，不联网
 *
 * 产物：
 *   eval/vision/images/*.jpg   菜品照片
 *   eval/vision/labels.json    标准答案：菜名 / 菜系 / 食材（英文原词 + 中文映射 + 克数）
 *   eval/vision/nonfood/*.png  非食物样本（UI 截图 + 合成图），用来测「拒识率」
 *
 * 为什么份量/食材要留英文原词：
 *   评测脚本按「中文映射」比对模型输出的中文菜名，但保留原词便于人工/评委逐条复核，
 *   避免出现「映射表写错了却看不出」的情况。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = path.join(ROOT, 'eval', 'vision');
const IMG_DIR = path.join(DIR, 'images');
const NONFOOD_DIR = path.join(DIR, 'nonfood');
const LABELS = path.join(DIR, 'labels.json');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const COUNT = Number(arg('count', 18));
const OFFLINE = argv.includes('--offline');

/**
 * 常见食材英文 → 中文映射（只覆盖评测需要的高频项）
 * 未收录的食材在 labels.json 里 nameZh 为 null，评测时不计入召回分母，但会单独统计「未映射数」。
 */
export const INGREDIENT_ZH = {
  chicken: '鸡肉', 'chicken breast': '鸡胸肉', 'chicken breasts': '鸡胸肉', beef: '牛肉', 'beef mince': '牛肉末',
  pork: '猪肉', bacon: '培根', ham: '火腿', lamb: '羊肉', salmon: '三文鱼', tuna: '金枪鱼', prawns: '虾仁',
  shrimp: '虾仁', fish: '鱼', egg: '鸡蛋', eggs: '鸡蛋', rice: '米饭', 'basmati rice': '米饭', pasta: '意面',
  spaghetti: '意面', noodles: '面条', bread: '面包', flour: '面粉', potato: '土豆', potatoes: '土豆',
  onion: '洋葱', 'red onion': '洋葱', garlic: '大蒜', 'garlic clove': '大蒜', 'garlic cloves': '大蒜',
  tomato: '番茄', tomatoes: '番茄', 'tomato puree': '番茄酱', carrot: '胡萝卜', carrots: '胡萝卜',
  broccoli: '西兰花', spinach: '菠菜', lettuce: '生菜', cucumber: '黄瓜', pepper: '彩椒', 'red pepper': '彩椒',
  mushroom: '蘑菇', mushrooms: '蘑菇', corn: '玉米', peas: '豌豆', beans: '豆类', chickpeas: '鹰嘴豆',
  cheese: '奶酪', 'cheddar cheese': '奶酪', parmesan: '帕玛森奶酪', milk: '牛奶', butter: '黄油',
  cream: '奶油', yogurt: '酸奶', 'olive oil': '橄榄油', oil: '食用油', sugar: '糖', honey: '蜂蜜',
  salt: '盐', 'soy sauce': '酱油', ginger: '姜', chilli: '辣椒', 'chilli powder': '辣椒粉', lime: '青柠',
  lemon: '柠檬', apple: '苹果', banana: '香蕉', orange: '橙子', strawberry: '草莓', avocado: '牛油果',
  'spring onions': '小葱', 'spring onion': '小葱', celery: '芹菜', cabbage: '卷心菜', aubergine: '茄子',
  courgette: '西葫芦', 'plain flour': '面粉', 'self-raising flour': '面粉', water: '水', stock: '高汤',
  // 第二轮补充：把常见调味 / 部位 / 主食补齐，减少「未映射」稀释召回分母
  'chicken thighs': '鸡腿肉', 'chicken legs': '鸡腿', 'chicken thigh': '鸡腿肉', 'chicken wings': '鸡翅',
  'chicken stock': '鸡汤', 'beef stock': '牛肉高汤', 'vegetable stock': '蔬菜高汤', 'chicken stock cube': '鸡汤块',
  mayonnaise: '蛋黄酱', 'lemon juice': '柠檬汁', 'lime juice': '青柠汁', buns: '面包', bun: '面包',
  'burger buns': '面包', shallots: '红葱头', challots: '红葱头', 'spring onions': '小葱', scallions: '小葱',
  cumin: '孜然', coriander: '香菜', turmeric: '姜黄', fennel: '茴香', 'fennel bulb': '茴香',
  'tamarind paste': '罗望子酱', 'hot sauce': '辣酱', hotsauce: '辣酱', 'chilli sauce': '辣酱',
  'tomato ketchup': '番茄酱', ketchup: '番茄酱', mustard: '芥末', vinegar: '醋', 'white wine vinegar': '白醋',
  'balsamic vinegar': '黑醋', wine: '葡萄酒', 'white wine': '白葡萄酒', 'red wine': '红葡萄酒',
  paprika: '红椒粉', cinnamon: '肉桂', 'bay leaf': '香叶', 'bay leaves': '香叶', oregano: '牛至',
  thyme: '百里香', parsley: '欧芹', basil: '罗勒', mint: '薄荷', dill: '莳萝', rosemary: '迷迭香',
  'black pepper': '黑胡椒', pepper: '胡椒', 'sea salt': '盐', 'caster sugar': '糖', 'brown sugar': '红糖',
  'icing sugar': '糖粉', 'double cream': '淡奶油', 'sour cream': '酸奶油', 'greek yogurt': '希腊酸奶',
  'cream cheese': '奶油奶酪', mozzarella: '马苏里拉奶酪', 'parmesan cheese': '帕玛森奶酪',
  'olive oil': '橄榄油', 'sunflower oil': '葵花籽油', 'vegetable oil': '植物油', 'sesame oil': '香油',
  'coconut milk': '椰奶', 'soy sauce': '酱油', 'fish sauce': '鱼露', 'oyster sauce': '蚝油',
  'rice vinegar': '米醋', 'sesame seeds': '芝麻', peanuts: '花生', almonds: '杏仁', walnuts: '核桃',
  'cashew nuts': '腰果', raisins: '葡萄干', 'dried apricots': '杏干', 'dark chocolate': '黑巧克力',
  chocolate: '巧克力', cocoa: '可可粉', vanilla: '香草', 'vanilla extract': '香草精', gelatin: '明胶',
  'baking powder': '泡打粉', 'bicarbonate of soda': '小苏打', yeast: '酵母', cornflour: '玉米淀粉',
  'corn flour': '玉米淀粉', 'rice noodles': '米粉', 'egg noodles': '鸡蛋面', couscous: '库斯库斯',
  quinoa: '藜麦', lentils: '小扁豆', 'black beans': '黑豆', 'kidney beans': '芸豆', tofu: '豆腐',
  'prawn crackers': '虾片', squid: '鱿鱼', calamari: '鱿鱼', mussels: '贻贝', clams: '蛤蜊', crab: '蟹肉',
  'smoked salmon': '烟熏三文鱼', 'cod fillet': '鳕鱼', haddock: '黑线鳕', sardines: '沙丁鱼',
  'pork belly': '五花肉', 'pork chops': '猪排', 'pork mince': '猪肉末', sausages: '香肠', chorizo: '西班牙香肠',
  salami: '萨拉米', prosciutto: '意式火腿', 'lamb mince': '羊肉末', 'lamb chops': '羊排',
  'minced beef': '牛肉末', 'beef steak': '牛排', steak: '牛排',
  'sweet potato': '红薯', 'sweet potatoes': '红薯', pumpkin: '南瓜', 'butternut squash': '南瓜',
  celery: '芹菜', leek: '大葱', 'pak choi': '小白菜', 'bok choy': '小白菜', 'green beans': '青豆角',
  asparagus: '芦笋', 'bean sprouts': '豆芽', radish: '萝卜', turnip: '芜菁', beetroot: '甜菜根',
  'red cabbage': '紫甘蓝', 'sweetcorn': '玉米粒', olives: '橄榄', pickles: '酸黄瓜', capers: '酸豆',
  'sun-dried tomatoes': '油浸番茄', 'cherry tomatoes': '圣女果', 'passata': '番茄膏', 'tomato sauce': '番茄酱',
  'worcestershire sauce': '伍斯特酱', 'tabasco': '塔巴斯科辣酱', 'sriracha': '是拉差辣酱',
  'curry powder': '咖喱粉', 'garam masala': '印度混合香料', 'curry leaves': '咖喱叶',
  'star anise': '八角', 'cloves': '丁香', cardamom: '小豆蔻', saffron: '藏红花', 'lemon grass': '香茅',
  'lemongrass': '香茅', galangal: '南姜', 'kaffir lime leaves': '柠檬叶', 'palm sugar': '棕榈糖',
};

/**
 * 从 TheMealDB 的用量字段里解析「重量」与「单位」
 * ---------------------------------------------------------------------------
 * 为什么要区分单位：
 *   「1 tbsp」「2 cloves」这类用量换算成克非常不可靠，而「500g」「1kg」是可靠的。
 *   评测时只用**重量单位**（g/kg/oz/lb/ml）的项做量级比对，其余单位不参与，
 *   避免把「1 汤匙奶酪」当成「1 克奶酪」制造假误差（第一版踩过这个坑）。
 * @returns {{ grams: number|null, unit: string }}
 */
export function parseMeasure(measure) {
  const raw = String(measure || '').trim();
  if (!raw) return { grams: null, unit: 'none' };
  const m = raw.toLowerCase().replace(/,/g, '');
  const num = parseFloat(m);
  if (!Number.isFinite(num)) return { grams: null, unit: 'none' };

  if (/kg|kilo/.test(m)) return { grams: Math.round(num * 1000), unit: 'kg' };
  if (/\d\s*g\b|\d+g$|gram/.test(m)) return { grams: Math.round(num), unit: 'g' };
  if (/oz|ounce/.test(m)) return { grams: Math.round(num * 28.35), unit: 'oz' };
  if (/lb|pound/.test(m)) return { grams: Math.round(num * 453.6), unit: 'lb' };
  if (/ml|millilit/.test(m)) return { grams: Math.round(num), unit: 'ml' };
  if (/tbsp|tablespoon/.test(m)) return { grams: Math.round(num * 15), unit: 'tbsp' };
  if (/tsp|teaspoon/.test(m)) return { grams: Math.round(num * 5), unit: 'tsp' };
  if (/cup/.test(m)) return { grams: Math.round(num * 200), unit: 'cup' };
  if (/clove/.test(m)) return { grams: null, unit: 'clove' };
  if (/slice/.test(m)) return { grams: null, unit: 'slice' };
  return { grams: null, unit: 'other' };
}

/** 兼容旧调用点 */
export function parseGrams(measure) {
  return parseMeasure(measure).grams;
}

function cleanIngredientName(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[（(].*?[)）]/g, '')
    .replace(/\b(fresh|chopped|diced|minced|grated|large|small|medium|finely|roughly|optional|to taste)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从 TheMealDB 的 strIngredient1..20 抽食材清单 */
function extractIngredients(meal) {
  const out = [];
  for (let i = 1; i <= 20; i += 1) {
    const raw = meal[`strIngredient${i}`];
    if (!raw || !String(raw).trim()) continue;
    const name = cleanIngredientName(raw);
    const measure = String(meal[`strMeasure${i}`] || '').trim();
    const parsed = parseMeasure(measure);
    const nameZh = INGREDIENT_ZH[name] || INGREDIENT_ZH[name.split(' ').slice(-1)[0]] || null;
    out.push({ name, nameZh, measure, grams: parsed.grams, unit: parsed.unit });
  }
  return out;
}

/** 菜品分类：覆盖蛋白/主食/蔬菜/甜点四类，避免全是一个类型导致指标虚高 */
const CATEGORIES = ['Chicken', 'Beef', 'Seafood', 'Rice', 'Pasta', 'Vegetarian', 'Pork', 'Dessert'];

async function fetchMeals(count) {
  const meals = [];
  const seen = new Set();
  const seenNames = new Set();
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
  for (const cat of CATEGORIES) {
    const perCat = Math.ceil(count / CATEGORIES.length) + 3;
    const r = await fetch(`https://www.themealdb.com/api/json/v1/1/filter.php?c=${cat}`);
    const j = await r.json();
    // 打散后再取，避免全被字母序靠前的菜（Asado / Acaraje…）占满样本
    const list = (j.meals || []).slice().sort(() => Math.random() - 0.5).slice(0, perCat);
    for (const item of list) {
      if (meals.length >= count) break;
      // filter 接口只给 id/名称/缩略图，需再查一次拿食材
      const d = await (await fetch(`https://www.themealdb.com/api/json/v1/1/lookup.php?i=${item.idMeal}`)).json();
      const meal = d.meals?.[0];
      if (!meal || seen.has(meal.idMeal)) continue;
      // 名字近似去重（"Fettuccine Alfredo" vs "Fettucine alfredo"）
      const key = norm(meal.strMeal);
      if (seenNames.has(key)) continue;
      seen.add(meal.idMeal);
      seenNames.add(key);
      meals.push(meal);
    }
    if (meals.length >= count) break;
  }
  return meals.slice(0, count);
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

async function main() {
  fs.mkdirSync(IMG_DIR, { recursive: true });
  fs.mkdirSync(NONFOOD_DIR, { recursive: true });

  // ---------- 1) 非食物样本（拒识率测试）：直接复用仓库里的 UI 截图 ----------
  const shots = ['01-dashboard.png', '03-plan.png', '06-coach.png'];
  const nonFood = [];
  for (const s of shots) {
    const src = path.join(ROOT, 'docs', 'screenshots', s);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(NONFOOD_DIR, s);
    fs.copyFileSync(src, dest);
    nonFood.push({ file: `nonfood/${s}`, expectNotFood: true, note: '产品界面截图，不含食物' });
  }
  // 合成一张纯色图（模型不该把它当食物）
  const solid = path.join(NONFOOD_DIR, 'solid-gray.png');
  if (!fs.existsSync(solid)) {
    // 1x1 灰色 PNG（体积最小，浏览器/模型都能解码）
    fs.writeFileSync(solid, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    ));
  }
  nonFood.push({ file: 'nonfood/solid-gray.png', expectNotFood: true, note: '纯灰图，无食物内容' });

  // ---------- 2) 菜品样本 ----------
  let meals = [];
  const reuseIds = argv.includes('--new') ? [] : (fs.existsSync(LABELS) ? (JSON.parse(fs.readFileSync(LABELS, 'utf8')).meals || []).map((x) => x.id) : []);
  if (!OFFLINE && reuseIds.length) {
    // 已有评测集 → 按原 id 重新拉取标注，保证「同一批菜品」可复现（换样本会让指标不可比）
    console.log(`沿用已有评测集的 ${reuseIds.length} 道菜（--new 可重新抽样）…`);
    for (const id of reuseIds) {
      const d = await (await fetch(`https://www.themealdb.com/api/json/v1/1/lookup.php?i=${id}`)).json();
      if (d.meals?.[0]) meals.push(d.meals[0]);
    }
    console.log(`拿到 ${meals.length} 道菜的标注`);
  } else if (!OFFLINE) {
    console.log(`正在从 TheMealDB 抓取 ${COUNT} 道菜…`);
    meals = await fetchMeals(COUNT);
    console.log(`拿到 ${meals.length} 道菜，开始下载图片…`);
  }

  if (!OFFLINE) {
    for (const m of meals) {
      const file = `meal-${m.idMeal}.jpg`;
      const dest = path.join(IMG_DIR, file);
      if (!fs.existsSync(dest)) {
        try {
          const size = await download(m.strMealThumb, dest);
          console.log(`  ✓ ${m.strMeal}  (${(size / 1024).toFixed(0)} KB)`);
        } catch (e) {
          console.log(`  ✗ ${m.strMeal} 下载失败：${e.message}`);
        }
      } else {
        console.log(`  · ${m.strMeal} 已存在，跳过下载`);
      }
    }
  } else {
    const prev = fs.existsSync(LABELS) ? JSON.parse(fs.readFileSync(LABELS, 'utf8')) : { meals: [] };
    meals = prev.meals.map((x) => ({ idMeal: x.id, ...x.raw }));
  }

  const data = {
    source: 'TheMealDB (https://www.themealdb.com/api.php)',
    generatedAt: new Date().toISOString(),
    note: '标准答案来自 TheMealDB 的人工标注字段（菜名 / 菜系 / 食材 + 用量），不是本项目模型生成',
    ingredientMapSize: Object.keys(INGREDIENT_ZH).length,
    meals: meals.map((m) => ({
      id: m.idMeal,
      file: `images/meal-${m.idMeal}.jpg`,
      meal: m.strMeal,
      category: m.strCategory,
      area: m.strArea,
      ingredients: extractIngredients(m),
      raw: { strMeal: m.strMeal, strCategory: m.strCategory, strArea: m.strArea },
    })),
    nonFood,
  };
  fs.writeFileSync(LABELS, JSON.stringify(data, null, 2), 'utf8');

  const unmapped = new Set();
  data.meals.forEach((m) => m.ingredients.forEach((i) => { if (!i.nameZh) unmapped.add(i.name); }));
  console.log(`\n✓ 评测集已生成：${data.meals.length} 道菜 + ${nonFood.length} 张非食物图`);
  console.log(`  食材条目 ${data.meals.reduce((s, m) => s + m.ingredients.length, 0)} 条，其中未映射中文 ${unmapped.size} 种：${[...unmapped].slice(0, 12).join(', ')}`);
  console.log(`  标注文件：${path.relative(ROOT, LABELS)}`);
}

await main();
