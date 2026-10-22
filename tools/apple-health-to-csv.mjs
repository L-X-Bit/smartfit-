/**
 * Apple 健康（Health）导出 → 智练可导入的 CSV
 * ===========================================================================
 * 为什么需要它：**网页无法连接 Apple Watch**。Apple Watch 不广播蓝牙标准心率服务
 * （0x180D），它只和 iPhone 私有通信；Apple 也没有给第三方网页开放 HealthKit。
 * 所以从 iPhone / Apple Watch 取数据的唯一合规路径是「Apple 健康」App 的导出数据。
 *
 * 用法（在电脑上跑，本机解析，不上传大文件）：
 *   1. iPhone 打开「健康」App → 右上头像 → 最下面「导出所有健康数据」→ 存到「文件」
 *   2. 把导出的「导出.zip」（内含 export.xml）传到电脑
 *   3. node tools/apple-health-to-csv.mjs "C:\路径\导出.zip"
 *      （也支持直接传解压后的 export.xml）
 *   4. 得到 apple-health-YYYYMMDD.csv → 在「设备同步」页的「导入数据」里粘贴或上传
 *
 * 取哪些数据（都是 Apple 健康里有、并且本项目用得到的）：
 *   · 心率 HKQuantityTypeIdentifierHeartRate
 *   · 静息心率 HKQuantityTypeIdentifierRestingHeartRate
 *   · 步数 HKQuantityTypeIdentifierStepCount
 *   · 睡眠 HKCategoryTypeIdentifierSleepAnalysis（各类 Asleep 时段求和）
 *   · 体重 HKQuantityTypeIdentifierBodyMass（自动换算 lb → kg）
 *
 * 实现要点：
 *   · **流式解析**：export.xml 动辄几百 MB，绝不 readFileSync；
 *   · zip 直接读：解析中央目录定位 export.xml，再用 zlib.createInflateRaw 流式解压；
 *   · 用正则抓 <Record .../> 自闭合标签（Apple 导出格式稳定，属性全是 key="value"）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const input = process.argv[2];
if (!input) {
  console.error('用法: node tools/apple-health-to-csv.mjs "C:\\path\\导出.zip"   （或 export.xml）');
  process.exit(1);
}
if (!fs.existsSync(input)) {
  console.error('✗ 找不到文件：' + input);
  process.exit(1);
}

/**
 * 在 zip 里定位 export.xml 并返回一个可读流
 * ---------------------------------------------------------------------------
 * 极简 zip 读取：从文件尾部找 EOCD（0x06054b50）→ 读中央目录 → 找到名字为
 * export.xml 的条目 → 跳到它的本地文件头 → 从数据区开始流式解压。
 * 只支持最常见的 deflate(8) 与 store(0) 两种压缩方式（Apple 导出就是这个）。
 */
function openZipEntry(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const tailLen = Math.min(size, 66_000);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录结尾）');

  const cdCount = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);

  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);

  let p = 0;
  let target = null;
  for (let i = 0; i < cdCount; i += 1) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method = cd.readUInt16LE(p + 10);
    const compSize = cd.readUInt32LE(p + 20);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    if (/(^|\/)export\.xml$/i.test(name)) {
      target = { method, compSize, localOffset };
      break;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!target) throw new Error('zip 里没有 export.xml（确认导出的是「健康」App 的完整导出）');

  // 跳过本地文件头，拿到真正的数据起点
  const local = Buffer.alloc(30);
  fs.readSync(fd, local, 0, 30, target.localOffset);
  const lNameLen = local.readUInt16LE(26);
  const lExtraLen = local.readUInt16LE(28);
  const dataStart = target.localOffset + 30 + lNameLen + lExtraLen;

  const raw = fs.createReadStream(file, { start: dataStart, end: dataStart + target.compSize - 1 });
  const stream = target.method === 8 ? raw.pipe(zlib.createInflateRaw()) : raw;
  return { stream, close: () => fs.closeSync(fd) };
}

/** 解析一行记录上的属性（key="value" 形式） */
function attrs(line) {
  const out = {};
  const re = /([A-Za-z]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = m[2];
  return out;
}

/** 日粒度聚合表：date -> 当天各指标 */
const days = new Map();
const get = (d) => {
  if (!days.has(d)) days.set(d, { date: d, steps: 0, hasSteps: false, restingHr: [], sleepMin: 0, weightKg: [], hrSum: 0, hrCount: 0, hrMax: null, hrMin: null });
  return days.get(d);
};
const dayOf = (s) => (s || '').slice(0, 10);

/**
 * 解析 Apple 的时间字符串
 * ---------------------------------------------------------------------------
 * 格式是 "2026-10-20 23:30:00 +0800"——注意时区前面有个空格，直接丢给 Date.parse
 * 会返回 NaN（不是合法 ISO 8601）。踩过这个坑：睡眠时长全变成 0。
 * 这里只取日期与时分秒，用 Date.UTC 统一算差值（只用来算时长，时区不影响结果）。
 */
function parseAppleDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

let scanned = 0;
let kept = 0;

const { stream, close } = input.toLowerCase().endsWith('.zip')
  ? openZipEntry(input)
  : { stream: fs.createReadStream(input), close: () => {} };

console.log('正在解析（大文件需要一两分钟）…');
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

for await (const line of rl) {
  scanned += 1;
  if (scanned % 200000 === 0) console.log(`  …已扫描 ${scanned / 10000} 万行，命中 ${kept} 条`);
  if (!line.includes('HKQuantityTypeIdentifier') && !line.includes('HKCategoryTypeIdentifier')) continue;
  if (!line.trim().startsWith('<Record')) continue;

  const a = attrs(line);
  const type = a.type || '';
  const d = dayOf(a.startDate);
  if (!d) continue;

  if (type === 'HKQuantityTypeIdentifierHeartRate') {
    const v = Number(a.value);
    if (!Number.isFinite(v) || v < 20 || v > 250) continue;
    const day = get(d);
    day.hrSum += v;
    day.hrCount += 1;
    day.hrMax = day.hrMax === null ? v : Math.max(day.hrMax, v);
    day.hrMin = day.hrMin === null ? v : Math.min(day.hrMin, v);
    kept += 1;
  } else if (type === 'HKQuantityTypeIdentifierRestingHeartRate') {
    const v = Number(a.value);
    if (Number.isFinite(v) && v >= 20 && v <= 250) {
      get(d).restingHr.push(v);
      kept += 1;
    }
  } else if (type === 'HKQuantityTypeIdentifierStepCount') {
    const v = Number(a.value);
    if (Number.isFinite(v) && v >= 0) {
      const day = get(d);
      day.steps += v;
      day.hasSteps = true;
      kept += 1;
    }
  } else if (type === 'HKQuantityTypeIdentifierBodyMass') {
    let v = Number(a.value);
    if (Number.isFinite(v) && v > 0) {
      if ((a.unit || '').toLowerCase() === 'lb') v *= 0.45359237; // iPhone 可能按磅记录
      get(d).weightKg.push(v);
      kept += 1;
    }
  } else if (type === 'HKCategoryTypeIdentifierSleepAnalysis') {
    // 只统计「真正睡着」的时段；上床/清醒不算
    if (!/Asleep/i.test(a.value || '')) continue;
    const start = parseAppleDate(a.startDate);
    const end = parseAppleDate(a.endDate);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    // 跨越零点的睡眠记在「醒来那天」，更符合直觉
    const wakeDay = dayOf(a.endDate);
    get(wakeDay).sleepMin += (end - start) / 60000;
    kept += 1;
  }
}
close();

const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
const rows = [...days.values()]
  .filter((d) => d.hasSteps || d.restingHr.length || d.sleepMin > 0 || d.weightKg.length || d.hrCount > 0)
  .sort((a, b) => (a.date < b.date ? -1 : 1))
  .map((d) => ({
    date: d.date,
    steps: d.hasSteps ? Math.round(d.steps) : '',
    restingHr: d.restingHr.length ? Math.round(avg(d.restingHr)) : '',
    sleepHours: d.sleepMin > 0 ? Number((d.sleepMin / 60).toFixed(1)) : '',
    weightKg: d.weightKg.length ? Number(avg(d.weightKg).toFixed(1)) : '',
    activeMinutes: '',
    hrAvg: d.hrCount ? Math.round(d.hrSum / d.hrCount) : '',
    hrMax: d.hrMax ?? '',
    hrMin: d.hrMin ?? '',
  }));

if (!rows.length) {
  console.error('✗ 没有解析到可用数据。确认一下：导出的是「健康」App 的完整导出，且里面有心率/步数记录。');
  process.exit(1);
}

const header = 'date,steps,restingHr,sleepHours,weightKg,activeMinutes,hrAvg,hrMax,hrMin';
const csv = [header, ...rows.map((r) => [r.date, r.steps, r.restingHr, r.sleepHours, r.weightKg, r.activeMinutes, r.hrAvg, r.hrMax, r.hrMin].join(','))].join('\n');

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const outFile = path.join(ROOT, `apple-health-${stamp}.csv`);
fs.writeFileSync(outFile, '\uFEFF' + csv, 'utf8'); // 带 BOM，Excel 打开不乱码

console.log(`\n✓ 扫描 ${scanned} 行，提取 ${kept} 条记录`);
console.log(`✓ 覆盖 ${rows.length} 天：${rows[0].date} ~ ${rows[rows.length - 1].date}`);
console.log(`✓ 已生成：${outFile}`);
console.log('\nCSV 预览（前 5 行）：');
console.log(csv.split('\n').slice(0, 6).join('\n'));
console.log('\n下一步：打开「设备同步」页 → 第 ② 张卡片「导入数据」→ 粘贴上面的内容或选择这个 CSV 文件 → 预览 → 确认导入。');
