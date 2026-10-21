/**
 * 数据库初始化 / 演示数据生成脚本
 * ---------------------------------------------------------------------------
 * 运行方式：
 *   npm run init:db            # 首次初始化（已有数据则跳过，不会重复插入）
 *   npm run reset:db           # 清空并重建（演示前重置数据用）
 *
 * 内容：
 *   1. 建表（schema.sql）
 *   2. 导入知识库：动作库 exercises.json / 食物库 foods.json / 指南库 guidelines.json
 *   3. 生成演示用户与近 60 天的身体数据、运动打卡、饮食、社区帖子
 *      —— 这样评审老师一打开页面就能看到完整的效果，而不是空数据
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initSchema, run, get, tx, today, shiftDate } from './index.js';
import { hashPassword } from '../utils/security.js';
import { calcCalories } from '../utils/health.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KB_DIR = path.resolve(HERE, '../../data/kb');

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(KB_DIR, file), 'utf8'));

// ---------------------------------------------------------------- 建表
initSchema();

const isReset = process.argv.includes('--reset');
if (isReset) {
  // 按依赖倒序清空（SQLite 中 drop 顺序需先子表后父表）
  const tables = [
    'ai_call_logs',
    'ai_messages',
    'comments',
    'post_likes',
    'posts',
    'diet_logs',
    'plan_items',
    'plans',
    'workout_logs',
    'body_records',
    'foods',
    'exercises',
    'users',
  ];
  for (const t of tables) db.exec(`DELETE FROM ${t};`);
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('users','body_records','workout_logs','plans','plan_items','diet_logs','posts','comments','ai_messages','ai_call_logs');");
  console.log('[reset] 已清空全部数据表');
}

// ---------------------------------------------------------------- 1. 知识库导入
function seedKnowledgeBase() {
  const exercises = readJson('exercises.json');
  const foods = readJson('foods.json');
  const guidelines = readJson('guidelines.json');

  // 已存在则跳过（幂等）
  const exists = get('SELECT COUNT(*) AS c FROM exercises').c > 0;
  if (exists) {
    console.log(`[1/3] 知识库已存在，跳过导入（动作 ${get('SELECT COUNT(*) c FROM exercises').c} 条 / 食物 ${get('SELECT COUNT(*) c FROM foods').c} 条）`);
    return { exercises, foods, guidelines };
  }

  tx(() => {
    for (const e of exercises) {
      // search_text：把可用于检索的字段拼在一起，供 BM25 分词打分使用
      const searchText = [e.name, e.category, e.muscleGroup, e.equipment, (e.tags || []).join(' '), e.description].join(' ');
      run(
        `INSERT INTO exercises (id, name, category, muscle_group, equipment, difficulty, met, tags, description, cautions, search_text)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [e.id, e.name, e.category, e.muscleGroup, e.equipment, e.difficulty, e.met, JSON.stringify(e.tags || []), e.description, e.cautions, searchText],
      );
    }
    for (const f of foods) {
      run(
        `INSERT INTO foods (id, name, category, kcal, protein, fat, carb, fiber, sodium, portion, search_text)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [f.id, f.name, f.category, f.kcal, f.protein, f.fat, f.carb, f.fiber, f.sodium, f.portion, `${f.name} ${f.category}`],
      );
    }
  });
  console.log(`[1/3] 知识库导入完成：动作 ${exercises.length} 条、食物 ${foods.length} 条、指南 ${guidelines.length} 条`);
  return { exercises, foods, guidelines };
}

// 指南库不入库，作为 RAG 的内存语料（见 server/src/ai/rag.js），这里仅打印数量
const { exercises, foods } = seedKnowledgeBase();

// ---------------------------------------------------------------- 2. 用户
function seedUsers() {
  const existed = get('SELECT COUNT(*) AS c FROM users').c > 0;
  if (existed) {
    console.log('[2/3] 用户已存在，跳过');
    return;
  }

  const users = [
    { username: 'demo', password: '123456', nickname: '小智', gender: 'male', birth: '2001-05-18', height: 178, goal: 'lose', weekly: 4, avatar: '' },
    { username: 'lily', password: '123456', nickname: '元气莉莉', gender: 'female', birth: '1999-09-02', height: 165, goal: 'shape', weekly: 3, avatar: '' },
    { username: 'coach', password: '123456', nickname: '教练阿凯', gender: 'male', birth: '1993-03-11', height: 182, goal: 'gain', weekly: 5, avatar: '' },
    { username: 'runner', password: '123456', nickname: '晨跑的风', gender: 'female', birth: '1997-12-25', height: 168, goal: 'keep', weekly: 4, avatar: '' },
  ];

  tx(() => {
    for (const u of users) {
      run(
        `INSERT INTO users (username, password_hash, nickname, gender, birth_date, height_cm, goal, weekly_target)
         VALUES (?,?,?,?,?,?,?,?)`,
        [u.username, hashPassword(u.password), u.nickname, u.gender, u.birth, u.height, u.goal, u.weekly],
      );
    }
  });
  console.log('[2/3] 演示用户创建完成：demo / lily / coach / runner，密码均为 123456');
}

seedUsers();

const demo = get("SELECT * FROM users WHERE username = 'demo'");
const demoId = demo.id;
const otherIds = ['lily', 'coach', 'runner'].map((n) => get('SELECT id FROM users WHERE username = ?', [n]).id);

// ---------------------------------------------------------------- 3. 演示业务数据
function seedDemoData() {
  if (get('SELECT COUNT(*) AS c FROM body_records').c > 0) {
    console.log('[3/3] 业务数据已存在，跳过');
    return;
  }

  const t = today();
  /**
   * 生成 60 天身体数据：每 3 天一条，体重从 78.6kg 缓慢下降到 75.2kg
   * （模拟真实减脂趋势，含小幅波动，便于折线图与趋势拟合展示）
   */
  tx(() => {
    const startWeight = 78.6;
    for (let i = 60; i >= 0; i -= 3) {
      const date = shiftDate(t, -i);
      const progress = (60 - i) / 60; // 0 → 1
      const weight = Number((startWeight - 3.4 * progress + (Math.random() - 0.5) * 0.5).toFixed(1));
      const bodyFat = Number((22.5 - 3.2 * progress + (Math.random() - 0.5) * 0.4).toFixed(1));
      const muscle = Number((33.8 + 0.9 * progress + (Math.random() - 0.5) * 0.3).toFixed(1));
      run(
        `INSERT INTO body_records (user_id, record_date, weight_kg, body_fat, muscle_kg, waist_cm, chest_cm, hip_cm, arm_cm, resting_hr, sleep_hours, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          demoId,
          date,
          weight,
          bodyFat,
          muscle,
          Number((86 - 3 * progress).toFixed(1)),
          Number((102 + 0.6 * progress).toFixed(1)),
          Number((97 - 2 * progress).toFixed(1)),
          Number((33 + 0.5 * progress).toFixed(1)),
          Math.round(68 - 3 * progress),
          Number((6.8 + 0.8 * progress).toFixed(1)),
          i === 0 ? '晨起空腹测量' : '',
        ],
      );
    }

    /**
     * 生成近 30 天运动打卡：按「周一三五力量 + 周二四有氧 + 周六 HIIT」的节奏，
     * 周日休息。卡路里统一用 MET 公式计算，保证与线上打卡逻辑一致。
     */
    const plan = [
      { dow: [1, 3, 5], ex: ['ex_squat_bw', 'ex_pushup', 'ex_plank', 'ex_row_db'], dur: 15 },
      { dow: [2, 4], ex: ['ex_jogging'], dur: 30 },
      { dow: [6], ex: ['ex_hiit_circuit', 'ex_jump_rope'], dur: 12 },
    ];
    for (let i = 30; i >= 0; i -= 1) {
      const date = shiftDate(t, -i);
      const dow = new Date(`${date}T00:00:00`).getDay();
      const group = plan.find((p) => p.dow.includes(dow));
      if (!group) continue;
      if (Math.random() < 0.18) continue; // 随机漏掉几天，更贴近真实数据

      const weightNow = get('SELECT weight_kg FROM body_records WHERE user_id=? AND record_date<=? ORDER BY record_date DESC LIMIT 1', [demoId, date])?.weight_kg || 76;
      for (const exId of group.ex) {
        const ex = exercises.find((e) => e.id === exId);
        if (!ex) continue;
        const minutes = group.dur;
        run(
          `INSERT INTO workout_logs (user_id, log_date, exercise_id, exercise_name, category, duration_min, intensity, sets, reps, distance_km, calories, feeling, note)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            demoId,
            date,
            ex.id,
            ex.name,
            ex.category,
            minutes,
            ex.category === 'HIIT' ? 'high' : 'medium',
            ex.category === '力量' || ex.category === '核心' ? 3 : 0,
            ex.category === '力量' || ex.category === '核心' ? 12 : 0,
            ex.category === '有氧' ? (minutes / 60) * 8 : null,
            calcCalories(ex.met, weightNow, minutes, ex.category === 'HIIT' ? 'high' : 'medium'),
            ['轻松', '适中', '适中', '力竭'][Math.floor(Math.random() * 4)],
            '',
          ],
        );
      }
    }

    /**
     * 生成一份 4 周 AI 计划（结构与 AI 生成的一致，便于直接演示）
     */
    const planId = run(
      `INSERT INTO plans (user_id, title, goal, level, weeks, days_per_week, summary, nutrition_tips, ai_meta, source, start_date)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        demoId,
        '4 周减脂增肌入门计划',
        'lose',
        'beginner',
        4,
        4,
        '结合你的身体数据（BMI 24.4 / 体脂 20.9%），本计划采用「力量 + 有氧」双线并进：每周 3 次全身力量训练提升基础代谢，2 次中等强度有氧扩大热量缺口，周末安排 1 次低强度主动恢复。强度按周递进，第 3 周引入间歇训练。',
        '每日热量目标约 2100 kcal，蛋白质 168g（约 2.2g/kg），碳水 226g，脂肪 58g。早餐增加优质蛋白，训练后 1 小时内补充 30g 蛋白 + 40g 碳水。',
        JSON.stringify({ provider: 'seed', model: 'preset', latencyMs: 0, ragHits: 4, fallback: false }),
        'ai',
        t,
      ],
    ).lastInsertRowid;

    const weekTemplate = [
      // 周一：下肢 + 核心
      [1, [['ex_squat_bw', 3, '12-15', '腿', 60], ['ex_lunge', 3, '10/侧', '腿', 60], ['ex_hip_thrust', 3, '15', '臀', 45], ['ex_plank', 3, '40 秒', '核心', 45]]],
      // 周三：上肢
      [3, [['ex_pushup', 3, '8-12', '胸', 60], ['ex_row_db', 3, '10-12', '背', 60], ['ex_shoulder_press', 3, '12', '肩', 60], ['ex_crunch', 3, '15', '核心', 45]]],
      // 周五：全身 + 有氧
      [5, [['ex_goblet_squat', 3, '12', '腿', 60], ['ex_band_row', 3, '15', '背', 45], ['ex_knee_pushup', 3, '12', '胸', 45], ['ex_jogging', 0, '20 分钟', '心肺', 0]]],
      // 周六：HIIT
      [6, [['ex_jumping_jack', 3, '40 秒', '全身', 30], ['ex_mountain_climber', 3, '30 秒', '核心', 30], ['ex_burpee', 3, '10', '全身', 60]]],
    ];
    for (let week = 1; week <= 4; week += 1) {
      for (const [day, items] of weekTemplate) {
        items.forEach(([exId, sets, reps, group, rest], idx) => {
          const ex = exercises.find((e) => e.id === exId);
          run(
            `INSERT INTO plan_items (plan_id, week_no, day_no, order_no, exercise_id, exercise_name, target_group, sets, reps, rest_sec, duration_min, note, done)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              planId,
              week,
              day,
              idx + 1,
              exId,
              ex?.name || exId,
              group,
              sets,
              reps,
              rest,
              ex?.category === '有氧' || ex?.category === 'HIIT' ? 20 : 0,
              week === 1 ? '注意动作质量，宁慢勿快' : week >= 3 ? '重量或次数较上周提升 5%' : '',
              week === 1 ? 1 : 0, // 第一周标记为已完成，演示进度条
            ],
          );
        });
      }
    }

    /**
     * 今日饮食记录
     */
    /**
     * 近 14 天饮食记录（生成「今天」与历史，让热量收支趋势图与饮食分析有数据可看）
     * 做法：用几套固定餐单轮换，份量做小幅随机扰动，模拟真实的三餐波动。
     */
    const dietTemplates = [
      [
        ['breakfast', 'fd_oats', 50],
        ['breakfast', 'fd_egg', 100],
        ['breakfast', 'fd_milk', 250],
        ['lunch', 'fd_rice', 150],
        ['lunch', 'fd_chicken_breast', 150],
        ['lunch', 'fd_broccoli', 150],
        ['dinner', 'fd_sweet_potato', 200],
        ['dinner', 'fd_basa', 150],
        ['dinner', 'fd_spinach', 150],
        ['snack', 'fd_greek_yogurt', 150],
        ['snack', 'fd_banana', 120],
      ],
      [
        ['breakfast', 'fd_whole_bread', 70],
        ['breakfast', 'fd_egg_white', 100],
        ['breakfast', 'fd_skim_milk', 250],
        ['lunch', 'fd_brown_rice', 150],
        ['lunch', 'fd_beef_lean', 120],
        ['lunch', 'fd_asparagus', 150],
        ['dinner', 'fd_quinoa', 150],
        ['dinner', 'fd_shrimp', 150],
        ['dinner', 'fd_cucumber', 200],
        ['snack', 'fd_almond', 15],
      ],
      [
        ['breakfast', 'fd_congee', 300],
        ['breakfast', 'fd_egg', 100],
        ['lunch', 'fd_pasta', 200],
        ['lunch', 'fd_chicken_thigh', 120],
        ['lunch', 'fd_pepper', 100],
        ['dinner', 'fd_corn', 200],
        ['dinner', 'fd_tofu', 150],
        ['dinner', 'fd_okra', 150],
        ['snack', 'fd_apple', 200],
      ],
    ];
    for (let i = 13; i >= 0; i -= 1) {
      const date = shiftDate(t, -i);
      const template = dietTemplates[i % dietTemplates.length];
      for (const [meal, foodId, baseAmount] of template) {
        const f = foods.find((x) => x.id === foodId);
        if (!f) continue;
        // 份量 ±10% 随机扰动，并取 5g 的整数倍，看起来更自然
        const amount = Math.max(10, Math.round((baseAmount * (0.9 + Math.random() * 0.2)) / 5) * 5);
        const k = amount / 100;
        run(
          `INSERT INTO diet_logs (user_id, log_date, meal_type, food_id, food_name, amount_g, kcal, protein, fat, carb)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [demoId, date, meal, f.id, f.name, amount, Math.round(f.kcal * k), Number((f.protein * k).toFixed(1)), Number((f.fat * k).toFixed(1)), Number((f.carb * k).toFixed(1))],
        );
      }
    }

    /**
     * 社区帖子 + 点赞 + 评论
     */
    const posts = [
      { uid: demoId, content: '减脂第 30 天，体重从 78.6kg 到 75.2kg，今天完成 3 组深蹲 + 20 分钟慢跑。AI 教练给我排的计划强度刚刚好，不会练废也不会没感觉 💪', topic: '减脂日记', images: [] },
      { uid: otherIds[0], content: '姐妹们！跟着 AI 教练生成的「塑形 8 周计划」练了两周，臀腿线条明显紧致了。关键是每天跟着计划打勾特别有成就感～', topic: '塑形打卡', images: [] },
      { uid: otherIds[1], content: '【教练说】很多人深蹲时膝盖内扣，本质是臀中肌激活不足。建议在大重量深蹲前先做 2 组弹力带侧向行走，效果立竿见影。', topic: '健身干货', images: [] },
      { uid: otherIds[2], content: '晨跑 5km 打卡，配速 5\'42"，心率保持在 Z2 区间。平台期一个月了，昨天把步数提到 10000 步，今天体重终于掉了 0.4kg！', topic: '跑步日常', images: [] },
      { uid: demoId, content: '今天的饮食记录：燕麦 + 鸡蛋 + 牛奶做早餐，午餐鸡胸西兰花米饭，晚餐巴沙鱼配红薯。蛋白质吃到了 165g，热量 2080 kcal，非常接近目标值。', topic: '健康饮食', images: [] },
    ];
    for (const p of posts) {
      const pid = run(
        `INSERT INTO posts (user_id, content, images, topic, like_count, comment_count, hot_score)
         VALUES (?,?,?,?,?,?,?)`,
        [p.uid, p.content, JSON.stringify(p.images), p.topic, 0, 0, 0],
      ).lastInsertRowid;

      // 随机 2~3 个用户点赞
      const likers = [...otherIds, demoId].filter((u) => u !== p.uid).slice(0, 2);
      for (const u of likers) {
        run('INSERT OR IGNORE INTO post_likes (post_id, user_id) VALUES (?,?)', [pid, u]);
      }
      const comments = ['太强了！向你学习', '这个计划看着很科学，我也试试', '坚持就是胜利，加油！'];
      const cCount = 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < cCount; i += 1) {
        run('INSERT INTO comments (post_id, user_id, content) VALUES (?,?,?)', [pid, otherIds[i % otherIds.length], comments[i]]);
      }
      run('UPDATE posts SET like_count = ?, comment_count = ? WHERE id = ?', [likers.length, cCount, pid]);
    }
  });

  // 重算热度分（公式见 modules/community/service.js 说明）
  const allPosts = db.prepare('SELECT id, like_count, comment_count, created_at FROM posts').all();
  for (const p of allPosts) {
    const score = p.like_count * 3 + p.comment_count * 5 + 6;
    run('UPDATE posts SET hot_score = ? WHERE id = ?', [score, p.id]);
  }

  console.log('[3/3] 演示数据生成完成：身体数据 / 打卡记录 / 训练计划 / 饮食记录 / 社区帖子');
}

seedDemoData();

console.log('\n✅ 数据库初始化完成！');
console.log(`   数据库文件：${process.env.DB_FILE || 'server/data/smartfit.db'}`);
console.log('   演示账号：demo / 123456 （另有 lily、coach、runner，密码相同）\n');
