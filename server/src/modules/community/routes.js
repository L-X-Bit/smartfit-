/**
 * 运动社区路由
 * ---------------------------------------------------------------------------
 * GET    /api/community/posts                  帖子列表（热门/最新/关注你）
 * POST   /api/community/posts                  发布帖子（可带图、可关联打卡）
 * POST   /api/community/posts/:id/like         点赞 / 取消点赞（切换）
 * GET    /api/community/posts/:id/comments     评论列表
 * POST   /api/community/posts/:id/comments     发表评论
 * DELETE /api/community/posts/:id              删除自己的帖子
 * GET    /api/community/leaderboard            本周打卡排行榜
 *
 * 热度算法（技术文档「核心功能实现」要点）：
 *   hot_score = 点赞×3 + 评论×5 + 时间衰减因子
 *   时间衰减：每过 1 天，基础分衰减 10%（越新越容易上榜，形成自然的"信息流"节奏）
 *   讲解时可强调：小体量社区用「时间衰减 + 互动加权」比纯时间排序更有社区感，
 *   同时避免旧贴长期霸榜。
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok, BizError } from '../../utils/response.js';
import { all, get, run, today, shiftDate } from '../../db/index.js';
import { requireAuth, optionalAuth } from '../../middleware/auth.js';

const router = Router();

/** 计算热度分（发帖 / 点赞 / 评论后都会重算） */
function calcHotScore({ likeCount, commentCount, createdAt }) {
  const hours = Math.max(0, (Date.now() - new Date(createdAt.replace(' ', 'T')).getTime()) / 3600000);
  const decay = Math.pow(0.9, hours / 24); // 每 24 小时衰减 10%
  return Number((likeCount * 3 + commentCount * 5 + 6) * (0.6 + 0.4 * decay)).toFixed(2);
}

const postDto = (p, currentUserId) => ({
  id: p.id,
  content: p.content,
  images: JSON.parse(p.images || '[]'),
  topic: p.topic,
  likeCount: p.like_count,
  commentCount: p.comment_count,
  hotScore: p.hot_score,
  createdAt: p.created_at,
  author: { id: p.user_id, nickname: p.nickname, avatar: p.avatar || '' },
  liked: Boolean(p.liked),
  workout: p.workout_log_id
    ? (() => {
        const w = get('SELECT * FROM workout_logs WHERE id = ?', [p.workout_log_id]);
        return w ? { exerciseName: w.exercise_name, durationMin: w.duration_min, calories: Math.round(w.calories) } : null;
      })()
    : null,
});

/** 帖子列表（公开） */
router.get(
  '/posts',
  optionalAuth,
  asyncHandler((req, res) => {
    const sort = req.query.sort === 'new' ? 'p.id DESC' : 'p.hot_score DESC, p.id DESC';
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = Math.min(30, Number(req.query.size) || 10);
    const uid = req.user?.id || 0;
    const topic = req.query.topic;

    const where = topic ? 'WHERE p.topic = ?' : '';
    const params = topic ? [topic] : [];

    const total = get(`SELECT COUNT(*) AS c FROM posts p ${where}`, params).c;
    const rows = all(
      `SELECT p.*, u.nickname, u.avatar,
              EXISTS(SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
       FROM posts p JOIN users u ON u.id = p.user_id
       ${where}
       ORDER BY ${sort} LIMIT ? OFFSET ?`,
      [uid, ...params, size, (page - 1) * size],
    );

    // 热门话题
    const topics = all('SELECT topic, COUNT(*) c FROM posts WHERE topic IS NOT NULL GROUP BY topic ORDER BY c DESC LIMIT 8');

    return ok(res, { list: rows.map((p) => postDto(p, uid)), total, page, size, topics });
  }),
);

/** 发布帖子 */
const postSchema = z.object({
  content: z.string().min(1, '说点什么吧').max(1000, '内容不要超过 1000 字'),
  images: z.array(z.string().max(2000)).max(9).optional(),
  topic: z.string().max(20).optional(),
  workoutLogId: z.number().int().optional().nullable(),
});

router.post(
  '/posts',
  requireAuth,
  asyncHandler((req, res) => {
    const d = postSchema.parse(req.body);
    // 关联打卡必须是自己的记录
    if (d.workoutLogId) {
      const w = get('SELECT * FROM workout_logs WHERE id = ? AND user_id = ?', [d.workoutLogId, req.user.id]);
      if (!w) throw new BizError('关联的打卡记录不存在', 400);
    }
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const id = run(
      `INSERT INTO posts (user_id, content, images, topic, workout_log_id, hot_score, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [req.user.id, d.content, JSON.stringify(d.images || []), d.topic || null, d.workoutLogId || null, calcHotScore({ likeCount: 0, commentCount: 0, createdAt: now }), now],
    ).lastInsertRowid;

    const row = get(
      'SELECT p.*, u.nickname, u.avatar, 0 AS liked FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?',
      [id],
    );
    return ok(res, postDto(row, req.user.id), '发布成功');
  }),
);

/** 点赞切换 */
router.post(
  '/posts/:id/like',
  requireAuth,
  asyncHandler((req, res) => {
    const postId = Number(req.params.id);
    const post = get('SELECT * FROM posts WHERE id = ?', [postId]);
    if (!post) throw new BizError('帖子不存在', 404);

    const existed = get('SELECT 1 AS x FROM post_likes WHERE post_id = ? AND user_id = ?', [postId, req.user.id]);
    if (existed) {
      run('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?', [postId, req.user.id]);
    } else {
      run('INSERT INTO post_likes (post_id, user_id) VALUES (?,?)', [postId, req.user.id]);
    }
    const likeCount = get('SELECT COUNT(*) AS c FROM post_likes WHERE post_id = ?', [postId]).c;
    const commentCount = post.comment_count;
    run('UPDATE posts SET like_count = ?, hot_score = ? WHERE id = ?', [
      likeCount,
      calcHotScore({ likeCount, commentCount, createdAt: post.created_at }),
      postId,
    ]);
    return ok(res, { liked: !existed, likeCount }, existed ? '已取消点赞' : '已点赞');
  }),
);

/** 评论列表 */
router.get(
  '/posts/:id/comments',
  asyncHandler((req, res) => {
    const rows = all(
      `SELECT c.*, u.nickname, u.avatar FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.post_id = ? ORDER BY c.id ASC LIMIT 100`,
      [Number(req.params.id)],
    );
    return ok(res, rows.map((c) => ({ id: c.id, content: c.content, createdAt: c.created_at, author: { id: c.user_id, nickname: c.nickname, avatar: c.avatar || '' } })));
  }),
);

/** 发表评论 */
router.post(
  '/posts/:id/comments',
  requireAuth,
  asyncHandler((req, res) => {
    const postId = Number(req.params.id);
    const post = get('SELECT * FROM posts WHERE id = ?', [postId]);
    if (!post) throw new BizError('帖子不存在', 404);
    const content = String(req.body?.content || '').trim();
    if (!content) throw new BizError('评论内容不能为空');
    if (content.length > 300) throw new BizError('评论不要超过 300 字');

    run('INSERT INTO comments (post_id, user_id, content) VALUES (?,?,?)', [postId, req.user.id, content]);
    const commentCount = get('SELECT COUNT(*) AS c FROM comments WHERE post_id = ?', [postId]).c;
    run('UPDATE posts SET comment_count = ?, hot_score = ? WHERE id = ?', [
      commentCount,
      calcHotScore({ likeCount: post.like_count, commentCount, createdAt: post.created_at }),
      postId,
    ]);
    return ok(res, { commentCount }, '评论成功');
  }),
);

/** 删除自己的帖子 */
router.delete(
  '/posts/:id',
  requireAuth,
  asyncHandler((req, res) => {
    const post = get('SELECT * FROM posts WHERE id = ? AND user_id = ?', [Number(req.params.id), req.user.id]);
    if (!post) throw new BizError('帖子不存在或无权删除', 404);
    run('DELETE FROM posts WHERE id = ?', [post.id]);
    return ok(res, null, '已删除');
  }),
);

/** 本周打卡排行榜（社区激励） */
router.get(
  '/leaderboard',
  asyncHandler((req, res) => {
    const from = shiftDate(today(), -6);
    const rows = all(
      `SELECT u.id, u.nickname, u.avatar,
              COUNT(w.id) AS times,
              ROUND(SUM(w.duration_min)) AS minutes,
              ROUND(SUM(w.calories)) AS calories
       FROM users u JOIN workout_logs w ON w.user_id = u.id AND w.log_date >= ?
       GROUP BY u.id ORDER BY minutes DESC LIMIT 10`,
      [from],
    );
    return ok(res, rows.map((r, i) => ({ rank: i + 1, ...r })));
  }),
);

export default router;
