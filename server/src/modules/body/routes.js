/**
 * 身体数据路由
 * ---------------------------------------------------------------------------
 * GET    /api/body/records?limit=        身体数据列表（倒序）
 * POST   /api/body/records               录入一条身体数据
 * DELETE /api/body/records/:id           删除
 * GET    /api/body/analysis              身体分析：BMI/体脂评估/趋势/变化
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok, BizError } from '../../utils/response.js';
import { all, get, run, today } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { calcBMI, calcAge, calcBMR, calcTDEE, calcTargetCalories, calcMacros } from '../../utils/health.js';

const router = Router();
router.use(requireAuth);

const bodySchema = z.object({
  recordDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  weightKg: z.number().min(20, '体重应大于 20kg').max(300, '体重应小于 300kg'),
  bodyFat: z.number().min(1).max(70).optional().nullable(),
  muscleKg: z.number().min(1).max(120).optional().nullable(),
  waistCm: z.number().min(30).max(200).optional().nullable(),
  chestCm: z.number().min(30).max(200).optional().nullable(),
  hipCm: z.number().min(30).max(200).optional().nullable(),
  armCm: z.number().min(10).max(80).optional().nullable(),
  restingHr: z.number().int().min(30).max(150).optional().nullable(),
  sleepHours: z.number().min(0).max(24).optional().nullable(),
  note: z.string().max(200).optional(),
});

/** 列表 */
router.get(
  '/records',
  asyncHandler((req, res) => {
    const limit = Math.min(365, Number(req.query.limit) || 60);
    const rows = all(
      'SELECT * FROM body_records WHERE user_id = ? ORDER BY record_date DESC, id DESC LIMIT ?',
      [req.user.id, limit],
    );
    return ok(res, rows.map(toDto));
  }),
);

/** 录入 */
router.post(
  '/records',
  asyncHandler((req, res) => {
    const d = bodySchema.parse(req.body);
    const date = d.recordDate || today();
    const id = run(
      `INSERT INTO body_records (user_id, record_date, weight_kg, body_fat, muscle_kg, waist_cm, chest_cm, hip_cm, arm_cm, resting_hr, sleep_hours, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        req.user.id,
        date,
        d.weightKg,
        d.bodyFat ?? null,
        d.muscleKg ?? null,
        d.waistCm ?? null,
        d.chestCm ?? null,
        d.hipCm ?? null,
        d.armCm ?? null,
        d.restingHr ?? null,
        d.sleepHours ?? null,
        d.note || '',
      ],
    ).lastInsertRowid;
    const row = get('SELECT * FROM body_records WHERE id = ?', [id]);
    return ok(res, toDto(row), '身体数据已记录');
  }),
);

/** 删除 */
router.delete(
  '/records/:id',
  asyncHandler((req, res) => {
    const row = get('SELECT * FROM body_records WHERE id = ? AND user_id = ?', [Number(req.params.id), req.user.id]);
    if (!row) throw new BizError('记录不存在', 404);
    run('DELETE FROM body_records WHERE id = ?', [row.id]);
    return ok(res, null, '已删除');
  }),
);

/**
 * 身体分析：给前端雷达图 / 折线图 / 指标卡提供结构化数据
 */
router.get(
  '/analysis',
  asyncHandler((req, res) => {
    const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const records = all('SELECT * FROM body_records WHERE user_id = ? ORDER BY record_date ASC', [req.user.id]);
    const latest = records.at(-1);
    const first = records[0];

    if (!latest) {
      return ok(res, { hasData: false, message: '还没有身体数据，先录入一条吧' });
    }

    const age = calcAge(user.birth_date);
    const height = user.height_cm || 170;
    const bmi = calcBMI(latest.weight_kg, height);

    // 体脂评估标准（区分男女）
    const bodyFat = latest.body_fat;
    let bodyFatLevel = null;
    if (bodyFat) {
      if (user.gender === 'male') bodyFatLevel = bodyFat < 10 ? '偏低' : bodyFat <= 20 ? '健康' : bodyFat <= 25 ? '偏高' : '肥胖';
      else bodyFatLevel = bodyFat < 18 ? '偏低' : bodyFat <= 28 ? '健康' : bodyFat <= 32 ? '偏高' : '肥胖';
    }

    // 变化统计
    const weightChange = first && records.length > 1 ? Number((latest.weight_kg - first.weight_kg).toFixed(1)) : 0;
    const fatChange = first?.body_fat && latest.body_fat ? Number((latest.body_fat - first.body_fat).toFixed(1)) : null;
    const muscleChange = first?.muscle_kg && latest.muscle_kg ? Number((latest.muscle_kg - first.muscle_kg).toFixed(1)) : null;
    const waistChange = first?.waist_cm && latest.waist_cm ? Number((latest.waist_cm - first.waist_cm).toFixed(1)) : null;

    // 代谢指标
    const bmr = calcBMR({ weight: latest.weight_kg, height, age, gender: user.gender });
    const tdee = calcTDEE(bmr, user.weekly_target || 3);
    const targetCalories = calcTargetCalories(tdee, user.goal || 'keep');
    const macros = calcMacros(targetCalories, user.goal || 'keep');

    // 雷达图：把各项指标换算成 0~100 的达成度（越接近理想值越高）
    const radar = [
      { name: 'BMI', value: scoreBMI(bmi.value), ideal: `${bmi.value} / 理想 18.5-23.9` },
      { name: '体脂率', value: scoreBodyFat(bodyFat, user.gender), ideal: `${bodyFat ?? '-'}% / 理想 ${user.gender === 'female' ? '18-28' : '10-20'}%` },
      { name: '肌肉量', value: scoreMuscle(latest.muscle_kg, latest.weight_kg, user.gender), ideal: `${latest.muscle_kg ?? '-'}kg` },
      { name: '腰围', value: scoreWaist(latest.waist_cm, user.gender), ideal: `${latest.waist_cm ?? '-'}cm / 警戒 ${user.gender === 'female' ? 85 : 90}cm` },
      { name: '静息心率', value: scoreHeartRate(latest.resting_hr), ideal: `${latest.resting_hr ?? '-'} 次/分` },
      { name: '睡眠', value: scoreSleep(latest.sleep_hours), ideal: `${latest.sleep_hours ?? '-'} 小时` },
    ];

    return ok(res, {
      hasData: true,
      latest: toDto(latest),
      bmi,
      bodyFatLevel,
      changes: { weight: weightChange, bodyFat: fatChange, muscle: muscleChange, waist: waistChange, recordCount: records.length },
      metabolism: { bmr, tdee, targetCalories, macros },
      radar,
      trend: records.map((r) => ({
        date: r.record_date,
        weight: r.weight_kg,
        bodyFat: r.body_fat,
        muscle: r.muscle_kg,
        waist: r.waist_cm,
        restingHr: r.resting_hr,
      })),
    });
  }),
);

// ------------------------------------------------------------------ 工具函数
function toDto(r) {
  return {
    id: r.id,
    recordDate: r.record_date,
    weightKg: r.weight_kg,
    bodyFat: r.body_fat,
    muscleKg: r.muscle_kg,
    waistCm: r.waist_cm,
    chestCm: r.chest_cm,
    hipCm: r.hip_cm,
    armCm: r.arm_cm,
    restingHr: r.resting_hr,
    sleepHours: r.sleep_hours,
    note: r.note,
    createdAt: r.created_at,
  };
}

/** BMI 得分：18.5~23.9 满分，越偏离越低 */
function scoreBMI(bmi) {
  if (!bmi) return 0;
  if (bmi >= 18.5 && bmi <= 23.9) return 100;
  const diff = bmi < 18.5 ? 18.5 - bmi : bmi - 23.9;
  return Math.max(0, Math.round(100 - diff * 12));
}
function scoreBodyFat(fat, gender) {
  if (!fat) return 0;
  const [min, max] = gender === 'female' ? [18, 28] : [10, 20];
  if (fat >= min && fat <= max) return 100;
  const diff = fat < min ? min - fat : fat - max;
  return Math.max(0, Math.round(100 - diff * 8));
}
function scoreMuscle(muscle, weight, gender) {
  if (!muscle || !weight) return 0;
  const ratio = muscle / weight;
  const ideal = gender === 'female' ? 0.38 : 0.45;
  return Math.max(0, Math.min(100, Math.round(100 - Math.abs(ratio - ideal) * 500)));
}
function scoreWaist(waist, gender) {
  if (!waist) return 0;
  const limit = gender === 'female' ? 85 : 90;
  const ideal = limit - 15;
  if (waist <= ideal) return 100;
  return Math.max(0, Math.round(100 - (waist - ideal) * 5));
}
function scoreHeartRate(hr) {
  if (!hr) return 0;
  if (hr <= 60) return 100;
  if (hr <= 70) return 85;
  if (hr <= 80) return 65;
  return 45;
}
function scoreSleep(h) {
  if (!h) return 0;
  if (h >= 7 && h <= 9) return 100;
  return Math.max(30, Math.round(100 - Math.abs(h - 8) * 18));
}

export default router;
