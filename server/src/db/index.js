/**
 * 数据库访问层
 * ---------------------------------------------------------------------------
 * 技术选型说明（讲解要点）：
 *   - 使用 Node.js 22.5+ 内置的 `node:sqlite`，零外部依赖、零安装、单文件数据库，
 *     评审克隆代码后 `npm install && npm run init:db` 即可跑通，无需另装 MySQL；
 *   - 同时封装了 get/all/run/tx 四个方法，业务代码不出现任何 SQL 拼接细节以外的
 *     数据库 API，将来若迁移到 MySQL/PostgreSQL，只需替换本文件实现（仓储层隔离）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 确保数据库文件所在目录存在 */
fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

/** 全局唯一的数据库连接（SQLite 单文件，进程内共享即可） */
export const db = new DatabaseSync(config.dbFile);

// 打开外键约束（SQLite 默认关闭）与 WAL 日志模式（提升并发读性能）
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

/**
 * 执行建表脚本（幂等：全部使用 CREATE TABLE IF NOT EXISTS）
 * 另外处理「给已存在的表补充后续版本新增的列」——
 * SQLite 的 ALTER TABLE 不支持 IF NOT EXISTS，重复执行会报 duplicate column，
 * 因此用 try/catch 逐个尝试；老库升级到新结构时不需要手动迁移。
 */
export function initSchema() {
  const sql = fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8');
  db.exec(sql);

  const addedColumns = [
    // 拍照识热量：记录整图的尺度参照物与份量可信度（历史回看时也要能显示）
    'ALTER TABLE food_scans ADD COLUMN ref_object TEXT',
    'ALTER TABLE food_scans ADD COLUMN scale_confidence TEXT',
  ];
  for (const alter of addedColumns) {
    try {
      db.exec(alter);
    } catch {
      /* 列已存在，忽略 */
    }
  }
}

/**
 * 查询单行
 * @param {string} sql 带 ? 占位符的 SQL
 * @param {any[]} params
 */
export function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}

/**
 * 查询多行
 */
export function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

/**
 * 执行写操作，返回 { changes, lastInsertRowid }
 */
export function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

/**
 * 事务包装：任一步骤抛错则整体回滚
 * @param {() => any} fn 事务内逻辑
 */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * 时区化的日期工具
 * ---------------------------------------------------------------------------
 * 踩过的坑（线上验收报告里的一条）：容器 / Render 的进程时区是 UTC，
 * `new Date().getHours()` 拿到的是 UTC 小时，于是中国时间 00:00~08:00 之间
 * 「今天」会被算成昨天——首页「今日」栏显示的日期比手机上的日期少一天。
 * 解决方式：所有「今天/现在」都按 config.timezone（默认 Asia/Shanghai）来计算，
 * 与服务器所在时区无关，部署到任何云平台结果都一致。
 */
const TZ = config.timezone || 'Asia/Shanghai';
const tzFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** 当前时区下的 { date:'YYYY-MM-DD', time:'HH:mm:ss' } */
export function tzNow() {
  const parts = {};
  for (const p of tzFormatter.formatToParts(new Date())) parts[p.type] = p.value;
  // en-CA 在个别 Node 版本上会把 24 点给成 '24'，统一收敛成 '00'
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}:${parts.second}` };
}

/** 当前时区时间字符串，统一时间格式 'YYYY-MM-DD HH:mm:ss' */
export function nowStr() {
  const n = tzNow();
  return `${n.date} ${n.time}`;
}

/** 今天日期字符串 'YYYY-MM-DD'（按 config.timezone） */
export function today() {
  return tzNow().date;
}

/** 两个 'YYYY-MM-DD' 之间相差的天数（to - from） */
export function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/** 在指定日期上加减天数，返回 'YYYY-MM-DD'（纯日历运算，与时区无关） */
export function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
