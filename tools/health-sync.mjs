/**
 * 健康数据「自动同步」客户端
 * ===========================================================================
 * 解决什么问题（用户原话）：
 *   「能不能不要每次先下载数据、再转成 zip/CSV 上传，看看能不能自动同步？」
 *
 * 这个脚本就是那条自动化通道：把「解析 + 上传」从手工操作变成后台常驻任务。
 *
 * 两种用法
 * ---------------------------------------------------------------------------
 *  ① 一次性推送（替代"转 CSV 再上传"）：
 *       node tools/health-sync.mjs --once "导出.zip"
 *     直接把 Apple「健康」导出的 zip（或 export.xml / 手环导出的 CSV、JSON）推给平台，
 *     不再需要 apple-health-to-csv.mjs 生成中间 CSV，也不需要在网页上选文件。
 *
 *  ② 目录监听（真正无人值守）：
 *       node tools/health-sync.mjs --watch "%USERPROFILE%\iCloudDrive\智练同步"
 *     · iPhone 上用「快捷指令」把每天的健康数据写成 CSV/JSON 丢进这个目录（自动化，无需打开 App）；
 *     · 或者把「健康」App 导出的 zip 直接存进这个目录；
 *     脚本发现新文件就自动解析推送。文件处理过会记在 tools/.health-sync-state.json 里，
 *     不会重复推同一份；文件内容变了（大小/时间变了）会自动再推一次。
 *
 * 令牌从哪来
 * ---------------------------------------------------------------------------
 *   网页「设备同步」页 → 「④ 自动同步」→ 生成令牌，然后三选一：
 *     · 命令行 --token sft_xxx
 *     · 环境变量 SMARTFIT_SYNC_TOKEN
 *     · 配置文件 tools/.sync-config.json：{ "url": "...", "token": "sft_xxx" }
 *   令牌只用于推送健康数据，可随时在网页上撤销。
 *
 * 安全说明：脚本只往你的平台 POST 少量聚合后的每日指标（步数/心率/睡眠/体重），
 *          不整包上传导出文件，原始数据始终留在本机。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAppleHealth } from './lib/apple-health.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATE_FILE = path.join(ROOT, 'tools', '.health-sync-state.json');
const CONFIG_FILE = path.join(ROOT, 'tools', '.sync-config.json');

// ------------------------------------------------------------------ 参数解析
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/** 读配置文件（没有就返回空对象，不让"没配置"变成报错） */
function readConfigFile() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.warn(`⚠ 配置文件解析失败（已忽略）：${CONFIG_FILE} —— ${e.message}`);
    return {};
  }
}

const fileCfg = readConfigFile();
const cfg = {
  url: String(args.url || process.env.SMARTFIT_URL || fileCfg.url || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
  token: String(args.token || process.env.SMARTFIT_SYNC_TOKEN || fileCfg.token || ''),
  device: String(args.device || fileCfg.device || '电脑自动同步（health-sync.mjs）'),
};

const MODE = args.once ? 'once' : args.watch ? 'watch' : '';
if (!MODE) {
  printHelp();
  process.exit(1);
}
if (!cfg.token) {
  console.error('✗ 缺少同步令牌。请在网页「设备同步 → ④ 自动同步」里生成，然后：');
  console.error('   node tools/health-sync.mjs ' + (MODE === 'once' ? `--once "${args.once}"` : `--watch "${args.watch}"`) + ' --token sft_xxx');
  console.error(`   或写入配置文件 ${CONFIG_FILE}：{ "url": "${cfg.url}", "token": "sft_xxx" }`);
  process.exit(1);
}

function printHelp() {
  console.log(`
智练 SmartFit · 健康数据自动同步

用法：
  node tools/health-sync.mjs --once <文件>            推送一个文件（.zip / .xml / .csv / .json）
  node tools/health-sync.mjs --watch <目录>           监听目录，新文件自动推送
  node tools/health-sync.mjs --watch <目录> --force   目录里已有文件也全部重推一次

常用参数：
  --url <平台地址>     默认 http://127.0.0.1:3000（线上例：https://smartfit-qsyh.onrender.com）
  --token <令牌>       在网页「设备同步 → ④ 自动同步」生成（sft_ 开头）
  --device <名称>      同步历史里显示的来源名，默认「电脑自动同步」
  --dry-run            只打印将要推送的汇总，不真正上传
  --reset-state        清空"已推送文件"记录（配合 --watch 重跑全部）
`);
}

// ------------------------------------------------------------------ 打印工具
const log = (...a) => console.log(...a);
const ok = (...a) => console.log('✓', ...a);
const warn = (...a) => console.log('⚠', ...a);
const bad = (...a) => console.error('✗', ...a);

// ------------------------------------------------------------------ 文件 → 行数据
/** 极简 CSV 解析（表头别名与后端 service.js 保持一致） */
function csvToRows(text) {
  const lines = String(text)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const split = (line) => {
    const delimiter = line.includes('\t') ? '\t' : ',';
    const out = [];
    let cur = '';
    let inQuote = false;
    for (const ch of line) {
      if (ch === '"') inQuote = !inQuote;
      else if (ch === delimiter && !inQuote) {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const alias = {
    date: 'date', 日期: 'date',
    steps: 'steps', 步数: 'steps',
    restinghr: 'restingHr', 静息心率: 'restingHr', 心率: 'restingHr', hr: 'restingHr', heartrate: 'restingHr',
    sleephours: 'sleepHours', 睡眠: 'sleepHours', 睡眠时长: 'sleepHours', sleep: 'sleepHours',
    weightkg: 'weightKg', 体重: 'weightKg', weight: 'weightKg',
    activeminutes: 'activeMinutes', 活动时长: 'activeMinutes', minutes: 'activeMinutes',
    hravg: 'hrAvg', avghr: 'hrAvg', 平均心率: 'hrAvg',
    hrmax: 'hrMax', maxhr: 'hrMax', 最高心率: 'hrMax',
    hrmin: 'hrMin', minhr: 'hrMin', 最低心率: 'hrMin',
  };
  const keys = split(lines[0]).map((h) => alias[h.replace(/\s|_/g, '').toLowerCase()] || h);
  return lines.slice(1).map((line) => {
    const cells = split(line);
    const row = {};
    keys.forEach((k, i) => {
      if (cells[i] !== undefined && cells[i] !== '') row[k] = cells[i];
    });
    return row;
  });
}

/** JSON 解析：接受数组或 {records|data|rows:[...]} */
function jsonToRows(text) {
  const j = JSON.parse(text);
  if (Array.isArray(j)) return j;
  for (const k of ['records', 'data', 'rows', 'metrics']) {
    if (Array.isArray(j[k])) return j[k];
    if (j[k] && typeof j[k] === 'object') return [j[k]]; // 单日 {metrics:{...}} 也支持
  }
  if (j.metrics && typeof j.metrics === 'object') return [j.metrics];
  throw new Error('JSON 结构无法识别（需要数组或 {records|data|rows:[...]}）');
}

/**
 * 读一个文件 → 每日行数组
 * @param {string} file
 * @returns {Promise<{rows:object[], kind:string, note:string}>}
 */
async function readFileRows(file) {
  const ext = path.extname(file).toLowerCase();

  // Apple 健康导出：zip / export.xml —— 走流式解析，绝不整包读进内存
  if (ext === '.zip' || ext === '.xml') {
    const { rows, stats } = await parseAppleHealth(file, {
      onProgress: (scanned) => log(`  …已扫描 ${scanned / 10000} 万行`),
    });
    return { rows, kind: 'Apple 健康导出', note: `${stats.from} ~ ${stats.to}（命中 ${stats.kept} 条原始记录）` };
  }

  const text = fs.readFileSync(file, 'utf8');
  if (ext === '.json' || /^\s*[[{]/.test(text)) {
    return { rows: jsonToRows(text), kind: 'JSON', note: '' };
  }
  return { rows: csvToRows(text), kind: 'CSV', note: '' };
}

// ------------------------------------------------------------------ 与平台通信
/** 带超时与重试的 fetch（网络抖动时不至于丢数据） */
async function request(pathname, init = {}, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i += 1) {
    try {
      const res = await fetch(cfg.url + pathname, {
        ...init,
        headers: { 'Content-Type': 'application/json', 'X-Sync-Token': cfg.token, ...(init.headers || {}) },
        signal: AbortSignal.timeout(60_000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.code) throw new Error(body.message || `HTTP ${res.status}`);
      return body;
    } catch (e) {
      lastErr = e;
      if (i < tries) await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  throw lastErr;
}

/** 校验令牌（配错了立刻告诉用户，而不是等半天没反应） */
async function ping() {
  const r = await request('/api/sync/ping', { method: 'GET' });
  ok(`令牌有效 · 账号：${r.data.user} · 令牌备注：${r.data.tokenName || '—'}`);
  if (r.data.lastSync) warn(`最近一次同步：${r.data.lastSync.summary}（${r.data.lastSync.createdAt}）`);
  return r.data;
}

/**
 * 推送一批行
 * @param {object[]} rows 每日指标行
 * @param {string} label 来源描述（写进同步历史）
 */
async function pushRows(rows, label) {
  if (!rows.length) {
    warn('文件里没有可用的每日数据，跳过');
    return null;
  }
  if (args['dry-run']) {
    log(`  [dry-run] 将推送 ${rows.length} 天：${JSON.stringify(rows.slice(0, 3))}`);
    return { data: { written: 0, updated: 0, summary: 'dry-run' } };
  }
  const r = await request('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ device: `${cfg.device}${label ? ` · ${label}` : ''}`, rows }),
  });
  ok(r.data.summary || `已推送 ${rows.length} 天`);
  return r;
}

// ------------------------------------------------------------------ 已处理文件记录
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}
/** 文件指纹：大小 + 修改时间。任一变化就认为"内容变了"，需要重推 */
function fingerprint(file) {
  const st = fs.statSync(file);
  return `${st.size}:${Math.round(st.mtimeMs)}`;
}

/** 处理单个文件（成功返回 true；失败不写 state，下次重试） */
async function processFile(file, state) {
  const name = path.basename(file);
  // iCloud 未下载完的占位文件（.xxx.icloud）跳过，等它真正落地
  if (name.endsWith('.icloud')) return false;
  if (!/\.(zip|xml|csv|json|txt)$/i.test(name)) return false;

  const fp = fingerprint(file);
  if (!args.force && state[file]?.fingerprint === fp) return false;

  log(`\n📄 ${name}`);
  try {
    const { rows, kind, note } = await readFileRows(file);
    log(`  来源：${kind}${note ? ` · ${note}` : ''} · 解析到 ${rows.length} 天数据`);
    const r = await pushRows(rows, kind);
    if (r) {
      state[file] = { fingerprint: fp, pushedAt: new Date().toISOString(), days: rows.length };
      saveState(state);
    }
    return true;
  } catch (e) {
    bad(`处理失败：${e.message}（这份文件会在下次扫描时重试）`);
    return false;
  }
}

// ------------------------------------------------------------------ 两种模式
async function runOnce(file) {
  if (!fs.existsSync(file)) {
    bad('找不到文件：' + file);
    process.exit(1);
  }
  await ping();
  const state = loadState();
  await processFile(path.resolve(file), state);
  log('\n完成。');
}

async function runWatch(dir) {
  const absDir = path.resolve(dir);
  if (!fs.existsSync(absDir)) {
    bad('目录不存在：' + absDir);
    console.error('   提示：iPhone「存储文件到“文件”」默认落在 iCloud 云盘的某个文件夹，先手动建好这个目录。');
    process.exit(1);
  }
  await ping();
  if (args['reset-state']) {
    saveState({});
    log('已清空已推送记录');
  }

  const state = loadState();
  log(`\n👀 正在监听：${absDir}`);
  log('   （iPhone 快捷指令 / 健康导出文件放到这里就会自动推送；Ctrl+C 退出）');

  // 启动时先把目录里已有的文件扫一遍（漏掉的历史文件也能补上）
  const scan = async () => {
    const entries = fs.readdirSync(absDir, { withFileTypes: true }).filter((d) => d.isFile());
    for (const e of entries) await processFile(path.join(absDir, e.name), state);
  };
  await scan();

  // 用轮询而不是 fs.watch 的原因：Windows 的递归监听对 iCloud/网盘同步目录经常丢事件，
  // 而健康数据一天就几个文件，3 秒扫一次开销可以忽略（且更可靠）。
  const intervalMs = Number(args.interval) || 3000;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await scan();
    } catch (e) {
      warn('扫描出错（继续运行）：' + e.message);
    } finally {
      running = false;
    }
  }, intervalMs);

  const stop = () => {
    clearInterval(timer);
    log('\n已停止监听。');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// ------------------------------------------------------------------ 入口
log('智练 SmartFit · 健康数据自动同步');
log(`  平台：${cfg.url}`);
log(`  来源：${cfg.device}`);

try {
  if (MODE === 'once') await runOnce(String(args.once === true ? args._[0] : args.once));
  else await runWatch(String(args.watch === true ? args._[0] : args.watch));
} catch (e) {
  bad(e.message || e);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|timeout/i.test(String(e.message))) {
    console.error(`   检查一下平台地址是否正确、服务是否已启动：${cfg.url}/api/health`);
  }
  process.exit(1);
}
