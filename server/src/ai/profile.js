/**
 * 用户画像构建（Profile Builder）—— AI 流程的第 1 步
 * ---------------------------------------------------------------------------
 * 把数据库里的原始数据加工成「模型可读的画像 + 规则引擎可算的指标」：
 *   原始数据：用户静态档案 + 最新身体数据 + 历史趋势 + 打卡行为 + 睡眠
 *   → 画像文本（给大模型）
 *   → 硬指标（BMR/TDEE/目标热量/营养素/心率区间，由确定性公式算出）
 *
 * 为什么这一步很关键（技术文档「AI 技术方案」）：
 *   大模型不擅长精确算术，把算术交给代码、把编排交给模型，是混合推理的核心思想；
 *   同时画像把「用户口语描述」标准化，减少提示词长度与歧义。
 */
import { get, all } from '../db/index.js';
import { calcBMR, calcTDEE, calcTargetCalories, calcBMI, calcMacros, calcHeartZones, calcAge } from '../utils/health.js';

/** 目标/等级/性别的中文映射 */
const GOAL_TEXT = { lose: '减脂（降低体脂率）', gain: '增肌（增加肌肉量）', keep: '保持体型与健康', shape: '塑形（改善线条与体态）' };
const LEVEL_TEXT = { beginner: '新手（系统训练不足 3 个月）', intermediate: '进阶（训练 3~12 个月）', advanced: '高阶（训练 1 年以上）' };
const GENDER_TEXT = { male: '男', female: '女', unknown: '未填写' };

/** 常见伤病/慢病标识 → 需要回避的动作标签 */
export const CONDITION_RULES = {
  knee: {
    text: '膝关节不适/损伤',
    avoidTags: ['跳跃'],
    avoidNames: ['杠铃深蹲', '箭步蹲', '保加利亚分腿蹲', '跳箱', '波比跳', '跳绳', '高抬腿', '爬楼梯 / 登阶', '腿举（器械）'],
  },
  back: { text: '腰部不适/腰椎问题', avoidTags: ['腰部负荷'], avoidNames: ['罗马尼亚硬拉', '杠铃深蹲', '俄罗斯转体'] },
  shoulder: { text: '肩关节不适', avoidTags: [], avoidNames: ['引体向上', '杠铃卧推', '哑铃肩推', '椅背臂屈伸'] },
  hypertension: { text: '高血压', avoidTags: ['爆发力'], avoidNames: ['波比跳', '壶铃摇摆', '杠铃深蹲', 'HIIT 循环训练'] },
  pregnant: { text: '孕期/产后恢复期', avoidTags: ['跳跃'], avoidNames: ['卷腹', '仰卧举腿', '波比跳', '跳绳', 'HIIT 循环训练'] },
  heart: { text: '心血管疾病', avoidTags: ['高效', '爆发力'], avoidNames: ['HIIT 循环训练', '波比跳', '跳绳', '战绳', '壶铃摇摆'] },
  senior: { text: '中老年（50 岁以上）', avoidTags: ['跳跃', '爆发力'], avoidNames: ['跳箱', '波比跳', '跳绳'] },
  bigweight: { text: '大体重（BMI≥28）', avoidTags: ['跳跃'], avoidNames: ['跳绳', '波比跳', '跳箱', '慢跑'] },
};

/**
 * 构建用户画像与硬指标
 * @param {number} userId
 * @param {object} req 前端传入的本次生成参数
 * @param {object} req.goal 覆盖用户默认目标
 * @param {number} req.daysPerWeek 每周训练天数
 * @param {string[]} req.equipment 可用器械
 * @param {string} req.level 训练经验
 * @param {string[]} req.conditions 伤病/慢病标识
 * @param {number} req.weeks 计划周期
 * @param {number} req.sessionMinutes 单次时长
 */
export function buildProfile(userId, req = {}) {
  const user = get('SELECT * FROM users WHERE id = ?', [userId]);
  const latest = get('SELECT * FROM body_records WHERE user_id = ? ORDER BY record_date DESC, id DESC LIMIT 1', [userId]);
  const first = get('SELECT * FROM body_records WHERE user_id = ? ORDER BY record_date ASC, id ASC LIMIT 1', [userId]);
  const recentBody = all('SELECT * FROM body_records WHERE user_id = ? ORDER BY record_date DESC LIMIT 8', [userId]);

  const age = calcAge(user?.birth_date);
  const gender = user?.gender || 'unknown';
  const height = user?.height_cm || 170;
  const weight = latest?.weight_kg || 65;
  const goal = req.goal || user?.goal || 'keep';
  const daysPerWeek = Math.min(7, Math.max(1, Number(req.daysPerWeek) || user?.weekly_target || 3));
  const level = req.level || 'beginner';
  const conditions = Array.isArray(req.conditions) ? req.conditions.filter((c) => CONDITION_RULES[c]) : [];

  // ------------------ 硬指标（规则计算，绝不让模型算）
  const bmr = calcBMR({ weight, height, age, gender });
  const tdee = calcTDEE(bmr, daysPerWeek);
  const targetCalories = calcTargetCalories(tdee, goal);
  const macros = calcMacros(targetCalories, goal);
  const bmiInfo = calcBMI(weight, height);
  const zones = calcHeartZones(age);

  // ------------------ 趋势描述
  let recentTrendText = '';
  if (first && latest && first.record_date !== latest.record_date) {
    const diff = Number((latest.weight_kg - first.weight_kg).toFixed(1));
    const days = Math.round((new Date(latest.record_date) - new Date(first.record_date)) / 86400000);
    recentTrendText = `近 ${days} 天体重${diff > 0 ? '增加' : diff < 0 ? '减少' : '基本持平'} ${Math.abs(diff)} kg`;
    if (latest.body_fat && first.body_fat) {
      const fatDiff = Number((latest.body_fat - first.body_fat).toFixed(1));
      recentTrendText += `，体脂率${fatDiff > 0 ? '上升' : '下降'} ${Math.abs(fatDiff)} 个百分点`;
    }
  }

  // ------------------ 睡眠
  const sleepText = latest?.sleep_hours ? `平均每天 ${latest.sleep_hours} 小时` : '';

  return {
    user,
    profile: {
      age,
      gender,
      genderText: GENDER_TEXT[gender] || '未填写',
      height,
      weight,
      bodyFat: latest?.body_fat ?? null,
      waist: latest?.waist_cm ?? null,
      restingHr: latest?.resting_hr ?? null,
      goal,
      goalText: GOAL_TEXT[goal] || GOAL_TEXT.keep,
      level,
      levelText: LEVEL_TEXT[level] || LEVEL_TEXT.beginner,
      daysPerWeek,
      conditions,
      conditionText: conditions.map((c) => CONDITION_RULES[c].text),
      recentTrendText,
      sleepText,
      recentBody,
    },
    metrics: {
      bmr,
      tdee,
      targetCalories,
      macros,
      bmi: bmiInfo?.value,
      bmiLevel: bmiInfo?.level,
      heartZone: zones.z2,
      maxHeartRate: zones.max,
    },
  };
}

/**
 * 从画像中提取「必须回避的动作」判定函数
 * 这是 AI 安全审核 Agent 的核心规则，独立于大模型，保证任何情况下都不会推荐禁忌动作。
 */
export function buildSafetyFilter(conditions = []) {
  const avoidNames = new Set();
  const avoidTags = new Set();
  for (const c of conditions) {
    const rule = CONDITION_RULES[c];
    if (!rule) continue;
    (rule.avoidNames || []).forEach((n) => avoidNames.add(n));
    (rule.avoidTags || []).forEach((t) => avoidTags.add(t));
  }
  return (exercise) => {
    if (avoidNames.has(exercise.name)) return { safe: false, reason: `该动作不适合${conditions.map((c) => CONDITION_RULES[c]?.text).filter(Boolean).join('、')}人群` };
    const tags = exercise.tags || [];
    for (const t of avoidTags) {
      if (tags.includes(t) || exercise.category === t) return { safe: false, reason: `含「${t}」属性，需回避` };
    }
    return { safe: true };
  };
}
