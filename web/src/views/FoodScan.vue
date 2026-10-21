<!--
  AI 拍照识热量（多模态独立板块）
  ===============================================================
  这是继「文本大模型」之后的第二种模态能力：图片 → 结构化营养数据。

  页面结构：
    ① 上传区：点击 / 拖拽 / 手机拍照（capture 属性直调后置摄像头）
    ② 识别结果：食物清单（可改份量、显示数据来源）+ 合计 + AI 建议 + 一键记入饮食
    ③ 识别历史：每次识别的原图与结果都留存，可随时回看、重新记入

  工程要点（讲解可展开）：
    · 前端 canvas 压缩（最长边 1280px）后再上传，避免大图拖慢识别、浪费额度；
    · 识别结果里每一项都标注数据来源：「库内精确」= 用本地食物库值换算，
      「模型估算」= 食物库没收录，用模型给的数值——绝不把两种数据混在一起偷偷用；
    · 库值与模型估算相差超过 3 倍时判定为「误匹配」，弃用库值并标红提示（例如「面汤」不能按「意面」算）；
    · 识别结果全部落库（food_scans 表），支持历史回溯与「稍后再记」。
-->
<template>
  <div v-loading="pageLoading">
    <!-- ==================== 顶部功能区 ==================== -->
    <div class="card hero">
      <div class="hero-left">
        <div class="hero-title">📷 AI 拍照识热量</div>
        <div class="hero-desc">
          上传或拍一张饭菜照片，多模态 AI 自动识别食物种类与份量，并与本地食物营养库匹配后换算热量
        </div>
        <div class="hero-chips">
          <span class="ai-chip" :class="{ off: !cap.visionEnabled }">
            {{ cap.visionEnabled ? `多模态 AI · ${cap.model}` : '未启用视觉模型' }}
          </span>
          <el-tag v-if="cap.visionEnabled" size="small" effect="plain" type="success">已识别 {{ history.length }} 次</el-tag>
          <el-tag v-else size="small" effect="plain" type="warning">
            在 server/.env 配置 AI_VISION_MODEL 后即可使用
          </el-tag>
        </div>
      </div>

      <div class="hero-stats">
        <div class="hs-item">
          <div class="hs-label">今日目标</div>
          <div class="hs-value">{{ cap.todayTarget }} <span>kcal</span></div>
        </div>
        <div class="hs-item">
          <div class="hs-label">已摄入</div>
          <div class="hs-value">{{ cap.todayIntake }} <span>kcal</span></div>
        </div>
        <div class="hs-item highlight">
          <div class="hs-label">剩余可摄入</div>
          <div class="hs-value">{{ cap.todayRemaining }} <span>kcal</span></div>
        </div>
      </div>
    </div>

    <div class="grid mt-16" style="grid-template-columns: 1fr 1.25fr">
      <!-- ==================== ① 上传区 ==================== -->
      <div class="card">
        <div class="card-title">
          <span>① 上传食物照片</span>
          <span class="sub">jpg / png / webp · 自动压缩</span>
        </div>

        <!-- 未选择图片：拖拽/点击上传 -->
        <div
          v-if="!preview"
          class="drop-zone"
          :class="{ dragging }"
          @click="pickFile()"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="onDrop"
        >
          <div class="drop-icon">🍱</div>
          <div class="drop-title">点击选择照片，或把图片拖到这里</div>
          <div class="drop-desc">手机端可直接调用相机拍照</div>
          <div class="drop-actions">
            <el-button type="primary" class="btn-gradient" :icon="Camera" @click.stop="pickFile('camera')">拍照</el-button>
            <el-button :icon="Picture" @click.stop="pickFile('gallery')">从相册选择</el-button>
          </div>
          <div class="drop-tips">
            💡 拍摄建议：光线充足、俯拍整盘、让餐具或手入镜作为参照物，识别份量会更准
          </div>
        </div>

        <!-- 已选择图片：预览 -->
        <div v-else class="preview-area">
          <img :src="preview" class="preview-img" alt="待识别的食物照片" />
          <div class="preview-meta">
            <span>{{ imageSize }} KB · {{ imageWH }}</span>
            <div class="row">
              <el-button size="small" :icon="Refresh" :disabled="analyzing" @click="analyze">重新识别</el-button>
              <el-button size="small" :icon="Close" :disabled="analyzing" @click="reset">换一张</el-button>
            </div>
          </div>

          <!-- 识别中的步骤提示：让用户知道 AI 在做什么，而不是干等 -->
          <div v-if="analyzing" class="analyzing">
            <el-icon class="is-loading" :size="18"><Loading /></el-icon>
            <span>{{ analyzingStep }}</span>
          </div>
        </div>

        <!-- 隐藏的文件输入：capture=camera 让手机直接调起相机 -->
        <input ref="fileInput" type="file" accept="image/*" class="hidden-input" @change="onFileChange" />

        <!-- 识别流程说明：既是排版补充，也是这一功能的技术注解 -->
        <div class="scan-explain">
          <div class="se-title">🔬 识别是怎么做的</div>
          <ol class="se-list">
            <li><b>视觉识别</b>：多模态模型（{{ cap.model || '视觉模型' }}）识别食物种类、按参照物估算克数</li>
            <li><b>库内匹配</b>：与该食物名称做「名称包含 + 词法相关性 + 二元组重叠」三重校验</li>
            <li><b>以库为准</b>：命中则用食物库每 100g 的数值重算热量；未命中才采用模型估算并明确标注</li>
            <li><b>冲突拦截</b>：库值与估算相差 3 倍以上判为误匹配，弃用库值（例如「面汤」不能按「意面」算）</li>
          </ol>
        </div>
      </div>

      <!-- ==================== ② 识别结果 ==================== -->
      <div class="card">
        <div class="card-title">
          <span>② 识别结果</span>
          <span v-if="result?.meta" class="sub">
            {{ result.meta.model }} · {{ (result.meta.latencyMs / 1000).toFixed(1) }}s · 库匹配 {{ result.meta.libraryRatio }}%
          </span>
        </div>

        <!-- 空状态 -->
        <div v-if="!result && !analyzing" class="empty-state">
          <div class="empty-icon">🔍</div>
          <div class="empty-title">还没有识别结果</div>
          <div class="empty-desc">上传一张照片，AI 会告诉你这一餐大概多少热量</div>
        </div>

        <!-- 非食物提示 -->
        <el-result
          v-else-if="result?.notFood"
          icon="warning"
          title="没有识别到食物"
          :sub-title="result.reason || '请换一张包含饭菜的照片'"
        >
          <template #extra>
            <el-button @click="reset">换一张试试</el-button>
          </template>
        </el-result>

        <template v-else-if="result">
          <!-- 场景描述 -->
          <el-alert v-if="result.scene" :title="result.scene" type="success" :closable="false" show-icon class="mb-8" />

          <!-- 食物清单 -->
          <div class="fs-items">
            <div v-for="(it, idx) in result.items" :key="idx" class="fs-item" :class="{ conflict: it.conflict }">
              <div class="fs-main">
                <div class="fs-name">
                  {{ it.name }}
                  <el-tag size="small" :type="it.source === 'library' ? 'success' : 'warning'" effect="plain">
                    {{ it.source === 'library' ? '库内精确' : '模型估算' }}
                  </el-tag>
                  <el-tag v-if="it.conflict" size="small" type="danger" effect="plain">数值冲突已忽略库值</el-tag>
                </div>
                <div class="fs-sub">
                  <template v-if="it.libraryName">已匹配食物库：{{ it.libraryName }}</template>
                  <template v-else-if="it.libraryCandidate">候选「{{ it.libraryCandidate }}」与估算相差过大，未采用</template>
                  <template v-else>食物库未收录，采用 AI 估算值</template>
                  <span class="dot">·</span>
                  <span :class="`conf-${it.confidence}`">置信度 {{ confText(it.confidence) }}</span>
                </div>
              </div>

              <div class="fs-amount">
                <el-input-number
                  v-model="it.amountG"
                  :min="5"
                  :max="2000"
                  :step="10"
                  size="small"
                  controls-position="right"
                  style="width: 96px"
                  @change="(v) => onAmountChange(it, v)"
                />
                <span class="unit">g</span>
              </div>

              <div class="fs-kcal">
                <b>{{ Math.round(it.kcal) }}</b> kcal
                <div class="fs-macro">蛋{{ Math.round(it.protein) }} 脂{{ Math.round(it.fat) }} 碳{{ Math.round(it.carb) }}</div>
              </div>
            </div>
          </div>

          <!-- 合计 + 建议 -->
          <div class="totals">
            <div class="total-main">
              <span class="total-label">这一餐约</span>
              <span class="total-value">{{ totalKcal }}</span>
              <span class="total-unit">kcal</span>
            </div>
            <div class="total-macros">
              <span>蛋白 {{ totalProtein }}g</span>
              <span>脂肪 {{ totalFat }}g</span>
              <span>碳水 {{ totalCarb }}g</span>
            </div>
            <div class="total-compare" :class="compareClass">
              {{ compareText }}
            </div>
          </div>

          <el-alert v-if="result.advice" :title="result.advice" type="warning" :closable="false" show-icon class="mt-16" />

          <!-- 记入饮食 -->
          <div class="log-bar">
            <span class="log-label">记入</span>
            <el-select v-model="mealType" size="default" style="width: 120px">
              <el-option label="早餐" value="breakfast" />
              <el-option label="午餐" value="lunch" />
              <el-option label="晚餐" value="dinner" />
              <el-option label="加餐" value="snack" />
            </el-select>
            <el-button type="success" class="btn-gradient" :icon="Check" :loading="logging" @click="logToDiet">
              加入{{ mealNameMap[mealType] }}
            </el-button>
            <span class="log-tip">会按当前份量写入今日饮食记录</span>
          </div>
        </template>
      </div>
    </div>

    <!-- ==================== ③ 识别历史 ==================== -->
    <div class="card mt-16">
      <div class="card-title">
        <span>③ 识别历史</span>
        <span class="sub">共 {{ history.length }} 条 · 点击可回看并记入饮食</span>
      </div>

      <div v-if="history.length" class="hist-grid">
        <div v-for="h in history" :key="h.id" class="hist-card" @click="loadScan(h)">
          <img :src="h.imageUrl" class="hist-img" alt="历史照片" />
          <div class="hist-body">
            <div class="hist-kcal"><b>{{ Math.round(h.totalKcal) }}</b> kcal</div>
            <div class="hist-meta">{{ h.items.length }} 种食物 · {{ h.createdAt.slice(5, 16) }}</div>
            <el-tag v-if="h.loggedMeal" size="small" type="success" effect="plain">已记入{{ mealNameMap[h.loggedMeal] }}</el-tag>
            <el-tag v-else size="small" type="info" effect="plain">未记入</el-tag>
          </div>
          <el-button class="hist-del" link type="danger" :icon="Delete" @click.stop="removeScan(h.id)" />
        </div>
      </div>
      <el-empty v-else description="还没有识别记录" :image-size="70" />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Camera, Picture, Refresh, Close, Check, Delete, Loading } from '@element-plus/icons-vue';
import { api } from '@/api';
import { compressImage, dataUrlSize } from '@/utils/image';

const mealNameMap = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };

const pageLoading = ref(false);
const analyzing = ref(false);
const logging = ref(false);
const analyzingStep = ref('AI 正在识别…');
const dragging = ref(false);

const cap = ref({ visionEnabled: false, model: '', todayTarget: 0, todayIntake: 0, todayRemaining: 0 });
const preview = ref('');          // 压缩后的 dataURL（用于预览与提交）
const imageSize = ref(0);
const imageWH = ref('');
const result = ref(null);         // 识别结果（含 scanId）
const history = ref([]);          // 历史记录
const mealType = ref('lunch');

const fileInput = ref(null);
let cameraMode = false;           // 是否以「调起相机」模式打开文件选择

// ---------------- 计算结果：按当前份量实时合计 ----------------
const totalKcal = computed(() => Math.round((result.value?.items || []).reduce((s, i) => s + (Number(i.kcal) || 0), 0)));
const totalProtein = computed(() => Number((result.value?.items || []).reduce((s, i) => s + (Number(i.protein) || 0), 0).toFixed(1)));
const totalFat = computed(() => Number((result.value?.items || []).reduce((s, i) => s + (Number(i.fat) || 0), 0).toFixed(1)));
const totalCarb = computed(() => Number((result.value?.items || []).reduce((s, i) => s + (Number(i.carb) || 0), 0).toFixed(1)));

/** 与今日剩余额度的对比文案（超标时变红） */
const compareText = computed(() => {
  const remain = cap.value.todayRemaining;
  if (!remain) return '';
  const diff = remain - totalKcal.value;
  if (diff >= 0) return `吃完这一餐，今天还剩 ${diff} kcal`;
  return `⚠️ 这一餐会超出今日额度 ${Math.abs(diff)} kcal`;
});
const compareClass = computed(() => ({
  warn: cap.value.todayRemaining > 0 && totalKcal.value > cap.value.todayRemaining,
}));

function confText(c) {
  return { high: '高', medium: '中', low: '低' }[c] || '中';
}

// ---------------- 上传与识别 ----------------
/** 打开文件选择：camera=true 时手机端直接调起相机 */
function pickFile(mode) {
  if (!cap.value.visionEnabled) {
    ElMessage.warning('未启用视觉模型（AI_VISION_MODEL），无法识别照片');
    return;
  }
  cameraMode = mode === 'camera';
  if (fileInput.value) {
    // capture 属性只能在渲染前决定，这里运行时切换
    if (cameraMode) fileInput.value.setAttribute('capture', 'environment');
    else fileInput.value.removeAttribute('capture');
    fileInput.value.value = '';       // 允许重复选择同一张图
    fileInput.value.click();
  }
}

function onDrop(ev) {
  dragging.value = false;
  const file = ev.dataTransfer?.files?.[0];
  if (file) handleFile(file);
}

function onFileChange(ev) {
  const file = ev.target.files?.[0];
  if (file) handleFile(file);
}

/** 选中文件 → 压缩 → 自动识别 */
async function handleFile(file) {
  if (!file.type.startsWith('image/')) {
    ElMessage.warning('请选择图片文件');
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    ElMessage.warning('图片请小于 8MB');
    return;
  }
  try {
    pageLoading.value = true;
    const dataUrl = await compressImage(file, { maxEdge: 1280, quality: 0.85 });
    preview.value = dataUrl;
    imageSize.value = dataUrlSize(dataUrl);
    // 记录压缩后的分辨率，便于用户判断清晰度是否足够
    const img = new Image();
    img.src = dataUrl;
    await new Promise((r) => {
      img.onload = r;
      img.onerror = r;
    });
    imageWH.value = `${img.width}×${img.height}`;
    pageLoading.value = false;
    await analyze();
  } catch (err) {
    ElMessage.error(err.message || '图片处理失败');
  } finally {
    pageLoading.value = false;
  }
}

/** 调用多模态识别接口 */
async function analyze() {
  if (!preview.value) return;
  analyzing.value = true;
  result.value = null;
  analyzingStep.value = '正在上传照片…';
  const t = setTimeout(() => {
    analyzingStep.value = 'AI 正在识别食物种类与份量…';
  }, 600);
  try {
    const res = await api.foodScanAnalyze(preview.value);
    result.value = res;
    if (res.notFood) {
      ElMessage.warning(res.reason || '没有识别到食物');
    } else {
      ElMessage.success(`识别完成：${res.items.length} 种食物，约 ${res.totals.kcal} kcal`);
    }
    await loadHistory();      // 识别成功会落库，刷新历史
  } catch {
    /* 错误提示由 axios 拦截器统一处理 */
  } finally {
    clearTimeout(t);
    analyzing.value = false;
  }
}

function reset() {
  preview.value = '';
  result.value = null;
  imageSize.value = 0;
  imageWH.value = '';
  analyzing.value = false;
}

/**
 * 修改份量：按「每克热量」等比缩放（库内精确与模型估算都适用）
 * 这样用户把「米饭 200g」改成「150g」时，热量与三大营养素会同步刷新。
 */
function onAmountChange(item, newAmount) {
  const amount = Number(newAmount) || 0;
  const oldAmount = Number(item._lastAmount || item.amountG) || 0;
  if (!amount || !oldAmount) {
    item._lastAmount = amount;
    return;
  }
  const ratio = amount / oldAmount;
  item.kcal = Math.round(item.kcal * ratio);
  item.protein = Number((item.protein * ratio).toFixed(1));
  item.fat = Number((item.fat * ratio).toFixed(1));
  item.carb = Number((item.carb * ratio).toFixed(1));
  item.amountG = amount;
  item._lastAmount = amount;
}

// ---------------- 记入饮食 ----------------
async function logToDiet() {
  if (!result.value?.scanId) {
    ElMessage.warning('这条识别记录不可用，请重新识别');
    return;
  }
  const items = (result.value.items || []).map((i) => ({
    name: i.name,
    amountG: i.amountG,
    foodId: i.foodId || null,
    kcal: i.kcal,
    protein: i.protein,
    fat: i.fat,
    carb: i.carb,
  }));
  if (!items.length) {
    ElMessage.warning('没有可记录的食物');
    return;
  }
  logging.value = true;
  try {
    const res = await api.foodScanLog(result.value.scanId, { mealType: mealType.value, items });
    ElMessage.success(res.message || `已记入${mealNameMap[mealType.value]}`);
    await Promise.all([loadHistory(), loadCapability()]);
    result.value = null;
    preview.value = '';
  } finally {
    logging.value = false;
  }
}

// ---------------- 历史记录 ----------------
async function loadHistory() {
  history.value = await api.foodScanHistory(20);
}

/** 点历史卡片：把历史结果载回右侧面板（可改份量后记入） */
async function loadScan(h) {
  try {
    const detail = await api.foodScanDetail(h.id);
    result.value = {
      notFood: false,
      scene: '',
      items: (detail.items || []).map((i) => ({ ...i, _lastAmount: i.amountG })),
      totals: detail.totals,
      advice: detail.advice,
      scanId: detail.id,
      meta: null,
    };
    preview.value = h.imageUrl;   // 预览用原图地址
    imageSize.value = 0;
    imageWH.value = '历史记录';
    ElMessage.info('已载入历史结果，可改份量后记入饮食');
  } catch {
    ElMessage.error('载入失败');
  }
}

async function removeScan(id) {
  try {
    await ElMessageBox.confirm('删除这条识别记录？原图也会从列表中移除。', '提示', { type: 'warning' });
  } catch {
    return;
  }
  await api.foodScanDelete(id);
  ElMessage.success('已删除');
  await loadHistory();
}

// ---------------- 初始化 ----------------
async function loadCapability() {
  cap.value = await api.foodScanCapability();
}

onMounted(async () => {
  pageLoading.value = true;
  try {
    await Promise.all([loadCapability(), loadHistory()]);
  } finally {
    pageLoading.value = false;
  }
});
</script>

<style scoped>
/* ---------------- 顶部功能区 ---------------- */
.hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  background: linear-gradient(120deg, #ecfdf5 0%, #f0fdfa 55%, #ffffff 100%);
  border: 1px solid #d1fae5;
}
.hero-title {
  font-size: 20px;
  font-weight: 800;
  margin-bottom: 6px;
}
.hero-desc {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.6;
  max-width: 560px;
}
.hero-chips {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.hero-stats {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}
.hs-item {
  padding: 10px 16px;
  border-radius: 12px;
  background: #fff;
  border: 1px solid var(--line);
  text-align: center;
  min-width: 96px;
}
.hs-item.highlight {
  background: linear-gradient(135deg, #ecfdf5, #f0fdf4);
  border-color: #a7f3d0;
}
.hs-label {
  font-size: 11.5px;
  color: var(--text-3);
  margin-bottom: 4px;
}
.hs-value {
  font-size: 19px;
  font-weight: 800;
  color: var(--text-1);
}
.hs-value span {
  font-size: 10px;
  color: var(--text-3);
  font-weight: 500;
}

/* ---------------- 上传区 ---------------- */
.hidden-input {
  display: none;
}
.drop-zone {
  border: 2px dashed #cbd5e1;
  border-radius: 14px;
  padding: 28px 20px;
  text-align: center;
  cursor: pointer;
  transition: all 0.22s ease;
  background: #fcfdfe;
}
.drop-zone:hover,
.drop-zone.dragging {
  border-color: var(--brand);
  background: #f0fdf4;
  transform: translateY(-1px);
}
.drop-icon {
  font-size: 40px;
  margin-bottom: 10px;
}
.drop-title {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 4px;
}
.drop-desc {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 16px;
}
.drop-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
  margin-bottom: 14px;
}
.drop-tips {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.6;
  padding-top: 12px;
  border-top: 1px dashed #e2e8f0;
}

.preview-area {
  display: flex;
  flex-direction: column;
  gap: 10px;
}.preview-img {
  width: 100%;
  max-height: 330px;
  object-fit: contain;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: #f8fafc;
}
.preview-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-3);
  flex-wrap: wrap;
  gap: 8px;
}
.analyzing {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  color: #1e40af;
  font-size: 12.5px;
}

/* ---------------- 识别流程说明 ---------------- */
.scan-explain {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 12px;
  background: #f8fafc;
  border: 1px dashed #cbd5e1;
}
.se-title {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text-2);
  margin-bottom: 8px;
}
.se-list {
  margin: 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.se-list li {
  font-size: 11.5px;
  color: var(--text-2);
  line-height: 1.6;
}
.se-list b {
  color: var(--brand-dark);
}

/* ---------------- 空状态 ---------------- */
.empty-state {
  padding: 46px 20px;
  text-align: center;
}
.empty-icon {
  font-size: 40px;
  margin-bottom: 10px;
}
.empty-title {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 6px;
}
.empty-desc {
  font-size: 12.5px;
  color: var(--text-3);
}

/* ---------------- 食物清单 ---------------- */
.fs-items {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 12px 0;
}
.fs-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  background: #fbfdfe;
  border: 1px solid #f1f5f9;
}
.fs-item.conflict {
  background: #fff7ed;
  border-color: #fed7aa;
}
.fs-main {
  flex: 1;
  min-width: 0;
}
.fs-name {
  font-size: 13.5px;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.fs-sub {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 3px;
  line-height: 1.5;
}
.fs-sub .dot {
  margin: 0 4px;
}
.conf-high {
  color: #047857;
}
.conf-medium {
  color: #b45309;
}
.conf-low {
  color: #b91c1c;
}
.fs-amount {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.fs-amount .unit {
  font-size: 12px;
  color: var(--text-3);
}
.fs-kcal {
  text-align: right;
  font-size: 12.5px;
  color: var(--text-2);
  min-width: 86px;
  flex-shrink: 0;
}
.fs-kcal b {
  font-size: 16px;
  color: var(--brand-dark);
}
.fs-macro {
  font-size: 10.5px;
  color: var(--text-3);
  margin-top: 2px;
}

/* ---------------- 合计 ---------------- */
.totals {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 16px;
  border-radius: 12px;
  background: linear-gradient(135deg, #0f172a, #134e4a);
  color: #fff;
  flex-wrap: wrap;
}
.total-main {
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.total-label {
  font-size: 12px;
  color: #a7f3d0;
}
.total-value {
  font-size: 28px;
  font-weight: 800;
  letter-spacing: -0.5px;
}
.total-unit {
  font-size: 12px;
  color: #a7f3d0;
}
.total-macros {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: #cbd5e1;
}
.total-compare {
  margin-left: auto;
  font-size: 12px;
  color: #6ee7b7;
}
.total-compare.warn {
  color: #fca5a5;
  font-weight: 700;
}

/* ---------------- 记入饮食 ---------------- */
.log-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
  flex-wrap: wrap;
}
.log-label {
  font-size: 13px;
  color: var(--text-2);
  font-weight: 600;
}
.log-tip {
  font-size: 11.5px;
  color: var(--text-3);
}

/* ---------------- 历史记录 ---------------- */
.hist-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}
.hist-card {
  position: relative;
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.2s ease;
  background: #fff;
}
.hist-card:hover {
  border-color: #a7f3d0;
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
}
.hist-img {
  width: 100%;
  height: 92px;
  object-fit: cover;
  display: block;
  background: #f1f5f9;
}
.hist-body {
  padding: 8px 10px 10px;
}
.hist-kcal {
  font-size: 12px;
  color: var(--text-2);
}
.hist-kcal b {
  font-size: 16px;
  color: var(--brand-dark);
}
.hist-meta {
  font-size: 10.5px;
  color: var(--text-3);
  margin: 3px 0 6px;
}
.hist-del {
  position: absolute;
  top: 4px;
  right: 4px;
  background: rgba(255, 255, 255, 0.9);
  border-radius: 8px;
}

/* ---------------- 移动端 ---------------- */
@media (max-width: 900px) {
  .hero {
    flex-direction: column;
    align-items: stretch;
  }
  .hero-stats {
    justify-content: space-between;
  }
  .hs-item {
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
  }
  .hs-value {
    font-size: 16px;
  }
  .fs-item {
    flex-wrap: wrap;
    gap: 8px;
  }
  .fs-kcal {
    min-width: 70px;
  }
  .totals {
    gap: 8px;
  }
  .total-compare {
    margin-left: 0;
    width: 100%;
  }
  .hist-grid {
    grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
  }
  .hist-img {
    height: 78px;
  }
}
</style>
