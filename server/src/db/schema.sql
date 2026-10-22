-- ============================================================================
--  智练 SmartFit 数据库结构（SQLite / node:sqlite）
--  说明：
--   1. 所有表均带中文注释，便于评审快速理解数据建模；
--   2. 时间统一使用 TEXT 存储 ISO8601 字符串（'YYYY-MM-DD HH:mm:ss'），
--      SQLite 下可读性最好，且便于直接做字符串范围查询；
--   3. 布尔值统一用 INTEGER 0/1；
--   4. JSON 结构（如 AI 元数据、动作清单）用 TEXT 存 JSON 字符串，
--      在应用层用 JSON.parse/stringify 转换，兼顾灵活性与零外部依赖。
-- ============================================================================

-- ---------------------------- 1. 用户与鉴权 ----------------------------

-- 用户表：账号基础信息 + 静态身体档案（身高、性别、出生日期等变化频率低的数据）
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,          -- 登录账号
  password_hash TEXT    NOT NULL,                 -- bcrypt 加密后的密码（明文永不落库）
  nickname      TEXT    NOT NULL,                 -- 昵称
  avatar        TEXT,                             -- 头像地址（/uploads/xxx 或外链）
  gender        TEXT    DEFAULT 'unknown',        -- male | female | unknown
  birth_date    TEXT,                             -- 出生日期 YYYY-MM-DD（用于计算年龄）
  height_cm     REAL,                             -- 身高 cm（静态档案，不随打卡变化）
  goal          TEXT    DEFAULT 'keep',           -- 健身目标：lose(减脂) | gain(增肌) | keep(保持) | shape(塑形)
  weekly_target INTEGER DEFAULT 3,                -- 每周计划训练天数
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT
);

-- ---------------------------- 2. 身体数据 ----------------------------

-- 身体数据记录表：每次录入一条，用于趋势图与 AI 生成方案的输入特征
CREATE TABLE IF NOT EXISTS body_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record_date TEXT    NOT NULL,                   -- 记录日期 YYYY-MM-DD（同一天可多次记录）
  weight_kg   REAL    NOT NULL,                   -- 体重
  body_fat    REAL,                               -- 体脂率 %
  muscle_kg   REAL,                               -- 骨骼肌量 kg
  waist_cm    REAL,                               -- 腰围
  chest_cm    REAL,                               -- 胸围
  hip_cm      REAL,                               -- 臀围
  arm_cm      REAL,                               -- 上臂围
  resting_hr  INTEGER,                            -- 静息心率
  sleep_hours REAL,                               -- 平均睡眠时长
  note        TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_body_user_date ON body_records(user_id, record_date DESC);

-- ---------------------------- 3. 运动知识库（RAG 语料） ----------------------------

-- 动作库：既是「动作选择器」的数据源，也是 AI 训练方案 RAG 检索的知识库
CREATE TABLE IF NOT EXISTS exercises (
  id          TEXT PRIMARY KEY,                   -- 动作编码，如 ex_squat
  name        TEXT    NOT NULL,                   -- 动作名称
  category    TEXT    NOT NULL,                   -- 力量 | 有氧 | 核心 | 柔韧 | HIIT
  muscle_group TEXT   NOT NULL,                   -- 主要刺激部位：胸/背/腿/肩/手臂/核心/臀/全身/心肺
  equipment   TEXT    NOT NULL,                   -- 徒手 | 哑铃 | 杠铃 | 器械 | 弹力带 | 跑步机 | 单车
  difficulty  INTEGER NOT NULL DEFAULT 1,         -- 难度 1 入门 / 2 进阶 / 3 高阶
  met         REAL    NOT NULL DEFAULT 5,         -- 代谢当量 MET，用于卡路里估算
  tags        TEXT    NOT NULL DEFAULT '[]',      -- JSON 数组：减脂,增肌,居家,无器械,低冲击...
  description TEXT,                               -- 动作要领
  cautions    TEXT,                               -- 禁忌与注意事项（AI 安全审核会用到）
  search_text TEXT                                -- 预先拼接的检索文本（BM25 用）
);
CREATE INDEX IF NOT EXISTS idx_exercise_cat ON exercises(category, muscle_group);

-- ---------------------------- 4. 运动打卡 ----------------------------

-- 打卡记录表：一条记录 = 一次运动（可关联知识库动作，也可自定义动作名）
CREATE TABLE IF NOT EXISTS workout_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  log_date      TEXT    NOT NULL,                 -- 打卡日期 YYYY-MM-DD
  exercise_id   TEXT,                             -- 关联 exercises.id（自定义动作时为空）
  exercise_name TEXT    NOT NULL,                 -- 动作/运动名称（冗余存储，便于历史展示）
  category      TEXT    NOT NULL DEFAULT '力量',   -- 分类快照
  duration_min  REAL    NOT NULL DEFAULT 0,       -- 时长（分钟）
  intensity     TEXT    NOT NULL DEFAULT 'medium',-- low | medium | high
  sets          INTEGER DEFAULT 0,                -- 组数
  reps          INTEGER DEFAULT 0,                -- 每组次数
  distance_km   REAL,                             -- 距离（跑步/骑行）
  calories      REAL    NOT NULL DEFAULT 0,       -- 消耗热量 kcal（后端按 MET 公式计算）
  feeling       TEXT,                             -- 主观感受：轻松/适中/力竭
  note          TEXT,
  photo         TEXT,                             -- 打卡照片
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_log_user_date ON workout_logs(user_id, log_date DESC);

-- ---------------------------- 5. AI 健身计划 ----------------------------

-- 训练计划主表：一次 AI 生成 = 一个计划（含 AI 元信息，用于展示「AI 技术亮点」）
CREATE TABLE IF NOT EXISTS plans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,                 -- 计划标题，如「4 周减脂入门计划」
  goal          TEXT    NOT NULL,                 -- 目标快照
  level         TEXT    NOT NULL DEFAULT 'beginner', -- beginner | intermediate | advanced
  weeks         INTEGER NOT NULL DEFAULT 4,       -- 周期（周）
  days_per_week INTEGER NOT NULL DEFAULT 3,       -- 每周训练天数
  summary       TEXT,                             -- AI 生成的计划总述（中文自然语言）
  nutrition_tips TEXT,                            -- AI 生成的配套饮食建议
  ai_meta       TEXT    NOT NULL DEFAULT '{}',    -- JSON：provider/model/耗时/RAG命中/是否降级
  source        TEXT    NOT NULL DEFAULT 'ai',    -- ai | fallback | manual
  status        TEXT    NOT NULL DEFAULT 'active',-- active | archived
  start_date    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_plan_user ON plans(user_id, created_at DESC);

-- 计划明细表：把计划摊平成「第几周-第几天-第几个动作」
CREATE TABLE IF NOT EXISTS plan_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id       INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  week_no       INTEGER NOT NULL DEFAULT 1,
  day_no        INTEGER NOT NULL DEFAULT 1,       -- 1~7，对应周一~周日
  order_no      INTEGER NOT NULL DEFAULT 1,       -- 当天的动作顺序
  exercise_id   TEXT,                             -- 关联知识库动作
  exercise_name TEXT    NOT NULL,
  target_group  TEXT,                             -- 目标肌群
  sets          INTEGER DEFAULT 0,
  reps          TEXT,                             -- 次数可能是「8-12」这类区间，用 TEXT
  rest_sec      INTEGER DEFAULT 60,               -- 组间休息秒数
  duration_min  REAL    DEFAULT 0,                -- 有氧类用时长
  note          TEXT,
  done          INTEGER NOT NULL DEFAULT 0,       -- 是否完成
  done_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_plan_item_plan ON plan_items(plan_id, week_no, day_no, order_no);

-- ---------------------------- 6. 健康饮食 ----------------------------

-- 食物营养库：每 100g 营养数据（数据来源：中国食物成分表常见值，演示用）
CREATE TABLE IF NOT EXISTS foods (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  category  TEXT NOT NULL,                        -- 主食 | 蛋白 | 蔬菜 | 水果 | 奶类 | 坚果 | 饮品 | 零食
  kcal      REAL NOT NULL,                        -- 每 100g 热量 kcal
  protein   REAL NOT NULL DEFAULT 0,              -- 蛋白质 g
  fat       REAL NOT NULL DEFAULT 0,              -- 脂肪 g
  carb      REAL NOT NULL DEFAULT 0,              -- 碳水 g
  fiber     REAL NOT NULL DEFAULT 0,              -- 膳食纤维 g
  sodium    REAL NOT NULL DEFAULT 0,              -- 钠 mg
  portion   TEXT,                                 -- 常见份量描述，如「1 个约 50g」
  search_text TEXT
);

-- 饮食记录表：一条记录 = 某天某餐吃的一份食物
CREATE TABLE IF NOT EXISTS diet_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  log_date   TEXT    NOT NULL,
  meal_type  TEXT    NOT NULL DEFAULT 'breakfast',-- breakfast | lunch | dinner | snack
  food_id    TEXT,
  food_name  TEXT    NOT NULL,
  amount_g   REAL    NOT NULL DEFAULT 100,        -- 进食量（克）
  kcal       REAL    NOT NULL DEFAULT 0,          -- 换算后的热量
  protein    REAL    NOT NULL DEFAULT 0,
  fat        REAL    NOT NULL DEFAULT 0,
  carb       REAL    NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_diet_user_date ON diet_logs(user_id, log_date DESC);

-- ---------------------------- 7. 运动社区 ----------------------------

-- 社区帖子：可纯文字、可带图、可关联一条打卡记录（实现「打卡分享」）
CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content       TEXT    NOT NULL,
  images        TEXT    NOT NULL DEFAULT '[]',    -- JSON 数组：图片地址列表
  topic         TEXT,                             -- 话题标签，如 减脂日记
  workout_log_id INTEGER,                         -- 关联打卡（分享时自动带出数据卡片）
  like_count    INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  hot_score     REAL    NOT NULL DEFAULT 0,       -- 热度分（时间衰减 + 互动加权）
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_post_hot ON posts(hot_score DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_post_user ON posts(user_id, created_at DESC);

-- 点赞表：主键(user_id, post_id) 天然防重复点赞
CREATE TABLE IF NOT EXISTS post_likes (
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (post_id, user_id)
);

-- 评论表
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_comment_post ON comments(post_id, id);

-- ---------------------------- 8. AI 对话与可观测性 ----------------------------

-- AI 教练对话记录（支持多轮上下文）
CREATE TABLE IF NOT EXISTS ai_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT    NOT NULL,                    -- user | assistant
  content    TEXT    NOT NULL,
  rag_refs   TEXT    NOT NULL DEFAULT '[]',       -- JSON：本轮引用的知识库条目（可解释性）
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_aimsg_user ON ai_messages(user_id, id DESC);

-- AI 调用日志：技术文档「优化策略」的数据来源（耗时、缓存命中、降级、重试）
CREATE TABLE IF NOT EXISTS ai_call_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER,
  scene        TEXT    NOT NULL,                  -- plan | coach | diet
  provider     TEXT    NOT NULL,                  -- llm | fallback
  model        TEXT,
  latency_ms   INTEGER NOT NULL DEFAULT 0,
  cache_hit    INTEGER NOT NULL DEFAULT 0,
  fallback     INTEGER NOT NULL DEFAULT 0,        -- 1 表示走了降级规则引擎
  retry_count  INTEGER NOT NULL DEFAULT 0,
  rag_hits     INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'ok',     -- ok | error
  error_msg    TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_aicall_scene ON ai_call_logs(scene, created_at DESC);

-- ---------------------------- 9. AI 拍照识热量（多模态） ----------------------------

-- 识别记录表：上传一张食物照片 = 一条记录。
-- 保留原图地址与识别结果，既能做历史回溯，也支持「稍后再记入饮食」。
CREATE TABLE IF NOT EXISTS food_scans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_url     TEXT,                              -- 原图地址（/uploads/xxx.png）
  items         TEXT    NOT NULL DEFAULT '[]',      -- JSON：识别出的食物数组（含库匹配状态与最终营养值）
  total_kcal    REAL    NOT NULL DEFAULT 0,         -- 合计热量
  total_protein REAL    NOT NULL DEFAULT 0,
  total_fat     REAL    NOT NULL DEFAULT 0,
  total_carb    REAL    NOT NULL DEFAULT 0,
  advice        TEXT,                               -- 模型给出的一句饮食建议
  provider      TEXT    NOT NULL DEFAULT 'vision',  -- vision（视觉模型）| manual（手动录入）
  model         TEXT,
  matched_count INTEGER NOT NULL DEFAULT 0,         -- 成功匹配到本地食物库的条目数
  latency_ms    INTEGER NOT NULL DEFAULT 0,         -- 识别耗时（含模型调用）
  logged_meal   TEXT,                               -- 已记入的餐次，为空表示尚未写入饮食记录
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_foodscan_user ON food_scans(user_id, id DESC);

-- ---------------------------- 10. 可穿戴设备数据同步 ----------------------------

-- 设备同步记录表：每一次从手环/手表/心率带同步 = 一条记录。
-- 支持四种来源：
--   bluetooth —— 浏览器 Web Bluetooth 实时连接心率带/手环（标准 GATT 心率服务 0x180D）
--   import    —— 导入手环 App 导出的 CSV/JSON（步数、睡眠、心率、体重等）
--   auto      —— 自动同步：同步令牌 + 系统快捷指令 / 电脑端监听脚本定时推送（无需导出上传）
--   demo      —— 演示模式生成模拟数据（保证无设备时也能完整演示）
CREATE TABLE IF NOT EXISTS device_syncs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      TEXT    NOT NULL,                   -- bluetooth | import | demo
  device_name TEXT,                               -- 设备名，如 "Mi Smart Band 8" / "Polar H10"
  sync_type   TEXT    NOT NULL,                   -- heart_rate | daily | weight
  payload     TEXT    NOT NULL DEFAULT '{}',      -- JSON：同步的原始数据（心率样本/每日指标）
  summary     TEXT,                               -- 一句话摘要，便于列表展示
  record_count INTEGER NOT NULL DEFAULT 0,        -- 写入的业务记录条数
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_devsync_user ON device_syncs(user_id, id DESC);

-- ---------------------------- 11. 自动同步令牌 ----------------------------

-- 同步令牌表：「让设备/脚本自己把数据推进来」的凭证。
-- 为什么不用登录 JWT：iPhone 的「快捷指令」、电脑上的监听脚本都不是浏览器，
-- 没有登录态，也不该保存账号密码。令牌可以随时撤销、可区分来源，泄漏只影响这一条通道。
-- 安全设计：库里只存 SHA-256 摘要（token_hash），明文只在创建那一刻返回给用户一次，
--          即使数据库被拖走也拿不到可用的令牌（和个人密码的存法一个道理）。
CREATE TABLE IF NOT EXISTS sync_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT,                              -- 来源备注：iPhone 快捷指令 / iCloud 监听脚本 / HTTP Shortcuts
  token_hash   TEXT    NOT NULL UNIQUE,           -- SHA-256(令牌明文)，明文不落库
  token_hint   TEXT    NOT NULL,                  -- 明文前 8 位，界面用来区分是哪一枚
  push_count   INTEGER NOT NULL DEFAULT 0,        -- 累计推送次数
  last_used_at TEXT,                              -- 最近一次使用时间
  revoked      INTEGER NOT NULL DEFAULT 0,        -- 1 = 已撤销（保留记录便于审计）
  created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_synctoken_user ON sync_tokens(user_id, id DESC);
