/**
 * 轻量日期工具（不引入 dayjs，减少依赖体积）
 * ---------------------------------------------------------------------------
 * 统一使用 'YYYY-MM-DD' 字符串在前后端之间传递日期，避免时区问题。
 */

const pad = (n) => String(n).padStart(2, '0');

/** 今天 'YYYY-MM-DD' */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 日期加减天数 */
function shift(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 中文星期 */
function weekday(dateStr) {
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  return `星期${names[new Date(`${dateStr}T00:00:00`).getDay()]}`;
}

/** 相对描述：今天 / 昨天 / 3 天前 */
function relative(dateStr) {
  const diff = Math.round((new Date(`${today()}T00:00:00`) - new Date(`${dateStr}T00:00:00`)) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  if (diff > 0) return `${diff} 天前`;
  return `${-diff} 天后`;
}

/** 把时间戳格式化为 'MM-DD HH:mm' */
function formatTime(input) {
  const d = input instanceof Date ? input : new Date(String(input).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default { today, shift, weekday, relative, formatTime, pad };
