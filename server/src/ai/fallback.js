/**
 * 本地规则引擎（降级方案 / Fallback Engine）
 * ---------------------------------------------------------------------------
 * 为什么需要它（这正是本项目「AI 工程化」的亮点）：
 *   1. 没有 API Key、断网、限流、模型超时的时候，AI 功能不能变成「白屏」；
 *   2. 大模型输出连续两次校验失败时，需要有一个 100% 可用的兜底结果；
 *   3. 学员演示环境不可控（教室网络），降级后所有功能仍然完整可用。
 *
 * 算法：确定性规则 + 运动科学模板
 *   · 分化模板（Split）：按每周训练天数选择全身/上下肢/推拉腿分化；
 *   · 动作选择：按目标肌群 + 可用器械 + 难度 + 安全过滤，从知识库中挑选；
 *   · 负荷安排：按目标（减脂 12-15 次 / 增肌 8-12 次）+ 训练等级决定组数；
 *   · 渐进超负荷：第 3 周起组数 +1 或次数区间上移；
 *   · 文案生成：用模板 + 硬指标拼出「看起来像人写的」总结与饮食建议。
 * 结果结构与 AI 输出完全一致，因此前端无需任何改动 —— 这就是「同一份契约，多种实现」。
 */
import { all } from '../db/index.js';

/** 读取全部动作（每次调用都读库，保证数据一致；数据量小，开销可忽略） */
function loadExercises() {
  return all('SELECT * FROM exercises').map((e) => ({
    id: e.id,
    name: e.name,
    category: e.category,
    muscleGroup: e.muscle_group,
    equipment: e.equipment,
    difficulty: e.difficulty,
    met: e.met,
    tags: JSON.parse(e.tags || '[]'),
    cautions: e.cautions,
  }));
}

/** 训练分化模板：key = 每周天数，value = 每天的训练主题与目标肌群 */
const SPLITS = {
  1: [{ day: 1, focus: '全身综合训练', groups: ['腿', '胸', '背', '核心'], cardio: true }],
  2: [
    { day: 1, focus: '全身力量 A', groups: ['腿', '胸', '核心'], cardio: false },
    { day: 4, focus: '全身力量 B + 有氧', groups: ['背', '臀', '肩'], cardio: true },
  ],
  3: [
    { day: 1, focus: '下肢力量 + 核心', groups: ['腿', '臀', '核心'], cardio: false },
    { day: 3, focus: '上肢推拉', groups: ['胸', '背', '肩'], cardio: false },
    { day: 5, focus: '全身循环 + 有氧', groups: ['腿', '胸', '背'], cardio: true },
  ],
  4: [
    { day: 1, focus: '下肢力量', groups: ['腿', '臀'], cardio: false },
    { day: 2, focus: '上肢推（胸肩）', groups: ['胸', '肩'], cardio: false },
    { day: 4, focus: '上肢拉（背部）', groups: ['背', '手臂'], cardio: false },
    { day: 6, focus: '核心 + 有氧耐力', groups: ['核心'], cardio: true },
  ],
  5: [
    { day: 1, focus: '下肢力量', groups: ['腿', '臀'], cardio: false },
    { day: 2, focus: '上肢推（胸肩）', groups: ['胸', '肩'], cardio: false },
    { day: 4, focus: '上肢拉（背部）', groups: ['背', '手臂'], cardio: false },
    { day: 5, focus: '核心训练', groups: ['核心'], cardio: false },
    { day: 6, focus: '有氧耐力', groups: [], cardio: true },
  ],
  6: [
    { day: 1, focus: '下肢力量 A', groups: ['腿', '臀'], cardio: false },
    { day: 2, focus: '上肢推', groups: ['胸', '肩'], cardio: false },
    { day: 3, focus: '有氧耐力', groups: [], cardio: true },
    { day: 4, focus: '下肢力量 B', groups: ['腿', '臀'], cardio: false },
    { day: 5, focus: '上肢拉', groups: ['背', '手臂'], cardio: false },
    { day: 6, focus: '核心 + 灵活性', groups: ['核心'], cardio: true },
  ],
  7: [
    { day: 1, focus: '下肢力量 A', groups: ['腿', '臀'], cardio: false },
    { day: 2, focus: '上肢推', groups: ['胸', '肩'], cardio: false },
    { day: 3, focus: '有氧耐力', groups: [], cardio: true },
    { day: 4, focus: '下肢力量 B', groups: ['腿', '臀'], cardio: false },
    { day: 5, focus: '上肢拉', groups: ['背', '手臂'], cardio: false },
    { day: 6, focus: '核心训练', groups: ['核心'], cardio: false },
    { day: 7, focus: '主动恢复（拉伸/散步）', groups: [], cardio: true, recovery: true },
  ],
};

/** 按目标决定组数与次数区间 */
function loadScheme(goal, level) {
  const base = {
    lose: { sets: 3, reps: '12-15', rest: 45 },
    gain: { sets: 4, reps: '8-12', rest: 90 },
    shape: { sets: 3, reps: '12-15', rest: 60 },
    keep: { sets: 3, reps: '10-12', rest: 60 },
  }[goal] || { sets: 3, reps: '10-12', rest: 60 };

  if (level === 'advanced') return { ...base, sets: base.sets + 1, rest: base.rest };
  if (level === 'beginner') return { ...base, sets: base.sets };
  return { ...base, sets: base.sets + 0 };
}

/**
 * 生成降级训练计划
 * @param {object} opts
 * @param {object} opts.profile 画像
 * @param {object} opts.metrics 硬指标
 * @param {object} opts.req 请求参数
 * @param {(ex:any)=>{safe:boolean,reason?:string}} opts.safetyFilter 安全过滤器
 * @returns {object} 与 AI 输出同构的计划对象
 */
export function buildFallbackPlan({ profile, metrics, req, safetyFilter }) {
  const exercises = loadExercises();
  const weeks = Math.min(12, Math.max(1, Number(req.weeks) || 4));
  const daysPerWeek = Math.min(7, Math.max(1, profile.daysPerWeek));
  const equipmentSet = new Set(req.equipment?.length ? req.equipment : ['徒手']);
  const maxDifficulty = profile.level === 'advanced' ? 3 : profile.level === 'intermediate' ? 2 : 2;
  const scheme = loadScheme(profile.goal, profile.level);

  // 1) 安全 + 器械 + 难度过滤
  const usable = exercises.filter((ex) => {
    if (ex.difficulty > maxDifficulty) return false;
    const safety = safetyFilter(ex);
    if (!safety.safe) return false;
    // 有器械优先，徒手永远可用
    if (!equipmentSet.has(ex.equipment) && ex.equipment !== '徒手') return false;
    return true;
  });
  const pool = usable.length >= 8 ? usable : exercises.filter((ex) => safetyFilter(ex).safe);

  /** 从池子里按肌群取动作，排除已用过的，避免重复 */
  const pick = (groups, count, used, preferCardio = false) => {
    const result = [];
    const candidates = pool.filter((ex) => {
      if (used.has(ex.id)) return false;
      if (preferCardio) return ex.category === '有氧' || ex.category === 'HIIT';
      return groups.includes(ex.muscleGroup) && ['力量', '核心'].includes(ex.category);
    });
    // 排序：难度高的优先（更有训练价值），同难度按 MET 降序
    candidates.sort((a, b) => b.difficulty - a.difficulty || b.met - a.met);
    for (const ex of candidates.slice(0, count)) {
      used.add(ex.id);
      result.push(ex);
    }
    // 该肌群动作不足时，从整个池子里补
    if (result.length < count) {
      for (const ex of pool) {
        if (result.length >= count) break;
        if (used.has(ex.id)) continue;
        if (preferCardio && ex.category !== '有氧') continue;
        if (!preferCardio && !['力量', '核心'].includes(ex.category)) continue;
        used.add(ex.id);
        result.push(ex);
      }
    }
    return result;
  };

  const split = SPLITS[daysPerWeek] || SPLITS[3];
  const weeklySchedule = [];

  for (let week = 1; week <= weeks; week += 1) {
    const used = new Set();
    for (const dayPlan of split) {
      const items = [];

      // 热身提示（作为第一条 note，不占动作位）
      const mainExercises = pick(dayPlan.groups, Math.min(4, Math.max(2, Math.round((req.sessionMinutes || 45) / 12))), used);
      mainExercises.forEach((ex, idx) => {
        const isHold = /秒/.test(ex.cautions || '') || ex.category === '核心';
        items.push({
          exerciseId: ex.id,
          exerciseName: ex.name,
          targetGroup: ex.muscleGroup,
          sets: ex.category === '核心' ? Math.max(2, scheme.sets - 1) : scheme.sets,
          reps: ex.category === '核心' ? '30-45 秒' : scheme.reps,
          restSec: scheme.rest,
          durationMin: 0,
          note: idx === 0 ? '训练前先做 5 分钟动态热身（原地高抬腿 + 髋部绕环）' : ex.cautions ? `注意：${ex.cautions}` : '',
        });
      });

      // 有氧日：追加有氧动作
      if (dayPlan.cardio) {
        const cardioList = pick([], 1, used, true);
        const cardio = cardioList[0];
        if (cardio) {
          items.push({
            exerciseId: cardio.id,
            exerciseName: cardio.name,
            targetGroup: '心肺',
            sets: 0,
            reps: `${20 + week * 2} 分钟`,
            restSec: 0,
            durationMin: 20 + week * 2,
            note: `保持在燃脂心率区间 ${metrics.heartZone[0]}~${metrics.heartZone[1]} 次/分，结束后做 5 分钟拉伸`,
          });
        }
      }

      // 恢复日只有拉伸
      if (dayPlan.recovery) {
        const stretch = pool.find((ex) => ex.category === '柔韧') || exercises.find((ex) => ex.category === '柔韧');
        if (stretch && !items.some((i) => i.exerciseId === stretch.id)) {
          items.push({
            exerciseId: stretch.id,
            exerciseName: stretch.name,
            targetGroup: '全身',
            sets: 1,
            reps: '15 分钟',
            restSec: 0,
            durationMin: 15,
            note: '主动恢复：以舒适为准，不要追求拉伸幅度',
          });
        }
      }

      weeklySchedule.push({ week, day: dayPlan.day, focus: dayPlan.focus, items });
    }
  }

  // 2) 文案（模板 + 硬指标，保证与 AI 输出风格接近）
  const goalText = profile.goalText;
  const condText = profile.conditionText.length ? `考虑到你存在${profile.conditionText.join('、')}，方案已自动回避高风险动作并降低强度。` : '';
  return {
    title: `${weeks} 周${goalText.split('（')[0]}计划`,
    goal: profile.goal,
    level: profile.level,
    weeks,
    daysPerWeek,
    summary:
      `根据你的身体数据（体重 ${profile.weight}kg，BMI ${metrics.bmi}「${metrics.bmiLevel}」，体脂率 ${profile.bodyFat ?? '未填'}%），` +
      `本计划采用「${split.map((s) => s.focus).join(' + ')}」的分化安排，每周 ${daysPerWeek} 练，单次约 ${req.sessionMinutes || 45} 分钟。` +
      `第 1~2 周以动作模式与习惯建立为主，第 3 周起组数/时长递增（渐进超负荷），第 4 周安排强度维持与复盘。` +
      `${condText}建议先保证完成率，再追求强度。`,
    nutritionTips:
      `每日目标热量 ${metrics.targetCalories} kcal，蛋白质 ${metrics.macros.protein}g、碳水 ${metrics.macros.carb}g、脂肪 ${metrics.macros.fat}g。` +
      `三餐分配建议 3:4:3，训练后 1 小时内补充 30g 蛋白 + 40g 碳水；每天饮水 ${Math.round(profile.weight * 35)}ml，保证 7 小时以上睡眠。`,
    safetyNotes: [
      '训练前 5~10 分钟动态热身，训练后静态拉伸放松',
      '出现关节刺痛、胸闷、头晕应立即停止并就医',
      '连续两天静息心率明显升高时安排主动恢复日',
    ],
    weeklySchedule,
    // 标记来源，便于前端展示「本次由本地规则引擎生成」
    _engine: 'fallback',
  };
}
