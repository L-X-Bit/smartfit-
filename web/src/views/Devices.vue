<!--
  设备同步页（可穿戴设备 → 平台）
  ===========================================================================
  为什么要有这一页：
    前面所有数据都是「人手工录进去的」（打卡、记饮食、填体重），而真实用户
    大部分运动数据其实躺在手表/手环里。让设备数据自动进来，才叫「健康管理平台」；
    否则只是一个记录本。

  三条通路（覆盖所有实际情况，缺一不可）：
    ① 蓝牙心率带实时连接 —— 浏览器 Web Bluetooth 直连设备的**标准 GATT 心率服务 0x180D**。
       手环、心率带、智能手表普遍支持这个标准服务，不需要任何厂商授权，
       也不受"华为/小米/Apple 云 API 需要企业资质 + OAuth 审核"的限制。
    ② 导出手环 App 的数据文件（CSV / JSON）—— 兼容性最好的一条路，任何品牌都能用。
    ③ 演示模式 —— 没有设备的场景（答辩现场、机房）一键生成 7 天模拟数据，
       保证功能完整可演示，而不是"没设备就看不到效果"。

  技术要点（讲解时可讲）：
    · 心率测量特征值（0x2A37）第一个字节是 flags，bit0 = 1 表示心率是 16 位
      （uint16 little-endian），否则是 8 位 —— 这是标准规定的，不是我们随便解析的；
    · Web Bluetooth 只在"安全上下文"可用：https 或 localhost。所以用内网穿透的
      https 域名时手机可以真连设备，用 http://内网IP 打开则不行；
    · iOS 的 Safari 不支持 Web Bluetooth，此时页面自动引导用户走 ②③ 两条路，
      不会出现"点了没反应"的死按钮。
-->
<template>
  <div v-loading="loading">
    <!-- ==================== 顶部总览 ==================== -->
    <div class="dev-hero card">
      <div class="hero-main">
        <div class="hero-title">⌚ 把「手表 / 手环」的数据接进平台</div>
        <div class="hero-desc">
          蓝牙实时心率 · 文件导入 · 无设备演示，三条通路任选其一。设备数据进入平台后会参与
          <b>每日目标热量、AI 教练判断、训练完成度</b> 的计算——不是只展示好看。
        </div>
        <div class="hero-chips">
          <span class="chip" :class="btReady ? 'ok' : 'warn'">蓝牙接口 {{ btReady ? '可用' : '不可用' }}</span>
          <span class="chip">已同步 {{ status.syncCount }} 次</span>
          <span class="chip" v-if="status.lastSync">{{ sourceText(status.lastSync.source) }} · {{ status.lastSync.createdAt }}</span>
        </div>
      </div>
      <div class="hero-stats">
        <div class="hs-item">
          <div class="hs-label">最近静息心率</div>
          <div class="hs-value">
            {{ status.latestBody?.restingHr || '-' }}<span class="unit">bpm</span>
          </div>
        </div>
        <div class="hs-item">
          <div class="hs-label">最近睡眠</div>
          <div class="hs-value">
            {{ status.latestBody?.sleepHours || '-' }}<span class="unit">h</span>
          </div>
        </div>
        <div class="hs-item">
          <div class="hs-label">数据日期</div>
          <div class="hs-value small">{{ status.latestBody?.date || '—' }}</div>
        </div>
      </div>
    </div>

    <div class="grid dev-grid" style="grid-template-columns: 1fr 380px">
      <!-- ==================== ① 蓝牙实时心率 ==================== -->
      <div class="card">
        <div class="card-title">
          <span>① 蓝牙心率带 / 手环（实时）</span>
          <span class="sub">Web Bluetooth · 标准心率服务 0x180D</span>
        </div>

        <!--
          不支持蓝牙时的诊断卡
          ------------------------------------------------------------------
          不写"暂不支持"这种废话，而是：① 说清楚**具体原因**（浏览器没这个接口 /
          不是 https / 苹果设备），② 直接给**可点的补救按钮**（在安卓上可以用 intent:
          链接强制跳到 Chrome / Edge / 三星浏览器打开本页），③ 提示 安卓首次连接要授权
          「附近的设备 / 位置」权限——这一步没做，Chrome 里点连接也会立刻失败。
        -->
        <div v-if="!btReady" class="bt-tip warn">
          <div class="bt-tip-title">⚠️ {{ btDiag.title }}</div>
          <div class="bt-tip-detail">{{ btDiag.detail }}</div>
          <div v-if="btDiag.hint" class="bt-tip-detail">{{ btDiag.hint }}</div>
          <div class="bt-tip-actions">
            <el-button v-if="btDiag.android" size="small" type="primary" plain @click="openInBrowser('com.android.chrome')">
              用 Chrome 打开
            </el-button>
            <el-button v-if="btDiag.android" size="small" plain @click="openInBrowser('com.microsoft.emmx')">用 Edge 打开</el-button>
            <el-button v-if="btDiag.android" size="small" plain @click="openInBrowser('com.sec.android.app.sbrowser')">三星浏览器</el-button>
            <el-button size="small" plain @click="copyLink">{{ linkCopied ? '已复制 ✓' : '复制本页链接' }}</el-button>
          </div>
          <div class="bt-tip-detail">
            不用折腾浏览器：下面就有「<b>✍️ 手动填一次</b>」表单，2 秒填完整，
            第 ② 条「<b>导入数据</b>」和第 ③ 条「<b>演示模式</b>」也都能用——数据一样进平台。
            想要「实时心率曲线」才需要换 Chrome。
          </div>
        </div>

        <div class="bt-bar">
          <el-button
            v-if="!connected"
            type="primary"
            class="btn-gradient"
            :loading="connecting"
            :disabled="!btReady"
            @click="connect"
          >
            {{ connecting ? '正在连接…' : '连接设备' }}
          </el-button>
          <el-button v-else type="danger" plain @click="disconnect">断开连接</el-button>

          <el-button v-if="!connected" :disabled="connecting" @click="simulate">无设备？生成一段模拟心率</el-button>

          <span class="bt-state">
            <span class="dot" :class="{ on: connected }"></span>
            {{ connected ? `已连接 · ${deviceName}` : samples.length ? `未连接 · ${deviceName}` : '未连接' }}
          </span>
        </div>

        <!--
          设备侧的坑：光有浏览器还不够，**设备必须正在广播心率服务 0x180D**。
          心率带（Polar H10、迈欧等）开机即广播；但小米/华为手环默认只和自家 App 通信，
          必须在 App 里手动打开「心率广播」，否则浏览器的设备选择器里根本搜不到。
          实测很多同学卡在这一步，所以写在界面上而不是只写进文档。
        -->
        <div v-if="btReady" class="bt-note">
          💡 设备也要配合：心率带开机即广播；<b>小米手环请在 Zepp Life 里开启「心率广播」</b>，华为手环开启
          「心率广播 / 运动心率共享」，并确保它当前没连着手机蓝牙设置或别的 App（同一时间只能被一个中心设备连接）。
        </div>
        <!--
          手动记录心率 —— 「任何浏览器都能用」的兜底方案
          ------------------------------------------------------------------
          手机上的夸克 / 小米 / UC 浏览器、以及 iPhone 上所有浏览器，
          都没有 Web Bluetooth 接口（软件层面无法绕过）。但它们发 POST 请求完全没问题，
          所以这里给一个纯表单录入：填平均/最高/最低/时长即可落库，
          数据照样进同步历史、照样能更新当日静息心率。
        -->
        <div class="manual-box">
          <div class="manual-title">
            ✍️ 没有蓝牙接口？直接手动填一次
            <span class="manual-sub">任何浏览器都能用（夸克 / 小米 / iPhone 全支持）</span>
          </div>
          <div class="manual-grid">
            <label class="mf">
              <span>日期</span>
              <el-date-picker v-model="manual.date" type="date" value-format="YYYY-MM-DD" :clearable="false" size="small" style="width: 100%" />
            </label>
            <label class="mf">
              <span>平均心率</span>
              <el-input-number v-model="manual.avg" :min="20" :max="250" size="small" controls-position="right" style="width: 100%" />
            </label>
            <label class="mf">
              <span>最高</span>
              <el-input-number v-model="manual.max" :min="20" :max="250" size="small" controls-position="right" style="width: 100%" />
            </label>
            <label class="mf">
              <span>最低</span>
              <el-input-number v-model="manual.min" :min="20" :max="250" size="small" controls-position="right" style="width: 100%" />
            </label>
            <label class="mf">
              <span>时长（分钟）</span>
              <el-input-number v-model="manual.minutes" :min="1" :max="600" size="small" controls-position="right" style="width: 100%" />
            </label>
            <div class="mf mf-btn">
              <el-checkbox v-model="manual.saveAsRestingHr" size="small">记为该日静息心率</el-checkbox>
              <el-button type="primary" size="small" :loading="manualSaving" @click="saveManual">保存心率</el-button>
            </div>
          </div>
        </div>

        <div class="hr-stage">
          <div class="hr-now">
            <div class="hr-num" :class="{ live: connected }">{{ currentBpm ?? '--' }}</div>
            <div class="hr-unit">bpm</div>
          </div>
          <div class="hr-stats">
            <div class="hr-stat">
              <div class="k">平均</div>
              <div class="v">{{ stats.avg || '-' }}</div>
            </div>
            <div class="hr-stat">
              <div class="k">最高</div>
              <div class="v">{{ stats.max || '-' }}</div>
            </div>
            <div class="hr-stat">
              <div class="k">最低</div>
              <div class="v">{{ stats.min || '-' }}</div>
            </div>
            <div class="hr-stat">
              <div class="k">时长</div>
              <div class="v">{{ elapsed }}<span class="u">s</span></div>
            </div>
          </div>
        </div>

        <ChartBox :option="hrOption" height="200px" :empty="samples.length === 0" empty-text="连接设备或生成模拟心率后，这里会实时画出心率曲线" />

        <div class="hr-foot">
          <el-checkbox v-model="saveAsRestingHr">把平均心率记为今日静息心率（写入身体数据）</el-checkbox>
          <el-button type="primary" plain :loading="saving" :disabled="!samples.length" @click="save">保存这次记录</el-button>
        </div>
      </div>

      <!-- ==================== ② 导入 + ③ 演示 ==================== -->
      <div>
        <div class="card">
          <div class="card-title">
            <span>② 导入数据</span>
            <span class="sub">手环 App 导出的 CSV / JSON</span>
          </div>

          <div class="imp-actions">
            <el-button size="small" @click="downloadTemplate">下载 CSV 模板</el-button>
            <el-button size="small" @click="pickFile">选择文件</el-button>
            <input ref="fileInput" type="file" accept=".csv,.json,.txt" class="hidden-input" @change="onFile" />
          </div>

          <el-input
            v-model="csvText"
            type="textarea"
            :rows="5"
            resize="none"
            placeholder="也可以直接粘贴，例如：
date,steps,restingHr,sleepHours,weightKg
2026-10-20,8600,64,7.2,75.2"
          />

          <div class="imp-actions bottom">
            <el-button size="small" :loading="previewing" :disabled="!csvText.trim()" @click="doPreview">预览解析</el-button>
            <el-button size="small" type="primary" :loading="importing" :disabled="!csvText.trim()" @click="doImport">
              确认导入
            </el-button>
            <span class="imp-hint">支持中英文表头、列顺序随意、缺列自动跳过</span>
          </div>

          <!--
            Apple Watch / iPhone 用户必看
            ------------------------------------------------------------------
            网页**连不上 Apple Watch**：它不广播蓝牙标准心率服务（0x180D），只和 iPhone 私有通信，
            Apple 也没给浏览器开放 HealthKit。唯一正路是走「Apple 健康」App 的导出数据，
            所以这里给一条明确可执行的路径，而不是让用户以为功能坏了。
          -->
          <div class="apple-tip">
            <div class="apple-title">🍎 有 Apple Watch / iPhone？</div>
            <div class="apple-body">
              网页<b>无法直连 Apple Watch</b>（Apple 不开放浏览器读 HealthKit）。正确做法：
              ① iPhone「健康」App → 右上头像 → 最下面「<b>导出所有健康数据</b>」；
              ② 把导出的 zip 传到电脑，运行
              <code>node tools/apple-health-to-csv.mjs "导出.zip"</code>；
              ③ 生成的小 CSV 用上面的「选择文件 / 粘贴」导入即可。
              心率、静息心率、步数、睡眠、体重都会带进来。
            </div>
          </div>

          <!-- 预览表：先看再写库，避免"一股脑灌进去" -->
          <div v-if="preview.length" class="imp-preview">
            <div class="imp-preview-title">
              预览（解析到 {{ previewTotal }} 行，最多展示 20 行）
            </div>
            <el-table :data="preview" size="small" max-height="220">
              <el-table-column prop="date" label="日期" width="96" />
              <el-table-column prop="steps" label="步数" width="72" />
              <el-table-column prop="restingHr" label="心率" width="62" />
              <el-table-column prop="sleepHours" label="睡眠" width="62" />
              <el-table-column prop="weightKg" label="体重" />
            </el-table>
          </div>
        </div>

        <div class="card mt-16">
          <div class="card-title">
            <span>③ 演示模式</span>
            <span class="sub">没有设备时也能完整演示</span>
          </div>
          <div class="demo-row">
            <el-radio-group v-model="demoDays" size="small">
              <el-radio-button :value="7">7 天</el-radio-button>
              <el-radio-button :value="14">14 天</el-radio-button>
              <el-radio-button :value="30">30 天</el-radio-button>
            </el-radio-group>
            <el-button type="primary" class="btn-gradient" :loading="demoRunning" @click="runDemo">一键生成</el-button>
          </div>
          <div class="demo-tip">
            生成最近 {{ demoDays }} 天的步数 / 静息心率 / 睡眠：写入
            <b>身体数据</b>，并按 MET 公式把步数折算成<b>步行打卡</b>——所以打卡日历、消耗热量、
            完成度都会真的变化。数据在同步历史里标记为「演示」，不会和真实数据混淆。
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== 一周数据 + 同步历史 ==================== -->
    <div class="grid grid-2 mt-16">
      <div class="card">
        <div class="card-title">
          <span>设备带来的一周数据</span>
          <span class="sub">来自导入 / 演示的每日汇总</span>
        </div>
        <ChartBox :option="weekOption" height="260px" :empty="!weekly.list.length" empty-text="还没有设备数据，先在上面导入或生成" />
        <div v-if="weekly.list.length" class="week-sum">
          <span>日均步数 <b>{{ weekly.summary.avgSteps }}</b></span>
          <span>日均静息心率 <b>{{ weekly.summary.avgRestingHr }}</b> bpm</span>
          <span>日均睡眠 <b>{{ weekly.summary.avgSleep }}</b> h</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>同步历史</span>
          <span class="sub">最近 30 条</span>
        </div>
        <div v-if="!history.length" class="empty-state">
          <div class="empty-icon">📭</div>
          <div class="empty-text">还没有同步记录</div>
        </div>
        <div v-else class="hist-list">
          <div v-for="h in history" :key="h.id" class="hist-row">
            <el-tag size="small" :type="sourceTag(h.source)" effect="plain">{{ sourceText(h.source) }}</el-tag>
            <div class="hist-body">
              <div class="hist-sum">{{ h.summary }}</div>
              <div class="hist-meta">{{ h.deviceName || '—' }} · {{ h.createdAt }} · 写入 {{ h.recordCount }} 条</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '@/api';
import ChartBox from '@/components/ChartBox.vue';

// ---------------------------------------------------------------- 状态数据
const loading = ref(false);
const status = ref({ syncCount: 0, lastSync: null, latestBody: null, importTemplate: '' });
const history = ref([]);
const weekly = ref({ list: [], summary: {} });

// ---------------------------------------------------------------- 蓝牙部分
const connecting = ref(false);
const connected = ref(false);
const deviceName = ref('');
const currentBpm = ref(null);
/** 本次会话的心率采样（只在前端内存里，保存时才提交最近 200 个） */
const samples = ref([]);
const elapsed = ref(0);
const saveAsRestingHr = ref(true);
const saving = ref(false);

let device = null; // BluetoothDevice
let hrChar = null; // 心率测量特征值
let timer = null; // 计时器

const stats = computed(() => {
  const s = samples.value;
  if (!s.length) return { avg: 0, max: 0, min: 0 };
  const sum = s.reduce((a, b) => a + b, 0);
  return { avg: Math.round(sum / s.length), max: Math.max(...s), min: Math.min(...s) };
});

/** 实时心率曲线：只在有数据时显示，避免空图 */
const hrOption = computed(() => ({
  grid: { left: 40, right: 14, top: 14, bottom: 24 },
  tooltip: { trigger: 'axis', formatter: (p) => `${p[0].axisValue} 秒 · ${p[0].data} bpm` },
  xAxis: {
    type: 'category',
    boundaryGap: false,
    data: samples.value.map((_, i) => i + 1),
    axisLabel: { fontSize: 10, color: '#94a3b8' },
  },
  yAxis: {
    type: 'value',
    scale: true,
    axisLabel: { fontSize: 10, color: '#94a3b8' },
    splitLine: { lineStyle: { type: 'dashed', color: '#eef2f7' } },
  },
  series: [
    {
      type: 'line',
      smooth: true,
      showSymbol: false,
      data: samples.value,
      lineStyle: { width: 2.4, color: '#ef4444' },
      areaStyle: { color: 'rgba(239, 68, 68, 0.12)' },
    },
  ],
}));

/**
 * 解析心率测量值（GATT 0x2A37）
 * ---------------------------------------------------------------------------
 * 标准规定：第 1 个字节是 Flags，Flags 的 bit0 = 1 时心率是 16 位无符号整数
 * （小端序，占 2 字节），为 0 时是 8 位。这里严格按规范解析，而不是"猜一个数字"。
 */
function onMeasure(event) {
  const v = event.target.value;
  const flags = v.getUint8(0);
  const bpm = flags & 0x01 ? v.getUint16(1, true) : v.getUint8(1);
  if (!bpm || bpm < 20 || bpm > 250) return;
  currentBpm.value = bpm;
  if (samples.value.length < 3000) samples.value.push(bpm);
}

async function connect() {
  if (!navigator.bluetooth) {
    ElMessage.warning('当前浏览器不支持 Web Bluetooth');
    return;
  }
  connecting.value = true;
  try {
    // filters 只列出标准心率服务：设备选择器里就只会出现真正的心率设备
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: ['heart_rate'] }],
      optionalServices: ['battery_service'],
    });
    deviceName.value = device.name || '蓝牙心率设备';
    device.addEventListener('gattserverdisconnected', onDisconnected);

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService('heart_rate');
    hrChar = await service.getCharacteristic('heart_rate_measurement');
    await hrChar.startNotifications();
    hrChar.addEventListener('characteristicvaluechanged', onMeasure);

    connected.value = true;
    samples.value = [];
    currentBpm.value = null;
    elapsed.value = 0;
    startTimer();
    ElMessage.success(`已连接 ${deviceName.value}，正在接收心率`);
  } catch (err) {
    // 用户取消选择设备也会进 catch（NotFoundError），不弹错误打扰
    if (err?.name !== 'NotFoundError') ElMessage.error(`连接失败：${err.message || err.name}`);
  } finally {
    connecting.value = false;
  }
}

function onDisconnected() {
  connected.value = false;
  stopTimer();
  ElMessage.warning('设备已断开连接');
}

async function disconnect() {
  stopTimer();
  try {
    await hrChar?.stopNotifications();
    device?.gatt?.connected && device.gatt.disconnect();
  } catch {
    /* 设备可能已经断开，忽略 */
  }
  connected.value = false;
  ElMessage.info('已断开');
}

function startTimer() {
  stopTimer();
  timer = setInterval(() => {
    elapsed.value += 1;
  }, 1000);
}
function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * 模拟一段心率（无设备时的兜底演示）
 * 生成"静息 → 轻度活动 → 回落"的合理曲线：65~86 bpm，60 个采样点。
 * 两个刻意的设计：
 *   1. 峰值不超过 90——这是"日常活动"的强度，不是剧烈运动，演示时不至于夸张；
 *   2. 默认**不勾选**「记为静息心率」——模拟数据的平均值不该覆盖真实的静息心率，
 *      想让演示流程走完可以自己勾上，卡片上也会标「模拟」。
 */
function simulate() {
  const n = 60;
  const base = 72;
  samples.value = [];
  for (let i = 0; i < n; i += 1) {
    const ramp = Math.sin((i / n) * Math.PI) * 14; // 先升后降的包络
    const noise = (Math.random() - 0.5) * 4;
    samples.value.push(Math.round(base + ramp + noise));
  }
  currentBpm.value = samples.value[samples.value.length - 1];
  elapsed.value = n;
  deviceName.value = '模拟心率（演示模式）';
  connected.value = false;
  saveAsRestingHr.value = false;
  stopTimer();
  ElMessage.info('已生成一段 60 秒的模拟心率（模拟数据默认不写入静息心率）');
}

async function save() {
  if (!samples.value.length) return;
  saving.value = true;
  try {
    // durationSec 用实际计时；模拟数据没有计时器，就用采样个数（1 个/秒）兜底
    const durationSec = Math.max(1, elapsed.value || samples.value.length);
    await api.saveHeartRate({
      deviceName: deviceName.value || '蓝牙心率设备',
      avg: stats.value.avg,
      max: stats.value.max,
      min: stats.value.min,
      durationSec,
      samples: samples.value.slice(-200),
      saveAsRestingHr: saveAsRestingHr.value,
    });
    ElMessage.success(
      saveAsRestingHr.value
        ? `已保存：平均 ${stats.value.avg} bpm，并写入今日静息心率`
        : `已保存：平均 ${stats.value.avg} bpm`,
    );
    await refreshAll();
  } finally {
    saving.value = false;
  }
}

// ---------------------------------------------------------------- 导入部分
const csvText = ref('');
const preview = ref([]);
const previewTotal = ref(0);
const previewing = ref(false);
const importing = ref(false);
const fileInput = ref(null);

function detectFormat() {
  return /^\s*[[{]/.test(csvText.value) ? 'json' : 'csv';
}

function pickFile() {
  fileInput.value?.click();
}

function onFile(ev) {
  const f = ev.target.files?.[0];
  if (!f) return;
  if (f.size > 500 * 1024) {
    ElMessage.warning('文件过大（请小于 500KB）');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    csvText.value = String(reader.result || '');
    doPreview();
  };
  reader.readAsText(f, 'utf-8');
  ev.target.value = ''; // 允许重复选择同一个文件
}

/** 下载 CSV 模板：用后端返回的模板内容生成 Blob，避免前端再维护一份格式 */
function downloadTemplate() {
  const content = status.value.importTemplate || 'date,steps,restingHr,sleepHours,weightKg\n';
  const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8' }); // 加 BOM，Excel 打开不乱码
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '智练-设备数据导入模板.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function doPreview() {
  previewing.value = true;
  try {
    const res = await api.importDeviceData({ format: detectFormat(), content: csvText.value, dryRun: true });
    preview.value = res.preview || [];
    previewTotal.value = res.total || 0;
    ElMessage.success(`解析到 ${res.total} 行`);
  } finally {
    previewing.value = false;
  }
}

async function doImport() {
  importing.value = true;
  try {
    const res = await api.importDeviceData({ format: detectFormat(), content: csvText.value });
    ElMessage.success(res.summary || '导入完成');
    preview.value = [];
    previewTotal.value = 0;
    csvText.value = '';
    await refreshAll();
  } finally {
    importing.value = false;
  }
}

// ---------------------------------------------------------------- 演示模式
const demoDays = ref(7);
const demoRunning = ref(false);

async function runDemo() {
  demoRunning.value = true;
  try {
    const res = await api.generateDeviceDemo(demoDays.value);
    ElMessage.success(res.summary || '已生成演示数据');
    await refreshAll();
  } finally {
    demoRunning.value = false;
  }
}

// ---------------------------------------------------------------- 一周数据图
const weekOption = computed(() => {
  const list = weekly.value.list || [];
  return {
    grid: { left: 46, right: 40, top: 30, bottom: 26 },
    tooltip: { trigger: 'axis' },
    legend: { data: ['步数', '静息心率'], top: 0, textStyle: { fontSize: 11 } },
    xAxis: {
      type: 'category',
      data: list.map((x) => x.date.slice(5)),
      axisLabel: { fontSize: 10, color: '#94a3b8' },
    },
    yAxis: [
      { type: 'value', name: '步', nameTextStyle: { fontSize: 10 }, axisLabel: { fontSize: 10, color: '#94a3b8' }, splitLine: { lineStyle: { type: 'dashed', color: '#eef2f7' } } },
      // 静息心率的合理区间基本在 50~90，固定这个范围：
      // 用 scale:true 自动缩放会把 63 和 66 的差别放大成整条曲线的剧烈起伏，看起来像心率飙升，反而误导
      { type: 'value', name: 'bpm', nameTextStyle: { fontSize: 10 }, min: 50, max: 90, axisLabel: { fontSize: 10, color: '#94a3b8' }, splitLine: { show: false } },
    ],
    series: [
      {
        name: '步数',
        type: 'bar',
        barWidth: '46%',
        data: list.map((x) => x.steps),
        itemStyle: { color: '#10b981', borderRadius: [4, 4, 0, 0] },
      },
      {
        name: '静息心率',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        data: list.map((x) => x.restingHr),
        lineStyle: { width: 2.4, color: '#ef4444' },
        itemStyle: { color: '#ef4444' },
      },
    ],
  };
});

// ---------------------------------------------------------------- 工具
function sourceText(s) {
  return { bluetooth: '蓝牙心率', import: '文件导入', demo: '演示数据' }[s] || s;
}
function sourceTag(s) {
  return { bluetooth: 'danger', import: 'primary', demo: 'warning' }[s] || 'info';
}

/** 拉取页面所需的全部数据（概览 / 一周 / 历史） */
async function refreshAll() {
  loading.value = true;
  try {
    const [st, hist, day] = await Promise.all([api.deviceStatus(), api.deviceHistory(), api.deviceDaily(7)]);
    status.value = st;
    history.value = hist || [];
    weekly.value = day || { list: [], summary: {} };
  } finally {
    loading.value = false;
  }
}

/**
 * 浏览器环境识别（用于给出"到底该怎么办"的精确提示）
 * ---------------------------------------------------------------------------
 * 实测结论（踩过的坑）：
 *   · Chrome / Edge / 三星浏览器（安卓）支持 Web Bluetooth；
 *   · **小米浏览器、夸克、UC、QQ 浏览器等国产内核虽然也是 Chromium，但普遍不开放
 *     navigator.bluetooth**——页面里就完全看不到这个接口，表现为"点了没反应"；
 *   · iOS 上**所有**浏览器（Safari、Chrome for iOS）都不支持，因为 Apple 没实现该标准；
 *   · 桌面 Chrome / Edge 在 Windows 10+ 可用（走系统蓝牙栈）。
 * 所以这里不只判断"有没有接口"，还要告诉用户换哪个浏览器、以及怎么换。
 */
const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const env = {
  isIOS: /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document),
  isAndroid: /Android/i.test(ua),
  browser: /Quark/i.test(ua)
    ? '夸克浏览器'
    : /UCBrowser|UBrowser/i.test(ua)
      ? 'UC 浏览器'
      : /MQQBrowser|QQBrowser/i.test(ua)
        ? 'QQ 浏览器'
        : /MiuiBrowser|XiaoMi/i.test(ua)
          ? '小米浏览器'
          : /HuaweiBrowser/i.test(ua)
            ? '华为浏览器'
            : /EdgA?\//i.test(ua)
              ? 'Edge'
              : /Chrome\//.test(ua)
                ? 'Chrome'
                : /Safari\//.test(ua)
                  ? 'Safari'
                  : '当前浏览器',
};

const btReady = ref(false);
/** 「复制本页链接」按钮的反馈状态 */
const linkCopied = ref(false);

/** 根据检测结果组织出"标题 + 原因 + 下一步该做什么" */
const btDiag = computed(() => {
  const android = env.isAndroid;
  if (!window.isSecureContext) {
    return {
      android,
      title: '这个页面不是 https，浏览器不允许用蓝牙',
      detail: 'Web Bluetooth 只在这两种地址下可用：https:// 开头的网址，或本机的 localhost。',
      hint: '换成 https 的地址打开（例如云端的 https://smartfit-qsyh.onrender.com）即可。',
    };
  }
  if (env.isIOS) {
    return {
      android: false,
      title: 'iPhone / iPad 用不了蓝牙心率',
      detail: 'Apple 至今没有实现 Web Bluetooth 标准，Safari 和 iOS 上的 Chrome / 微信内置浏览器都不支持——这是系统限制，不是本功能没做。',
      hint: '换一台安卓手机用 Chrome 打开本页即可连心率带；或者直接用下面的「导入数据 / 演示模式」。',
    };
  }
  if (android) {
    return {
      android: true,
      title: `你用的「${env.browser}」没有开放蓝牙接口`,
      detail:
        '小米 / 夸克 / UC / QQ 这类国产浏览器虽然内核是 Chromium，但普遍关掉了 navigator.bluetooth，所以页面拿不到蓝牙对象。',
      hint: '点下面的按钮用 Chrome（或 Edge / 三星浏览器）打开本页，第一次连接时系统会询问「附近的设备/位置」权限，必须点允许。',
    };
  }
  return {
    android,
    title: `「${env.browser}」没有提供 Web Bluetooth 接口`,
    detail: '桌面端请用 Chrome 或 Edge（Windows 10 及以上，且电脑要有蓝牙适配器）；Firefox、Safari 桌面版都不支持该接口。',
    hint: '把本页链接复制到 Chrome / Edge 打开即可。',
  };
});

/** 安卓上强制用指定浏览器打开本页（intent: 链接，浏览器不支持时自动回退到普通跳转） */
function openInBrowser(pkg) {
  const url = location.href;
  const scheme = location.protocol.replace(':', '') || 'https';
  // intent 语法：intent://host/path#Intent;scheme=https;package=包名;S.browser_fallback_url=...;end
  location.href = `intent://${location.host}${location.pathname}${location.search}#Intent;scheme=${scheme};package=${pkg};S.browser_fallback_url=${encodeURIComponent(url)};end`;
}

/** 复制当前页链接（方便粘贴到别的浏览器里打开） */
async function copyLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    linkCopied.value = true;
    setTimeout(() => (linkCopied.value = false), 2500);
  } catch {
    // 老浏览器没有 clipboard API：退化成选中文本提示用户手动复制
    ElMessage.info('请长按地址栏复制链接：' + location.href);
  }
}

// ---------------------------------------------------------------- 手动记录心率
/** 用本地时区取「今天」，避免 toISOString 在西八区之类的情况下差一天 */
function localToday() {
  const d = new Date();
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}

const manual = ref({ date: localToday(), avg: 72, max: 96, min: 58, minutes: 5, saveAsRestingHr: true });
const manualSaving = ref(false);

async function saveManual() {
  const { date, avg, max, min, minutes, saveAsRestingHr } = manual.value;
  if (!(avg >= 20 && avg <= 250)) {
    ElMessage.warning('请填写 20~250 之间的平均心率');
    return;
  }
  // 自洽处理：最高不能小于平均，最低不能大于平均（用户随手填反了也不会写进脏数据）
  const hi = Math.max(max || 0, avg);
  const lo = Math.min(min || 999, avg);
  manualSaving.value = true;
  try {
    await api.saveHeartRate({
      deviceName: '手动录入（无蓝牙接口的设备/浏览器）',
      avg,
      max: hi,
      min: lo,
      durationSec: Math.max(60, Math.round(minutes * 60)),
      date,
      saveAsRestingHr,
    });
    ElMessage.success(saveAsRestingHr ? `已保存：平均 ${avg} bpm，并写入 ${date} 的静息心率` : `已保存：平均 ${avg} bpm`);
    await refreshAll();
  } finally {
    manualSaving.value = false;
  }
}

onMounted(async () => {
  /**
   * Web Bluetooth 可用性检测
   * -----------------------------------------------------------------------
   * 三个条件缺一不可：
   *   1. 浏览器实现了 navigator.bluetooth（Chrome / Edge / 部分安卓 WebView）；
   *   2. 必须是安全上下文（https 或 localhost）—— http://192.168.x.x 会直接没有这个对象；
   *   3. 不能是 iOS 的 Safari（Apple 至今未实现 Web Bluetooth）。
   * 检测结果只影响"能不能用第 ① 条路"，②③ 永远可用，所以这里只是提示，不做拦截。
   */
  btReady.value = typeof navigator !== 'undefined' && !!navigator.bluetooth && window.isSecureContext;

  await refreshAll();
});

onBeforeUnmount(() => {
  stopTimer();
  try {
    hrChar?.stopNotifications?.();
    device?.gatt?.connected && device.gatt.disconnect();
  } catch {
    /* 卸载时忽略 */
  }
});
</script>

<style scoped>
/* ---------------- 顶部总览 ---------------- */
.dev-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  background: linear-gradient(135deg, #f0fdf4, #ecfdf5 55%, #ffffff);
  border: 1px solid #d1fae5;
}
.hero-title {
  font-size: 16px;
  font-weight: 800;
  color: #064e3b;
}
.hero-desc {
  font-size: 12.5px;
  color: #047857;
  line-height: 1.7;
  margin-top: 6px;
  max-width: 640px;
}
.hero-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.chip {
  font-size: 11.5px;
  padding: 3px 10px;
  border-radius: 999px;
  background: #fff;
  border: 1px solid #d1fae5;
  color: #047857;
}
.chip.ok {
  border-color: #6ee7b7;
  background: #ecfdf5;
  color: #065f46;
  font-weight: 700;
}
.chip.warn {
  border-color: #fed7aa;
  background: #fff7ed;
  color: #9a3412;
  font-weight: 700;
}
.hero-stats {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}
.hs-item {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 10px 14px;
  min-width: 96px;
}
.hs-label {
  font-size: 11px;
  color: var(--text-3);
}
.hs-value {
  font-size: 19px;
  font-weight: 800;
  color: #0f766e;
  margin-top: 2px;
}
.hs-value.small {
  font-size: 13px;
  color: var(--text-2);
}
.hs-value .unit {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-3);
  margin-left: 2px;
}

/* ---------------- 蓝牙区 ---------------- */
.bt-tip {
  font-size: 12px;
  line-height: 1.7;
  border-radius: 10px;
  padding: 9px 12px;
  margin-bottom: 10px;
}
.bt-tip.warn {
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
}
/* 诊断卡的三段式排版：标题 / 原因 / 可点的补救按钮 */
.bt-tip-title {
  font-size: 12.5px;
  font-weight: 700;
  color: #92400e;
  margin-bottom: 4px;
}
.bt-tip-detail {
  font-size: 11.5px;
  line-height: 1.65;
  color: #78350f;
  margin-top: 3px;
}
.bt-tip-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0 2px;
}
.bt-tip-actions .el-button {
  margin-left: 0;
}
/* 设备侧提示（心率广播）：只有在蓝牙可用时才显示，避免和诊断卡重复 */
.bt-note {
  font-size: 11.5px;
  line-height: 1.65;
  color: #0f766e;
  background: #f0fdfa;
  border: 1px solid #ccfbf1;
  border-radius: 10px;
  padding: 8px 11px;
  margin-top: 10px;
}
.bt-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.bt-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
}
.bt-state .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #cbd5e1;
}
.bt-state .dot.on {
  background: #ef4444;
  box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.15);
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.hr-stage {
  display: flex;
  align-items: center;
  gap: 22px;
  margin: 14px 0 8px;
  padding: 14px 18px;
  border-radius: 14px;
  background: linear-gradient(135deg, #fef2f2, #fff);
  border: 1px solid #fee2e2;
}
.hr-now {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-shrink: 0;
}
.hr-num {
  font-size: 46px;
  font-weight: 800;
  line-height: 1;
  color: #ef4444;
  font-variant-numeric: tabular-nums;
}
.hr-num.live {
  text-shadow: 0 0 18px rgba(239, 68, 68, 0.35);
}
.hr-unit {
  font-size: 12px;
  color: #b91c1c;
}
.hr-stats {
  display: flex;
  gap: 10px;
  flex: 1;
  justify-content: flex-end;
}
.hr-stat {
  text-align: center;
  min-width: 58px;
}
.hr-stat .k {
  font-size: 11px;
  color: var(--text-3);
}
.hr-stat .v {
  font-size: 17px;
  font-weight: 700;
  color: #0f172a;
  margin-top: 2px;
}
.hr-stat .u {
  font-size: 10px;
  color: var(--text-3);
  margin-left: 1px;
}
.hr-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 10px;
}

/* ---------------- 导入区 ---------------- */
.imp-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.imp-actions.bottom {
  margin: 8px 0 0;
}
.imp-hint {
  font-size: 11px;
  color: var(--text-3);
}
.hidden-input {
  display: none;
}
.imp-preview {
  margin-top: 10px;
  border-top: 1px dashed var(--line);
  padding-top: 8px;
}
.imp-preview-title {
  font-size: 11.5px;
  color: var(--text-3);
  margin-bottom: 6px;
}

/* ---------------- 演示模式 ---------------- */
.demo-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.demo-tip {
  font-size: 11.5px;
  color: var(--text-2);
  line-height: 1.7;
  margin-top: 10px;
  background: #f8fafc;
  border-radius: 10px;
  padding: 9px 12px;
}

/* ---------------- 一周汇总 ---------------- */
.week-sum {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-2);
  margin-top: 6px;
}
.week-sum b {
  color: #0f766e;
}

/* ---------------- 同步历史 ---------------- */
.hist-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 300px;
  overflow-y: auto;
}
.hist-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 11px;
  border-radius: 10px;
  background: #fbfdfe;
  border: 1px solid #f1f5f9;
}
.hist-row .el-tag {
  flex-shrink: 0;
}
.hist-body {
  min-width: 0;
}
.hist-sum {
  font-size: 12.5px;
  color: var(--text-1);
  font-weight: 600;
  line-height: 1.5;
}
.hist-meta {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
}
.empty-state {
  text-align: center;
  padding: 26px 0;
  color: var(--text-3);
}
.empty-icon {
  font-size: 30px;
  margin-bottom: 6px;
}
.empty-text {
  font-size: 12.5px;
}

/* ---------------- 手动记录心率 ---------------- */
.manual-box {
  margin-top: 12px;
  padding: 11px 13px;
  border-radius: 12px;
  background: #f8fafc;
  border: 1px dashed #cbd5e1;
}
.manual-title {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text-1);
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.manual-sub {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-3);
}
.manual-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr)) auto;
  gap: 8px;
  align-items: end;
  margin-top: 9px;
}
.mf {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.mf > span {
  font-size: 11px;
  color: var(--text-3);
}
.mf-btn {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

/* ---------------- Apple 健康导入提示 ---------------- */
.apple-tip {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #fff7ed;
  border: 1px solid #fed7aa;
}
.apple-title {
  font-size: 12px;
  font-weight: 700;
  color: #9a3412;
  margin-bottom: 4px;
}
.apple-body {
  font-size: 11.5px;
  line-height: 1.7;
  color: #7c2d12;
}
.apple-body code {
  background: #fff;
  border: 1px solid #fed7aa;
  border-radius: 4px;
  padding: 0 4px;
  font-family: Consolas, monospace;
  word-break: break-all;
}

/* ---------------- 移动端 ---------------- */
@media (max-width: 900px) {
  .dev-hero {
    flex-direction: column;
    align-items: stretch;
  }
  /* 手动记录表单：中等屏两列 */
  .manual-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .mf-btn {
    grid-column: 1 / -1;
    justify-content: space-between;
  }
  /* 顶部三个指标卡：手机上等分一行，等宽避免挤压 */
  .hero-stats {
    width: 100%;
  }
  .hs-item {
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
  }
  .hs-value {
    font-size: 16px;
  }
  /* 实时心率区：大数字和四个统计在窄屏改上下排列 */
  .hr-stage {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 14px;
  }
  .hr-stats {
    width: 100%;
    justify-content: space-between;
  }
  .hr-num {
    font-size: 40px;
  }
  .bt-bar {
    gap: 8px;
  }
  /* 蓝牙区的两个按钮在手机上整行，避免换行后错位 */
  .bt-bar .el-button {
    margin-left: 0;
  }
  .hist-list {
    max-height: none;
  }
}
@media (max-width: 600px) {
  .demo-row {
    flex-direction: column;
    align-items: stretch;
  }
  .demo-row .el-radio-group {
    display: flex;
  }
  .demo-row .el-radio-button {
    flex: 1;
  }
  .demo-row :deep(.el-radio-button__inner) {
    width: 100%;
  }
  .hr-foot {
    flex-direction: column;
    align-items: stretch;
  }
  .week-sum {
    gap: 10px;
  }
}
</style>
