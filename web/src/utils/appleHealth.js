/**
 * Apple「健康」导出 → 每日聚合行（**纯浏览器实现**，不依赖后端、不依赖命令行）
 * ===========================================================================
 * 为什么要有这个文件：
 *   原来从 Apple Watch / iPhone 拿数据必须绕一圈——电脑上跑
 *   `node tools/apple-health-to-csv.mjs "导出.zip"` 生成 CSV，再到「设备同步」页点
 *   「选择文件」。而那个文件选择器只认 csv/json/txt（accept 里没有 zip），
 *   提示语却写着「选择文件」，用户选 zip 直接被过滤掉，看起来像功能坏了。
 *
 *   这里把「解压 + 解析」搬到浏览器里做，于是页面上的「选择文件」可以直接选
 *   「健康」App 导出的 zip 或解压出来的 export.xml，一步到位。
 *
 * 实现要点（讲解时可讲）：
 *   · **不整包读进内存**：`File.slice()` 拿到子 Blob，再用 `Blob.stream()` 流式读，
 *     几百 MB 的 export.xml 也不会把页面撑爆；
 *   · **自己读 zip**：从尾部找 EOCD(0x06054b50) → 读中央目录 → 定位 export.xml
 *     → 跳到本地文件头之后的数据区，只解压这一个条目（和 tools/lib/apple-health.mjs 同思路）；
 *   · **解压双通道**：优先用浏览器原生 `DecompressionStream('deflate-raw')`（流式）；
 *     iOS/iPadOS Safari 要到 16.4 才有它，所以再挂了纯 JS 的 inflate 兜底
 *     （`utils/inflateRaw.js`），老 iPad 也能导；
 *   · **逐行扫 `<Record .../>`**：Apple 导出格式稳定（属性全是 key="value"），
 *     用正则抓关键行即可，绝不拼接整棵 XML 树；
 *   · **聚合口径与命令行脚本逐字对齐**（同一天步数求和、静息心率/体重取均值、
 *     睡眠只算 Asleep 且记在醒来那天、心率统计只留 avg/max/min），
 *     这样浏览器导入和 `node tools/health-sync.mjs` 推上去的数字不会有两套说法。
 */
import { inflateRaw } from './inflateRaw.js';

/** 这些扩展名交给本文件解析；其余（csv/json/txt）继续走原来的文本通道 */
const APPLE_EXT_RE = /\.(zip|xml)$/i;

/** 中央目录/条目大小上限，纯粹是防呆：正常「健康」导出远小于这个数 */
const MAX_CD_BYTES = 8 * 1024 * 1024;

/**
 * 纯 JS 兜底解压的体积上限
 * ---------------------------------------------------------------------------
 * 老 Safari（iOS < 16.4）没有 DecompressionStream，只能整块解压：压缩数据和解压结果
 * 会同时在内存里。iPad 单个标签页内存有限，硬吃大文件会被系统直接杀掉页面，
 * 所以超过这个体积就明确劝退并给命令行方案，而不是让页面神秘白屏。
 */
const JS_INFLATE_LIMIT = 256 * 1024 * 1024;

/** 把一整块字节包成 ReadableStream（每 64KB 一块），让下游的流式扫描逻辑不用分叉 */
function bufferToStream(bytes, chunkSize = 64 * 1024) {
  let off = 0;
  return new ReadableStream({
    pull(controller) {
      if (off >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(off + chunkSize, bytes.length);
      controller.enqueue(bytes.subarray(off, end));
      off = end;
    },
  });
}

/**
 * 判断是不是「健康」导出的文件（zip / export.xml）
 * 注意：只看扩展名。`.xml` 也可能是别的文件，那种情况解析后会得到 0 条记录，
 * 上层会给「没找到步数/心率记录」的明确提示。
 */
export function isAppleHealthFile(file) {
  if (!file) return false;
  if (APPLE_EXT_RE.test(file.name || '')) return true;
  // 少数系统/浏览器选文件时 file.name 可能被改，退一步看 MIME
  return file.type === 'application/zip' || file.type === 'text/xml' || file.type === 'application/xml';
}

/** 小端读工具：从 Uint8Array 建 DataView */
const dv = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;

/**
 * 在 zip 里定位 export.xml，返回它的**解压后字节流** + 原始大小（用来算进度条）
 * 只支持 store(0) / deflate(8) 两种压缩方式——Apple 导出就是这个。
 */
async function openZipXmlStream(file, onWarn) {
  // 1) 尾部 66KB 里倒着找 EOCD（注释最长 65535 字节）
  const tailLen = Math.min(file.size, 66_000);
  if (tailLen < 22) throw new Error('文件太小，不像是「健康」App 导出的 zip');
  const tail = new Uint8Array(await file.slice(file.size - tailLen).arrayBuffer());
  const tableView = dv(tail);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tableView.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录结尾），请确认选的是「健康」App 导出的导出.zip');

  // 注意：zip 里所有多字节字段都是**小端**，漏掉第二个参数 true 就会读出天文数字
  const cdCount = tableView.getUint16(eocd + 10, true);
  const cdSize = tableView.getUint32(eocd + 12, true);
  const cdOffset = tableView.getUint32(eocd + 16, true);
  if (cdCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('这个 zip 用了 zip64 格式（通常是超过 4GB 的导出），浏览器里解不了，请用命令行：node tools/apple-health-to-csv.mjs "导出.zip"');
  }
  if (cdSize > MAX_CD_BYTES) throw new Error('zip 目录异常，无法在浏览器里解析，请用命令行：node tools/apple-health-to-csv.mjs "导出.zip"');

  // 2) 读中央目录，挑出「主数据文件」
  //    ⚠️ 踩过的坑：主文件不叫 export.xml！iPhone 是中文系统时，Apple 会把名字**本地化**成
  //    「导出.xml」（英文系统才是 export.xml），而 zip 里还有一个 export_cda.xml 是 CDA 格式的
  //    摘要，里面一条 <Record> 都没有。写死 export.xml 的话，中文用户的包一律被判"没有 export.xml"。
  const cd = new Uint8Array(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const cdView = dv(cd);
  const decoder = new TextDecoder('utf-8');

  const xmlCandidates = []; // 所有像"健康记录主文件"的条目
  let p = 0;
  for (let i = 0; i < cdCount; i += 1) {
    if (p + 46 > cd.length || cdView.getUint32(p, true) !== SIG_CD) break;
    const method = cdView.getUint16(p + 10, true);
    const compSize = cdView.getUint32(p + 20, true);
    const uncompSize = cdView.getUint32(p + 24, true);
    const nameLen = cdView.getUint16(p + 28, true);
    const extraLen = cdView.getUint16(p + 30, true);
    const commentLen = cdView.getUint16(p + 32, true);
    const localOffset = cdView.getUint32(p + 42, true);
    const name = decoder.decode(cd.subarray(p + 46, p + 46 + nameLen));

    if (/\.xml$/i.test(name) && !/export_cda\.xml$/i.test(name)) {
      xmlCandidates.push({ method, compSize, uncompSize, localOffset, name });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!xmlCandidates.length) {
    throw new Error('这个 zip 里没有健康记录 XML（只有 Workout 轨迹、心电图 CSV 之类），请确认导出的是「健康」App 的「导出所有健康数据」');
  }

  /**
   * 选择顺序：
   *   ① 名字正好是 export.xml（英文系统）
   *   ② 名字以 export / 导出 开头的 .xml（各语言本地化，如 导出.xml、exportar.xml）
   *   ③ 兜底：解压后体积最大的那个 .xml（健康记录永远是大头）
   */
  const baseName = (n) => n.split('/').pop().toLowerCase();
  const target =
    xmlCandidates.find((c) => baseName(c.name) === 'export.xml') ||
    xmlCandidates.find((c) => /^(export|导出|輸出|exporter|exportar)/i.test(baseName(c.name))) ||
    xmlCandidates.slice().sort((a, b) => b.uncompSize - a.uncompSize)[0];

  if (target.compSize === 0xffffffff || target.localOffset === 0xffffffff) {
    throw new Error('zip 用了 zip64 格式，浏览器里解不了，请用命令行：node tools/apple-health-to-csv.mjs "导出.zip"');
  }

  // 3) 跳过本地文件头（30 字节 + 文件名 + 扩展字段），拿到真正的数据起点
  const local = new Uint8Array(await file.slice(target.localOffset, target.localOffset + 30).arrayBuffer());
  const localView = dv(local);
  const lNameLen = localView.getUint16(26, true);
  const lExtraLen = localView.getUint16(28, true);
  const dataStart = target.localOffset + 30 + lNameLen + lExtraLen;
  const dataBlob = file.slice(dataStart, dataStart + target.compSize);

  if (target.method === 0) {
    return { stream: dataBlob.stream(), totalBytes: target.compSize || target.uncompSize, mode: 'store', entryName: target.name };
  }
  if (target.method !== 8) {
    throw new Error(`zip 条目用了不支持的压缩方式（method=${target.method}），请用命令行：node tools/apple-health-to-csv.mjs "导出.zip"`);
  }

  // 4) 解压：优先用浏览器原生 DecompressionStream（流式，内存最省）
  //    iOS/iPadOS Safari 要 16.4 才有它，所以再准备一条纯 JS 的兜底路径（见 utils/inflateRaw.js）
  if (typeof DecompressionStream === 'function') {
    try {
      const stream = dataBlob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return { stream, totalBytes: target.uncompSize, mode: 'native', entryName: target.name };
    } catch {
      // 少数浏览器构造函数不接受 'deflate-raw'：静默落到 JS 兜底
    }
  }

  // 兜底是"整块解压"，会同时占住压缩数据 + 解压结果两份内存，
  // 所以设个上限（iPad 上 Safari 单个标签页内存有限，硬吃易被系统杀掉）
  if (target.uncompSize > JS_INFLATE_LIMIT) {
    throw new Error(
      `这个导出解压后有 ${(target.uncompSize / 1024 / 1024).toFixed(0)}MB，当前浏览器不支持流式解压，` +
        '请换 Chrome / Edge，或改用命令行：node tools/health-sync.mjs --once "导出.zip"',
    );
  }
  if (onWarn) onWarn('当前浏览器不支持流式解压，已启用兼容模式（整块解压）');
  const compressed = new Uint8Array(await dataBlob.arrayBuffer());
  const inflated = inflateRaw(compressed, { maxOutput: JS_INFLATE_LIMIT });
  return { stream: bufferToStream(inflated), totalBytes: inflated.length, mode: 'js', entryName: target.name };
}

/** 解析 Apple 的时间字符串："2026-10-20 23:30:00 +0800"（时区前有空格，Date.parse 会 NaN） */
function parseAppleDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

const dayOf = (s) => String(s || '').slice(0, 10);

/** 抓一行记录上的属性（key="value" 形式） */
function attrsOf(line) {
  const out = {};
  const re = /([A-Za-z]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = m[2];
  return out;
}

/**
 * 解析「健康」导出（zip / export.xml），聚合成按天的行
 * 产出结构与后端 /api/devices/import 认的 CSV 列一一对应。
 *
 * @param {Blob|File} file 用户选中的文件
 * @param {{onProgress?:(p:{scanned:number,kept:number,percent:number})=>void,onWarn?:(msg:string)=>void}} [opts]
 * @returns {Promise<{rows:object[],stats:{scanned:number,kept:number,from:string,to:string,fileName:string,decompressMode:string}}>}
 */
export async function parseAppleHealthFile(file, opts = {}) {
  const { onProgress, onWarn } = opts;

  const isZip = /\.zip$/i.test(file.name || '') || file.type === 'application/zip';
  let stream;
  let totalBytes;
  let decompressMode = 'xml'; // xml | store | native | js
  let sourceEntry = file.name || ''; // zip 里真正被解析的条目名（方便排查"为什么没数据"）
  if (isZip) {
    let entryName;
    ({ stream, totalBytes, mode: decompressMode, entryName } = await openZipXmlStream(file, onWarn));
    if (entryName) sourceEntry = entryName;
  } else {
    stream = file.stream();
    totalBytes = file.size;
  }

  /** 日粒度聚合表（口径与 tools/lib/apple-health.mjs 完全一致） */
  const days = new Map();
  const get = (d) => {
    if (!days.has(d)) {
      days.set(d, { date: d, steps: 0, hasSteps: false, restingHr: [], sleepMin: 0, weightKg: [], hrSum: 0, hrCount: 0, hrMax: null, hrMin: null });
    }
    return days.get(d);
  };

  let scanned = 0;
  let kept = 0;
  let bytes = 0;
  let lastReport = 0;

  const reader = stream.getReader();
  const textDecoder = new TextDecoder('utf-8');
  let buf = '';

  /** 处理一整行（只有 <Record> 行才可能命中） */
  const handleLine = (line) => {
    scanned += 1;
    if (!line.includes('HKQuantityTypeIdentifier') && !line.includes('HKCategoryTypeIdentifier')) return;
    if (!line.trimStart().startsWith('<Record')) return;

    const a = attrsOf(line);
    const type = a.type || '';
    const d = dayOf(a.startDate);
    if (!d) return;

    if (type === 'HKQuantityTypeIdentifierHeartRate') {
      const v = Number(a.value);
      if (!Number.isFinite(v) || v < 20 || v > 250) return;
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
      if (!/Asleep/i.test(a.value || '')) return;
      const start = parseAppleDate(a.startDate);
      const end = parseAppleDate(a.endDate);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
      // 跨零点的睡眠记在「醒来那天」，更符合直觉
      get(dayOf(a.endDate)).sleepMin += (end - start) / 60000;
      kept += 1;
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (value) {
      bytes += value.byteLength;
      buf += textDecoder.decode(value, { stream: true });
      // 用一个游标切行，**每读一段只收缩一次字符串**：
      // 如果每行都 buf = buf.slice(idx+1)，几百 MB 的文件会退化成平方级拷贝（实测慢 5~10 倍）
      let start = 0;
      let idx;
      while ((idx = buf.indexOf('\n', start)) >= 0) {
        handleLine(buf.slice(start, idx));
        start = idx + 1;
      }
      buf = start ? buf.slice(start) : buf;
      // 每读一段就回报一次，让页面上的进度数字动起来（同时把主线程让出去）
      if (onProgress) {
        const now = Date.now();
        if (now - lastReport > 250) {
          lastReport = now;
          const percent = totalBytes ? Math.min(99, Math.round((bytes / totalBytes) * 100)) : 0;
          onProgress({ scanned, kept, percent });
        }
      }
    }
    if (done) break;
  }
  buf += textDecoder.decode();
  if (buf.trim()) handleLine(buf);

  const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
  const rows = [...days.values()]
    .filter((d) => d.hasSteps || d.restingHr.length || d.sleepMin > 0 || d.weightKg.length || d.hrCount > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((d) => ({
      date: d.date,
      steps: d.hasSteps ? Math.round(d.steps) : undefined,
      restingHr: d.restingHr.length ? Math.round(avg(d.restingHr)) : undefined,
      sleepHours: d.sleepMin > 0 ? Number((d.sleepMin / 60).toFixed(1)) : undefined,
      weightKg: d.weightKg.length ? Number(avg(d.weightKg).toFixed(1)) : undefined,
      activeMinutes: undefined,
      hrAvg: d.hrCount ? Math.round(d.hrSum / d.hrCount) : undefined,
      hrMax: d.hrMax ?? undefined,
      hrMin: d.hrMin ?? undefined,
    }));

  if (onProgress) onProgress({ scanned, kept, percent: 100 });

  return {
    rows,
    stats: {
      scanned,
      kept,
      from: rows.length ? rows[0].date : '',
      to: rows.length ? rows[rows.length - 1].date : '',
      fileName: file.name || '',
      /** 解压通道：native=浏览器原生流式 / js=纯 JS 兜底（老 Safari）/ store=没压缩 / xml=直接是 xml */
      decompressMode,
      /** zip 里实际被解析的条目（中文系统是 导出.xml，英文是 export.xml），排查问题全靠它 */
      sourceEntry,
    },
  };
}

/** CSV 表头：与 tools/apple-health-to-csv.mjs 生成的列完全一致，后端无需改动 */
export const APPLE_HEALTH_CSV_HEADER = 'date,steps,restingHr,sleepHours,weightKg,activeMinutes,hrAvg,hrMax,hrMin';

/** 把聚合行拼成 CSV 文本（空值写空列，不写 "undefined"） */
export function rowsToCsv(rows) {
  const cell = (v) => (v === undefined || v === null ? '' : v);
  return [
    APPLE_HEALTH_CSV_HEADER,
    ...rows.map((r) => [r.date, r.steps, r.restingHr, r.sleepHours, r.weightKg, r.activeMinutes, r.hrAvg, r.hrMax, r.hrMin].map(cell).join(',')),
  ].join('\n');
}
