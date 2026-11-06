/**
 * 提交前自检：一条命令确认「代码仓库 / 在线演示 / 作品文档」三件提交物都真的可用
 * ===========================================================================
 * 用法：
 *   node tools/verify-submission.mjs
 *   node tools/verify-submission.mjs --repo L-X-Bit/smartfit- --url https://smartfit-qsyh.onrender.com
 *
 * 检查内容（对应比赛表单的字段 2、4、6）：
 *   1. GitHub 仓库是否【公开】、默认分支、最新提交、提交总数（细粒度历史）
 *   2. README 是否含：项目介绍 / 技术架构 / 安装运行 / 团队信息 / 环境变量模板 / 依赖清单
 *   3. .env.example 是否公开可读（环境变量模板）
 *   4. 技术文档 PDF 是否在仓库里、多大
 *   5. 在线演示：首页可打开、/api/health 正常、demo 账号能登录、核心接口 200
 *
 * 退出码：全部通过 0，有失败 1（可挂进 CI 或提交前的最后一道检查）。
 */
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const REPO = arg('repo', 'L-X-Bit/smartfit-');
const BASE = arg('url', 'https://smartfit-qsyh.onrender.com').replace(/\/$/, '');
const DEMO = { username: arg('user', 'demo'), password: arg('pass', '123456') };

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '　' + detail : ''}`);
};

const gh = { 'user-agent': 'dsh', accept: 'application/vnd.github+json' };

async function getJson(url, opt) {
  const r = await fetch(url, opt);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

async function ghFile(path) {
  const r = await getJson(`https://api.github.com/repos/${REPO}/contents/${encodeURI(path)}`, { headers: gh });
  if (r.status !== 200 || r.body?.type !== 'file') return null;
  // 超过 1MB 的文件 GitHub 不返回 content（encoding: none），此时 text 为 null，只能校验存在性与大小
  const text = r.body.content ? Buffer.from(r.body.content, 'base64').toString('utf8') : null;
  return { text, size: r.body.size };
}

console.log(`\n== 1. 代码仓库 https://github.com/${REPO} ==`);
const repo = await getJson(`https://api.github.com/repos/${REPO}`, { headers: gh });
check('仓库可访问', repo.status === 200, `HTTP ${repo.status}`);
check('仓库公开（评审无需登录）', repo.body?.private === false, `private=${repo.body?.private}`);
check('默认分支', !!repo.body?.default_branch, repo.body?.default_branch);

const readme = await ghFile('README.md');
check('README 存在', !!readme, readme ? `${readme.size} 字节` : '');
if (readme?.text) {
  for (const [label, kw] of [['项目介绍', '项目介绍'], ['技术架构', '技术架构'], ['安装运行指南', '安装运行'], ['团队信息', '团队信息'], ['环境变量模板', '环境变量模板'], ['依赖清单', '依赖清单']]) {
    check(`README 含${label}`, readme.text.includes(kw));
  }
}

const env = await ghFile('.env.example');
check('.env.example 公开可读', !!env, env?.text ? `${env.text.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).length} 个变量` : '');

const pdf = await ghFile('docs/智练SmartFit-技术文档.pdf');
check('技术文档 PDF 在仓库中', !!pdf, pdf ? `${(pdf.size / 1024 / 1024).toFixed(2)} MB` : '');

let total = 0;
for (let page = 1; ; page++) {
  const r = await getJson(`https://api.github.com/repos/${REPO}/commits?per_page=100&page=${page}`, { headers: gh });
  if (!Array.isArray(r.body) || r.body.length === 0) break;
  total += r.body.length;
  if (r.body.length < 100) break;
}
const latest = await getJson(`https://api.github.com/repos/${REPO}/commits?per_page=1`, { headers: gh });
check('细粒度提交历史', total >= 30, `${total} 次提交`);
check('最新提交', true, `${latest.body?.[0]?.sha?.slice(0, 7)} ${latest.body?.[0]?.commit?.message?.split('\n')[0]?.slice(0, 50)}`);

console.log(`\n== 2. 在线演示 ${BASE} ==`);
try {
  const home = await fetch(BASE + '/', { redirect: 'follow' });
  const html = await home.text();
  check('首页可打开', home.status === 200, `HTTP ${home.status}`);
  const bundle = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/);
  check('前端 bundle 可解析', !!bundle, bundle ? bundle[0] : '未找到 assets/index-*.js（可能是旧构建）');
} catch (e) {
  check('首页可打开', false, e.message);
}

const health = await getJson(BASE + '/api/health');
check('/api/health 正常', health.status === 200 && health.body?.code === 0, `env=${health.body?.data?.env}`);

const login = await getJson(BASE + '/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(DEMO),
});
const token = login.body?.data?.token;
check(`演示账号 ${DEMO.username}/${DEMO.password} 可登录`, login.status === 200 && !!token);

if (token) {
  for (const p of ['/api/dashboard/overview', '/api/plan/list', '/api/ai/status', '/api/checkin/stats']) {
    const r = await getJson(BASE + p, { headers: { authorization: 'Bearer ' + token } });
    check(`接口 ${p}`, r.status === 200 && r.body?.code === 0, `HTTP ${r.status}`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n== 结果：${results.length - failed.length} 通过 / ${failed.length} 失败 ==`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  · ${f.name} ${f.detail}`);
  process.exit(1);
}
console.log('提交物自检全部通过，可以提交表单。\n');
