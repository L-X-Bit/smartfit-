/**
 * 动作库路由（公开接口，无需登录）
 * ---------------------------------------------------------------------------
 * GET /api/exercises?kw=&category=&equipment=&muscleGroup=   动作列表/搜索
 * GET /api/exercises/meta                                    筛选项枚举
 * GET /api/exercises/:id                                     动作详情（含禁忌）
 */
import { Router } from 'express';
import { asyncHandler, ok, BizError } from '../../utils/response.js';
import { all, get } from '../../db/index.js';

const router = Router();

const toDto = (e) => ({
  id: e.id,
  name: e.name,
  category: e.category,
  muscleGroup: e.muscle_group,
  equipment: e.equipment,
  difficulty: e.difficulty,
  met: e.met,
  tags: JSON.parse(e.tags || '[]'),
  description: e.description,
  cautions: e.cautions,
});

/** 筛选项枚举（前端下拉框使用） */
router.get(
  '/meta',
  asyncHandler((req, res) => {
    const uniq = (col) => all(`SELECT DISTINCT ${col} AS v FROM exercises ORDER BY v`).map((r) => r.v);
    return ok(res, {
      categories: uniq('category'),
      equipment: uniq('equipment'),
      muscleGroups: uniq('muscle_group'),
      difficulties: [
        { value: 1, label: '入门' },
        { value: 2, label: '进阶' },
        { value: 3, label: '高阶' },
      ],
    });
  }),
);

/** 动作列表（支持关键词模糊搜索 + 多条件筛选） */
router.get(
  '/',
  asyncHandler((req, res) => {
    const { kw, category, equipment, muscleGroup } = req.query;
    const where = [];
    const params = [];
    if (kw) {
      where.push('(name LIKE ? OR search_text LIKE ?)');
      params.push(`%${kw}%`, `%${kw}%`);
    }
    if (category) {
      where.push('category = ?');
      params.push(category);
    }
    if (equipment) {
      where.push('equipment = ?');
      params.push(equipment);
    }
    if (muscleGroup) {
      where.push('muscle_group = ?');
      params.push(muscleGroup);
    }
    const sql = `SELECT * FROM exercises ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY category, difficulty, name`;
    return ok(res, all(sql, params).map(toDto));
  }),
);

/** 动作详情 */
router.get(
  '/:id',
  asyncHandler((req, res) => {
    const e = get('SELECT * FROM exercises WHERE id = ?', [req.params.id]);
    if (!e) throw new BizError('动作不存在', 404);
    return ok(res, toDto(e));
  }),
);

export default router;
