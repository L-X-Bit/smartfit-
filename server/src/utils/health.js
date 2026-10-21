/**
 * 通用计算工具：健康领域的核心公式都集中在这里，便于复用与单测
 * ---------------------------------------------------------------------------
 * 这些都是「可解释」的确定性算法，AI 生成方案时会先用它们算出硬指标
 * （BMR、TDEE、目标热量、BMI、心率区间），再交给大模型做「个性化编排」，
 * 这样既能保证数值正确，又能保留自然语言的灵活性 —— 这也是本项目
 * 「规则 + 大模型混合推理」的技术亮点之一。
 */

/**
 * 基础代谢率 BMR（Mifflin-St Jeor 公式，比 Harris-Benedict 更贴合现代人群）
 * @param {{weight:number, height:number, age:number, gender:string}} p
 * @returns {number} kcal/天
 */
export function calcBMR({ weight, height, age, gender }) {
  if (!weight || !height || !age) return 0;
  const base = 10 * weight + 6.25 * height - 5 * age;
  // 男性 +5，女性 -161，未知取中间值 -78
  const offset = gender === 'male' ? 5 : gender === 'female' ? -161 : -78;
  return Math.round(base + offset);
}

/**
 * 每日总能量消耗 TDEE = BMR × 活动系数
 * @param {number} bmr
 * @param {number} daysPerWeek 每周运动次数，用于推断活动水平
 */
export function calcTDEE(bmr, daysPerWeek = 3) {
  let factor = 1.2; // 久坐
  if (daysPerWeek >= 6) factor = 1.725;
  else if (daysPerWeek >= 4) factor = 1.55;
  else if (daysPerWeek >= 2) factor = 1.375;
  return Math.round(bmr * factor);
}

/**
 * 根据目标给出每日目标热量
 * @param {number} tdee
 * @param {'lose'|'gain'|'keep'|'shape'} goal
 */
export function calcTargetCalories(tdee, goal) {
  if (goal === 'lose') return Math.round(tdee - 450); // 减脂：缺口 450 kcal
  if (goal === 'gain') return Math.round(tdee + 250); // 增肌：盈余 250 kcal
  if (goal === 'shape') return Math.round(tdee - 200); // 塑形：小缺口
  return Math.round(tdee); // 保持
}

/**
 * BMI 与中国人群体重分级
 */
export function calcBMI(weightKg, heightCm) {
  if (!weightKg || !heightCm) return null;
  const h = heightCm / 100;
  const bmi = weightKg / (h * h);
  let level = '正常';
  if (bmi < 18.5) level = '偏瘦';
  else if (bmi < 24) level = '正常';
  else if (bmi < 28) level = '超重';
  else level = '肥胖';
  return { value: Number(bmi.toFixed(1)), level };
}

/**
 * 按 MET 估算运动消耗热量
 * 公式：kcal = MET × 体重(kg) × 时长(小时) × 强度系数
 * @param {number} met 代谢当量
 * @param {number} weightKg
 * @param {number} minutes
 * @param {'low'|'medium'|'high'} intensity
 */
export function calcCalories(met, weightKg, minutes, intensity = 'medium') {
  const factor = intensity === 'low' ? 0.85 : intensity === 'high' ? 1.15 : 1;
  return Math.round(met * (weightKg || 60) * (minutes / 60) * factor);
}

/**
 * 三大营养素目标克数
 * @param {number} kcal 每日目标热量
 * @param {'lose'|'gain'|'keep'|'shape'} goal
 */
export function calcMacros(kcal, goal) {
  // 不同目标的供能比（蛋白/碳水/脂肪）
  const ratioMap = {
    lose: [0.32, 0.43, 0.25],
    gain: [0.27, 0.5, 0.23],
    shape: [0.3, 0.45, 0.25],
    keep: [0.23, 0.5, 0.27],
  };
  const [p, c, f] = ratioMap[goal] || ratioMap.keep;
  return {
    protein: Math.round((kcal * p) / 4), // 1g 蛋白 = 4 kcal
    carb: Math.round((kcal * c) / 4), // 1g 碳水 = 4 kcal
    fat: Math.round((kcal * f) / 9), // 1g 脂肪 = 9 kcal
  };
}

/**
 * 由年龄推算最大心率与各心率区间（Karvonen 简化版）
 */
export function calcHeartZones(age) {
  const max = 220 - (age || 25);
  return {
    max,
    z2: [Math.round(max * 0.6), Math.round(max * 0.7)], // 燃脂区
    z3: [Math.round(max * 0.7), Math.round(max * 0.8)],
    z4: [Math.round(max * 0.8), Math.round(max * 0.9)],
  };
}

/** 由出生日期计算年龄 */
export function calcAge(birthDate) {
  if (!birthDate) return 25;
  const b = new Date(birthDate);
  if (Number.isNaN(b.getTime())) return 25;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age -= 1;
  return Math.max(10, Math.min(90, age));
}
