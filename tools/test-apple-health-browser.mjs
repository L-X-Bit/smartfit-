/**
 * 验收：浏览器端「健康」导出解析（web/src/utils/appleHealth.js）
 * ===========================================================================
 * 背景：页面上的「选择文件」以前只认 csv/json/txt，用户按提示去选「健康」导出的
 *       zip 会被 accept 直接过滤掉，看着像功能坏了。现在 zip / export.xml 在浏览器里
 *       自己解压 + 解析，这个脚本就是用来证明「浏览器那份解析」没有走样：
 *
 *   1. 造一份仿真的 export.xml（含步数多段求和、静息心率取均值、心率 avg/max/min、
 *      磅→公斤、跨零点睡眠，以及必须被忽略的 InBed / 越界值 / Workout 行）；
 *   2. 打成三种形态喂进去：① 裸 export.xml ② deflate 压缩的 zip（带子目录与干扰条目）
 *      ③ store（不压缩）的 zip；
 *   3. 同时用命令行解析库 tools/lib/apple-health.mjs 解析同一份文件，
 *      **逐行逐字段比对**——两套口径必须一模一样，否则页面导入和脚本推送会给出两套数字。
 *
 * 运行：node tools/test-apple-health-browser.mjs
 * （零依赖、不写数据库、不联网，随时可跑）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';

import { parseAppleHealthFile, rowsToCsv, isAppleHealthFile } from '../web/src/utils/appleHealth.js';
import { parseAppleHealth } from './lib/apple-health.mjs';

// ---------------------------------------------------------------- 1. 造数据
/** 一天两段步数、两次静息心率、三次有效心率 + 一次越界心率、一条磅制体重、一段跨零点睡眠 + 一堆该被忽略的行 */
const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!ELEMENT HealthData (ExportDate,Me,(Record|Correlation|Workout|ActivitySummary|ClinicalRecord)*)>
]>
<HealthData locale="zh_CN">
 <ExportDate value="2026-10-26 10:00:00 +0800"/>
 <Me HKCharacteristicTypeIdentifierDateOfBirth="1990-05-01" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" creationDate="2026-10-20 10:10:00 +0800" startDate="2026-10-20 08:00:00 +0800" endDate="2026-10-20 09:00:00 +0800" value="1200"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" creationDate="2026-10-20 20:10:00 +0800" startDate="2026-10-20 19:00:00 +0800" endDate="2026-10-20 20:00:00 +0800" value="800"/>
 <Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Watch" unit="count/min" creationDate="2026-10-20 07:00:00 +0800" startDate="2026-10-20 07:00:00 +0800" endDate="2026-10-20 07:00:00 +0800" value="62"/>
 <Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Watch" unit="count/min" creationDate="2026-10-20 23:00:00 +0800" startDate="2026-10-20 23:00:00 +0800" endDate="2026-10-20 23:00:00 +0800" value="66"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" creationDate="2026-10-20 12:00:00 +0800" startDate="2026-10-20 12:00:00 +0800" endDate="2026-10-20 12:00:00 +0800" value="80"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" creationDate="2026-10-20 12:01:00 +0800" startDate="2026-10-20 12:01:00 +0800" endDate="2026-10-20 12:01:00 +0800" value="120"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" creationDate="2026-10-20 23:30:00 +0800" startDate="2026-10-20 23:30:00 +0800" endDate="2026-10-20 23:30:00 +0800" value="55"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" creationDate="2026-10-20 23:31:00 +0800" startDate="2026-10-20 23:31:00 +0800" endDate="2026-10-20 23:31:00 +0800" value="300"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="BodyScale" unit="lb" creationDate="2026-10-20 07:30:00 +0800" startDate="2026-10-20 07:30:00 +0800" endDate="2026-10-20 07:30:00 +0800" value="165.3"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" creationDate="2026-10-21 06:10:00 +0800" startDate="2026-10-20 22:40:00 +0800" endDate="2026-10-21 05:20:00 +0800" value="HKCategoryValueSleepAnalysisInBed"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" creationDate="2026-10-21 06:10:00 +0800" startDate="2026-10-20 23:00:00 +0800" endDate="2026-10-21 06:00:00 +0800" value="HKCategoryValueSleepAnalysisAsleepCore"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2026-10-20 18:00:00 +0800" endDate="2026-10-20 18:30:00 +0800"/>
</HealthData>
`;

// ---------------------------------------------------------------- 2. 极简 zip 打包（只为造测试文件）
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** @param {{name:string,data:Buffer,method:0|8}[]} entries */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const comp = e.method === 8 ? zlib.deflateRawSync(e.data) : e.data;
    const crc = crc32(e.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, cdBuf, eocd]);
}

// ---------------------------------------------------------------- 3. 断言工具
let pass = 0;
async function check(name, fn) {
  await fn();
  pass += 1;
  console.log(`  [ok] ${name}`);
}

/** 把聚合行按日期索引，方便逐字段比对 */
const byDate = (rows) => new Map(rows.map((r) => [r.date, r]));

/** 给 Blob 补一个 name（浏览器里 File 天然带，Node 里 Blob 没有） */
const asFile = (buf, name, type = '') => Object.assign(new Blob([buf], { type }), { name });

// ---------------------------------------------------------------- 4. 跑起来
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartfit-apple-'));
const xmlPath = path.join(tmpDir, 'export.xml');
const zipPath = path.join(tmpDir, 'export-deflate.zip');
const storeZipPath = path.join(tmpDir, 'export-store.zip');

fs.writeFileSync(xmlPath, SAMPLE_XML, 'utf8');
const xmlBuf = Buffer.from(SAMPLE_XML, 'utf8');

// 真实「健康」导出的 export.xml 在子目录里；顺带放一个干扰条目，证明只挑 export.xml
fs.writeFileSync(
  zipPath,
  buildZip([
    { name: 'apple_health_export/apple_health_export/hr.csv', data: Buffer.from('date,value\n', 'utf8'), method: 8 },
    { name: 'apple_health_export/export.xml', data: xmlBuf, method: 8 },
  ]),
);
fs.writeFileSync(storeZipPath, buildZip([{ name: 'apple_health_export/export.xml', data: xmlBuf, method: 0 }]));

console.log('\n[1/5] 扩展名识别');
await check('.zip / .xml 交给浏览器解析，.csv / .json 继续走文本通道', () => {
  assert.equal(isAppleHealthFile({ name: '导出.zip' }), true);
  assert.equal(isAppleHealthFile({ name: 'EXPORT.XML' }), true);
  assert.equal(isAppleHealthFile({ name: 'band.csv', type: 'text/csv' }), false);
  assert.equal(isAppleHealthFile({ name: 'band.json' }), false);
});

console.log('\n[2/5] 裸 export.xml：字段聚合是否正确');
const fromXml = await parseAppleHealthFile(asFile(xmlBuf, 'export.xml'));
await check(`解析出 ${fromXml.rows.length} 天（期望 2 天）`, () => assert.equal(fromXml.rows.length, 2));
await check('步数同日多段求和 = 2000', () => assert.equal(byDate(fromXml.rows).get('2026-10-20').steps, 2000));
await check('静息心率取均值 = 64', () => assert.equal(byDate(fromXml.rows).get('2026-10-20').restingHr, 64));
await check('心率 avg/max/min = 85/120/55（越界的 300 被丢弃）', () => {
  const d = byDate(fromXml.rows).get('2026-10-20');
  assert.deepEqual([d.hrAvg, d.hrMax, d.hrMin], [85, 120, 55]);
});
await check('体重 lb→kg ≈ 75.0', () => assert.equal(byDate(fromXml.rows).get('2026-10-20').weightKg, 75));
await check('睡眠 7 小时、记在醒来那天、InBed 不计', () => {
  assert.equal(byDate(fromXml.rows).get('2026-10-21').sleepHours, 7);
  assert.equal(byDate(fromXml.rows).get('2026-10-20').sleepHours, undefined);
});

console.log('\n[3/5] deflate 压缩的 zip（真实「健康」导出形态）');
const fromZip = await parseAppleHealthFile(asFile(fs.readFileSync(zipPath), '导出.zip', 'application/zip'));
await check('zip 内自动定位 apple_health_export/export.xml，结果与裸 xml 完全一致', () => {
  assert.deepEqual(fromZip.rows, fromXml.rows);
});

console.log('\n[4/5] store（不压缩）的 zip 也能读');
const fromStore = await parseAppleHealthFile(asFile(fs.readFileSync(storeZipPath), 'export-store.zip'));
await check('解压方式 method=0 同样通过', () => assert.deepEqual(fromStore.rows, fromXml.rows));

console.log('\n[5/5] 与命令行脚本口径对齐（页面导入 === 脚本推送）');
const cliXml = await parseAppleHealth(xmlPath);
const cliZip = await parseAppleHealth(zipPath);
await check('浏览器解析 === tools/lib/apple-health.mjs 解析（xml 与 zip 两条都一样）', () => {
  assert.deepEqual(fromXml.rows, cliXml.rows);
  assert.deepEqual(fromZip.rows, cliZip.rows);
});

const csv = rowsToCsv(fromZip.rows);
await check('拼出的 CSV 表头与命令行一致，且不出现 "undefined"', () => {
  const lines = csv.split('\n');
  assert.equal(lines[0], 'date,steps,restingHr,sleepHours,weightKg,activeMinutes,hrAvg,hrMax,hrMin');
  assert.equal(lines.length, 3);
  assert.ok(!csv.includes('undefined'));
  assert.equal(lines[1], '2026-10-20,2000,64,,75,,85,120,55');
  assert.equal(lines[2], '2026-10-21,,,7,,,,,'); // 这天只有睡眠，其余留空
});

console.log('\n[异常路径]');
await check('不是 zip 时给出可执行的提示（而不是干巴巴一句「解析失败」）', async () => {
  await assert.rejects(
    () => parseAppleHealthFile(asFile(Buffer.from('hello'), 'fake.zip', 'application/zip')),
    /不是有效的 zip|zip 里没有 export\.xml|文件太小/,
  );
});

console.log('\n[兼容路径] 老 Safari 没有 DecompressionStream → 纯 JS inflate 兜底');
// iOS / iPadOS Safari 要到 16.4 才有 DecompressionStream，这里把全局删掉模拟老 Safari
const nativeDS = globalThis.DecompressionStream;
await check('删掉 DecompressionStream 后，zip 仍能解析且结果一致', async () => {
  delete globalThis.DecompressionStream;
  try {
    const fallback = await parseAppleHealthFile(asFile(fs.readFileSync(zipPath), '导出.zip', 'application/zip'));
    assert.deepEqual(fallback.rows, fromXml.rows);
    assert.equal(fallback.stats.decompressMode, 'js');
  } finally {
    if (nativeDS) globalThis.DecompressionStream = nativeDS;
  }
});

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n全部通过（${pass} 项断言）\n`);
