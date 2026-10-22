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
 * 💡 不想每次都转 CSV、再手动上传？用自动同步脚本，喂给它导出的 zip 就行：
 *      node tools/health-sync.mjs --once "导出.zip"
 *    解析逻辑与本文档完全共用（tools/lib/apple-health.mjs），只是省掉了人工搬运这一步。
 *
 * 取哪些数据（都是 Apple 健康里有、并且本项目用得到的）：
 *   · 心率 HKQuantityTypeIdentifierHeartRate
 *   · 静息心率 HKQuantityTypeIdentifierRestingHeartRate
 *   · 步数 HKQuantityTypeIdentifierStepCount
 *   · 睡眠 HKCategoryTypeIdentifierSleepAnalysis（各类 Asleep 时段求和）
 *   · 体重 HKQuantityTypeIdentifierBodyMass（自动换算 lb → kg）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAppleHealth } from './lib/apple-health.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const input = process.argv[2];

if (!input) {
  console.error('用法: node tools/apple-health-to-csv.mjs "C:\\path\\导出.zip"   （或 export.xml）');
  process.exit(1);
}

console.log('正在解析（大文件需要一两分钟）…');
const { rows, stats } = await parseAppleHealth(input, {
  onProgress: (scanned, kept) => console.log(`  …已扫描 ${scanned / 10000} 万行，命中 ${kept} 条`),
});

if (!rows.length) {
  console.error('✗ 没有解析到可用数据。确认一下：导出的是「健康」App 的完整导出，且里面有心率/步数记录。');
  process.exit(1);
}

// CSV 输出：undefined 一律写成空串（表格里留空，而不是难看的 "undefined"）
const cell = (v) => (v === undefined || v === null ? '' : v);
const header = 'date,steps,restingHr,sleepHours,weightKg,activeMinutes,hrAvg,hrMax,hrMin';
const csv = [
  header,
  ...rows.map((r) => [r.date, r.steps, r.restingHr, r.sleepHours, r.weightKg, r.activeMinutes, r.hrAvg, r.hrMax, r.hrMin].map(cell).join(',')),
].join('\n');

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const outFile = path.join(ROOT, `apple-health-${stamp}.csv`);
fs.writeFileSync(outFile, '\uFEFF' + csv, 'utf8'); // 带 BOM，Excel 打开不乱码

console.log(`\n✓ 扫描 ${stats.scanned} 行，提取 ${stats.kept} 条记录`);
console.log(`✓ 覆盖 ${rows.length} 天：${stats.from} ~ ${stats.to}`);
console.log(`✓ 已生成：${outFile}`);
console.log('\nCSV 预览（前 5 行）：');
console.log(csv.split('\n').slice(0, 6).join('\n'));
console.log('\n下一步二选一：');
console.log('  A. 手动：打开「设备同步」页 → 「② 导入数据」→ 选择这个 CSV → 预览 → 确认导入。');
console.log('  B. 自动：node tools/health-sync.mjs --once "' + input + '"   （直接推送，不用再碰这个 CSV）');
