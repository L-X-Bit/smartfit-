<!--
  健康饮食页
  ===============================================================
  功能：
    ① 今日热量进度：目标 / 已摄入 / 剩余 + 三大营养素供能比环形图
    ② 四餐记录卡片：早/午/晚/加餐，支持搜索食物库、按克数添加
    ③ AI 一日配餐：调用后端饮食 Agent 生成方案（含热量对齐偏差校验），支持「一键采纳」
    ④ 食物营养库浏览（每 100g 营养数据）
  讲解要点：所有营养数值都以「每 100g 基准 × 克数 / 100」在**后端**换算，
           保证 AI 餐单、手动记录、统计图表的数字完全一致。
-->
<template>
  <div v-loading="loading">
    <!-- ==================== 顶部：热量进度 ==================== -->
    <div class="grid" style="grid-template-columns: 1fr 1.15fr">
      <div class="card">
        <div class="card-title">
          <span>今日热量</span>
          <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" size="small" style="width: 130px" @change="loadSummary" />
        </div>

        <div class="calorie-main">
          <div class="calorie-ring">
            <el-progress
              type="dashboard"
              :percentage="intakePercent"
              :width="150"
              :stroke-width="12"
              :color="intakePercent > 100 ? '#f59e0b' : '#10b981'"
            >
              <template #default="{ percentage }">
                <div class="ring-value">{{ summary.totals?.kcal || 0 }}</div>
                <div class="ring-label">已摄入 kcal</div>
                <div class="ring-target">目标 {{ summary.target?.kcal || 0 }}</div>
              </template>
            </el-progress>
          </div>

          <div class="calorie-detail">
            <div class="detail-row">
              <span>剩余可摄入</span>
              <b :class="remaining > 0 ? 'text-brand' : 'text-danger'">{{ remaining }} kcal</b>
            </div>
            <div class="detail-row">
              <span>蛋白质</span>
              <b>{{ summary.totals?.protein || 0 }} / {{ summary.target?.protein || 0 }} g</b>
            </div>
            <div class="detail-row">
              <span>碳水</span>
              <b>{{ summary.totals?.carb || 0 }} / {{ summary.target?.carb || 0 }} g</b>
            </div>
            <div class="detail-row">
              <span>脂肪</span>
              <b>{{ summary.totals?.fat || 0 }} / {{ summary.target?.fat || 0 }} g</b>
            </div>
            <div class="detail-row">
              <span>目标</span>
              <b>{{ summary.profile?.goalText || '-' }}</b>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>三大营养素供能比</span>
          <span class="sub">推荐：蛋白 20~35% · 碳水 40~55% · 脂肪 20~30%</span>
        </div>
        <ChartBox :option="macroOption" height="220px" :empty="!(summary.totals?.kcal > 0)" />
      </div>
    </div>

    <!-- ==================== 三餐记录 ==================== -->
    <div class="grid grid-2 mt-16">
      <div v-for="meal in summary.meals || []" :key="meal.mealType" class="card meal-card">
        <div class="meal-head">
          <div class="row">
            <span class="meal-icon">{{ mealIcon(meal.mealType) }}</span>
            <div>
              <div class="meal-name">{{ meal.mealName }}</div>
              <div class="text-muted">{{ meal.kcal }} kcal · 蛋白 {{ meal.protein }}g</div>
            </div>
          </div>
          <el-button size="small" :icon="Plus" @click="openAdd(meal.mealType)">添加</el-button>
        </div>

        <div v-if="meal.items.length" class="meal-items">
          <div v-for="item in meal.items" :key="item.id" class="food-row">
            <span class="food-name">{{ item.food_name }}</span>
            <span class="food-amount">{{ item.amount_g }}g</span>
            <span class="food-kcal">{{ item.kcal }} kcal</span>
            <el-button link type="danger" :icon="Close" size="small" @click="removeItem(item.id)" />
          </div>
        </div>
        <div v-else class="meal-empty">还没有记录，点击「添加」或使用下方的 AI 配餐</div>
      </div>
    </div>

    <!-- ==================== 📷 拍照识别食物热量（多模态） ==================== -->
    <div class="card mt-16">
      <div class="card-title">
        <span>📷 拍照识别食物热量</span>
        <div class="row">
          <!-- 站内还有「AI 拍照识热量」独立页（带识别历史/置信度/非食物检测），这里给出跳转入口 -->
          <el-button link type="primary" size="small" @click="$router.push('/food-scan')">
            完整版（含识别历史）→
          </el-button>
          <span class="ai-chip" :class="{ off: !visionEnabled }">
            {{ visionEnabled ? '多模态 AI · 视觉识别' : '未配置视觉模型' }}
          </span>
        </div>
      </div>

      <!-- 未选择图片：上传区 -->
      <div v-if="!visionPreview" class="vision-drop" @click="pickImage">
        <div class="vision-drop-inner">
          <div class="vision-icon">📸</div>
          <div class="vision-title">拍一张食物照片，自动算出热量</div>
          <div class="vision-desc">
            支持拍照或选择相册图片，AI 会识别食物种类、估算份量，并与食物库匹配后自动换算热量
          </div>
          <div class="vision-actions">
            <el-button type="primary" class="btn-gradient" :icon="Camera" @click.stop="pickImage('camera')">拍照</el-button>
            <el-button :icon="Picture" @click.stop="pickImage('album')">从相册选择</el-button>
          </div>
          <div v-if="!visionEnabled" class="vision-warn">
            ⚠️ 当前未配置视觉模型：在 <code>server/.env</code> 设置 <code>AI_VISION_MODEL</code> 后重启后端即可使用
          </div>
        </div>
      </div>

      <!-- 已选择图片：预览 + 识别结果 -->
      <div v-else class="vision-body">
        <div class="vision-left">
          <img :src="visionPreview" class="vision-img" alt="食物照片" />
          <div class="vision-img-meta">{{ visionImageSize }} KB · {{ visionLoading ? '识别中…' : '已识别' }}</div>
          <div class="row" style="gap: 8px; margin-top: 8px">
            <el-button size="small" :icon="Refresh" :disabled="visionLoading" @click="runVision">重新识别</el-button>
            <el-button size="small" :icon="Close" :disabled="visionLoading" @click="resetVision">换一张</el-button>
          </div>
        </div>

        <div class="vision-right">
          <!-- 识别中 -->
          <div v-if="visionLoading" class="vision-loading">
            <el-icon class="is-loading" :size="22"><Loading /></el-icon>
            <div>
              <div class="vision-loading-title">AI 正在识别食物…</div>
              <div class="text-muted">通常需要 2~5 秒，请稍候</div>
            </div>
          </div>

          <template v-else-if="visionResult">
            <el-alert
              v-if="visionResult.advice"
              :title="visionResult.advice"
              type="success"
              :closable="false"
              show-icon
              class="mb-8"
            />

            <div v-if="visionResult.items.length" class="vision-items">
              <div v-for="(it, idx) in visionResult.items" :key="idx" class="vision-item">
                <div class="vi-name">
                  <span class="vi-model-name">{{ it.name }}</span>
                  <el-tag v-if="it.matchedFoodId" size="small" type="success" effect="plain">已匹配食物库</el-tag>
                  <el-tag v-else size="small" type="warning" effect="plain">未匹配，请手动选择</el-tag>
                </div>
                <div class="vi-controls">
                  <el-select
                    :model-value="it.matchedFoodId"
                    filterable
                    placeholder="选择食物库条目"
                    size="small"
                    class="vi-select"
                    @change="(v) => changeVisionFood(idx, v)"
                  >
                    <el-option v-for="c in it.candidates" :key="c.id" :label="`${c.name}（${c.kcal}kcal/100g）`" :value="c.id" />
                    <el-option v-for="f in foods" :key="'all-' + f.id" :label="`${f.name}（${f.kcal}kcal/100g）`" :value="f.id" />
                  </el-select>
                  <el-input-number
                    :model-value="it.amountG"
                    :min="10"
                    :max="800"
                    :step="10"
                    size="small"
                    controls-position="right"
                    class="vi-amount"
                    @change="(v) => changeVisionAmount(idx, v)"
                  />
                  <span class="vi-kcal">{{ it.kcal }} kcal</span>
                  <span class="vi-macro">蛋白 {{ it.protein }}g · 脂肪 {{ it.fat }}g</span>
                </div>
              </div>
            </div>

            <el-empty v-else description="没有识别到食物，换一张更清晰的照片试试" :image-size="50" />

            <div v-if="visionResult.items.length" class="vision-footer">
              <div class="row">
                <span class="vision-total">合计 <b>{{ visionTotalKcal }}</b> kcal</span>
                <span class="text-muted">（按匹配后的食物库数据计算）</span>
              </div>
              <div class="row">
                <el-select v-model="visionMeal" size="small" style="width: 110px">
                  <el-option label="早餐" value="breakfast" />
                  <el-option label="午餐" value="lunch" />
                  <el-option label="晚餐" value="dinner" />
                  <el-option label="加餐" value="snack" />
                </el-select>
                <el-button type="success" class="btn-gradient" size="small" :loading="visionAdding" :icon="Check" @click="adoptVision">
                  加入{{ mealNameMap[visionMeal] }}
                </el-button>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- 隐藏的文件输入：capture=environment 让手机直接调用后置摄像头 -->
      <input ref="cameraInput" type="file" accept="image/*" capture="environment" style="display: none" @change="onFileChange" />
      <input ref="albumInput" type="file" accept="image/*" style="display: none" @change="onFileChange" />
    </div>

    <!-- ==================== AI 配餐 ==================== -->
    <div class="card mt-16">
      <div class="card-title">
        <span>AI 一日配餐推荐</span>
        <div class="row">
          <span class="ai-chip">{{ store.aiStatus?.enabled ? '大模型 + 食物库约束' : '本地贪心配餐引擎' }}</span>
          <el-button type="primary" class="btn-gradient" size="small" :loading="recommending" :icon="MagicStick" @click="recommend">
            生成配餐
          </el-button>
        </div>
      </div>

      <div v-if="diet" class="diet-result">
        <el-alert :title="diet.summary" type="success" :closable="false" show-icon />

        <div class="diet-meta">
          <el-tag type="success" effect="plain">合计 {{ diet.totalKcal }} kcal</el-tag>
          <el-tag :type="proteinOk ? 'primary' : 'warning'" effect="plain">蛋白 {{ diet.totalProtein }}g / 目标 {{ diet.targetProtein }}g</el-tag>
          <el-tag type="warning" effect="plain">脂肪 {{ diet.totalFat }}g</el-tag>
          <el-tag type="info" effect="plain">碳水 {{ diet.totalCarb }}g</el-tag>
          <el-tag :type="diet.inRange ? 'success' : 'danger'" effect="dark">
            与目标偏差 {{ diet.kcalDeviation }}%{{ diet.inRange ? '（达标）' : '（超出 ±8%）' }}
          </el-tag>
          <el-tag v-if="diet.autoScaled" type="info" effect="plain" title="模型给出的份量偏离目标较大，已按食物库自动校正">
            🔧 份量已自动校正
          </el-tag>
          <el-tag v-if="diet.cacheHit" type="info" effect="plain">⚡ 缓存复用</el-tag>
        </div>

        <div class="diet-meals">
          <div v-for="m in diet.meals" :key="m.mealType" class="diet-meal">
            <div class="diet-meal-name">{{ m.mealName }}</div>
            <div v-for="(it, idx) in m.items" :key="idx" class="food-row">
              <span class="food-name">{{ it.foodName }}</span>
              <span class="food-amount">{{ it.amountG }}g</span>
              <span class="food-kcal">{{ it.kcal }} kcal</span>
            </div>
          </div>
        </div>

        <div v-if="diet.tips?.length" class="diet-tips">
          <div v-for="(t, i) in diet.tips" :key="i">💡 {{ t }}</div>
        </div>

        <el-button type="success" class="btn-gradient mt-16" :icon="Check" @click="adoptDiet">一键采纳到今日饮食</el-button>
      </div>

      <el-empty v-else description="点击「生成配餐」，AI 会按你的目标热量生成一日三餐方案" :image-size="70" />
    </div>

    <!-- ==================== 食物库 ==================== -->
    <div class="card mt-16">
      <div class="card-title">
        <span>食物营养库</span>
        <el-input v-model="foodKw" placeholder="搜索食物，如 鸡胸 / 燕麦" size="small" style="width: 220px" clearable @input="searchFoods" />
      </div>
      <el-table :data="foods" size="small" max-height="320" stripe>
        <el-table-column prop="name" label="食物" min-width="130" />
        <el-table-column prop="category" label="分类" width="80" />
        <el-table-column prop="kcal" label="热量/100g" width="110">
          <template #default="{ row }">{{ row.kcal }} kcal</template>
        </el-table-column>
        <el-table-column prop="protein" label="蛋白(g)" width="90" />
        <el-table-column prop="fat" label="脂肪(g)" width="90" />
        <el-table-column prop="carb" label="碳水(g)" width="90" />
        <el-table-column prop="portion" label="常见份量" min-width="120" />
      </el-table>
    </div>

    <!-- ==================== 添加食物弹窗 ==================== -->
    <el-dialog v-model="addVisible" :title="`添加食物到${mealNameMap[addMeal]}`" width="520px">
      <el-form label-position="top">
        <el-form-item label="选择食物">
          <el-select v-model="addForm.foodId" filterable placeholder="搜索食物" style="width: 100%">
            <el-option v-for="f in foods" :key="f.id" :label="`${f.name}（${f.kcal} kcal/100g）`" :value="f.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="份量（克）">
          <el-input-number v-model="addForm.amountG" :min="1" :max="2000" :step="10" style="width: 100%" />
        </el-form-item>
        <el-alert
          v-if="pickedFood"
          :title="`预计 ${Math.round((pickedFood.kcal * addForm.amountG) / 100)} kcal · 蛋白 ${((pickedFood.protein * addForm.amountG) / 100).toFixed(1)}g`"
          type="info"
          :closable="false"
        />
      </el-form>
      <template #footer>
        <el-button @click="addVisible = false">取消</el-button>
        <el-button type="primary" class="btn-gradient" :loading="adding" @click="confirmAdd">添加</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Plus, Close, MagicStick, Check, Camera, Picture, Refresh, Loading } from '@element-plus/icons-vue';
import dayjsLike from '@/utils/date';
import { compressImage, dataUrlSize } from '@/utils/image';
import { api } from '@/api';
import { useUserStore } from '@/stores/user';
import ChartBox from '@/components/ChartBox.vue';

const store = useUserStore();

const loading = ref(false);
const recommending = ref(false);
const adding = ref(false);
const date = ref(dayjsLike.today());
const summary = ref({});
const foods = ref([]);
const foodKw = ref('');
const diet = ref(null);

const addVisible = ref(false);
const addMeal = ref('breakfast');
const addForm = reactive({ foodId: '', amountG: 100 });

const mealNameMap = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };

// ---------------- 拍照识别（多模态）状态 ----------------
const visionEnabled = computed(() => Boolean(store.aiStatus?.vision));
const cameraInput = ref(null);
const albumInput = ref(null);
const visionPreview = ref('');
const visionImageSize = ref(0);
const visionLoading = ref(false);
const visionAdding = ref(false);
const visionResult = ref(null);
const visionMeal = ref('lunch');

/** 识别结果按当前克数/匹配项实时合计（改克数时立刻反映） */
const visionTotalKcal = computed(() =>
  Math.round((visionResult.value?.items || []).reduce((s, i) => s + (Number(i.kcal) || 0), 0)),
);

/** 打开相机或相册 */
function pickImage(mode = 'album') {
  if (!visionEnabled.value) {
    ElMessage.warning('未配置视觉模型（AI_VISION_MODEL），无法识别照片');
    return;
  }
  const el = mode === 'camera' ? cameraInput.value : albumInput.value;
  el?.click();
}

/** 选中图片 → 压缩 → 自动开始识别 */
async function onFileChange(e) {
  const file = e.target.files?.[0];
  e.target.value = ''; // 允许重复选同一张
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    ElMessage.warning('请选择图片文件');
    return;
  }
  try {
    const dataUrl = await compressImage(file, { maxEdge: 1280, quality: 0.82 });
    visionPreview.value = dataUrl;
    visionImageSize.value = dataUrlSize(dataUrl);
    await runVision();
  } catch (err) {
    ElMessage.error(err.message || '图片处理失败');
  }
}

/** 调用多模态识别接口 */
async function runVision() {
  if (!visionPreview.value) return;
  visionLoading.value = true;
  visionResult.value = null;
  try {
    const res = await api.visionFood(visionPreview.value);
    visionResult.value = res;
    if (!res.items?.length) ElMessage.warning('没有识别到食物，换一张更清晰的照片试试');
  } catch {
    /* 错误提示由 axios 拦截器统一处理 */
  } finally {
    visionLoading.value = false;
  }
}

/** 改选匹配的食物库条目 → 按库内营养值重算该项 */
function changeVisionFood(idx, foodId) {
  const item = visionResult.value?.items[idx];
  const food = foods.value.find((f) => f.id === foodId) || item?.candidates?.find((c) => c.id === foodId);
  if (!item || !food) return;
  item.matchedFoodId = food.id;
  item.matchedFoodName = food.name;
  const k = item.amountG / 100;
  item.kcal = Math.round(food.kcal * k);
  item.protein = Number((food.protein * k).toFixed(1));
  item.fat = Number((food.fat * k).toFixed(1));
  item.carb = Number((food.carb * k).toFixed(1));
}

/** 调整克数 → 重算该项 */
function changeVisionAmount(idx, amountG) {
  const item = visionResult.value?.items[idx];
  if (!item || !amountG) return;
  item.amountG = amountG;
  if (item.matchedFoodId) {
    changeVisionFood(idx, item.matchedFoodId);
  } else {
    // 未匹配时按模型值的比例缩放（近似）
    const ratio = amountG / (item.amountG || amountG);
    item.kcal = Math.round((item.modelKcal || 0) * (amountG / 100) * 1);
  }
}

/** 把识别结果写入今日饮食记录 */
async function adoptVision() {
  const items = (visionResult.value?.items || []).filter((i) => i.matchedFoodId);
  if (!items.length) {
    ElMessage.warning('请先为识别到的食物选择食物库条目');
    return;
  }
  visionAdding.value = true;
  try {
    const res = await api.addDietBatch({
      date: date.value,
      meals: [
        {
          mealType: visionMeal.value,
          items: items.map((i) => ({ foodId: i.matchedFoodId, foodName: i.matchedFoodName, amountG: i.amountG })),
        },
      ],
    });
    ElMessage.success(`已把 ${res.count} 项食物加入${mealNameMap[visionMeal.value]}`);
    resetVision();
    await loadSummary();
  } finally {
    visionAdding.value = false;
  }
}

/** 清空识别状态 */
function resetVision() {
  visionPreview.value = '';
  visionImageSize.value = 0;
  visionResult.value = null;
  visionLoading.value = false;
}

const remaining = computed(() => {
  const t = summary.value.target?.kcal || 0;
  const c = summary.value.totals?.kcal || 0;
  return t - c;
});

const intakePercent = computed(() => {
  const t = summary.value.target?.kcal;
  if (!t) return 0;
  return Math.min(150, Math.round(((summary.value.totals?.kcal || 0) / t) * 100));
});

const pickedFood = computed(() => foods.value.find((f) => f.id === addForm.foodId));

/** 蛋白质是否接近目标（超出 +25% 或低于 -25% 视为偏离，界面会变黄提示） */
const proteinOk = computed(() => {
  const target = diet.value?.targetProtein;
  const actual = diet.value?.totalProtein;
  if (!target || !actual) return true;
  return Math.abs(actual - target) / target <= 0.25;
});

/** 供能比环形图 */
const macroOption = computed(() => {
  const r = summary.value.ratio || {};
  return {
    tooltip: { trigger: 'item', formatter: '{b}: {c}%' },
    legend: { bottom: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { fontSize: 11, color: '#64748b' } },
    series: [
      {
        type: 'pie',
        radius: ['48%', '72%'],
        center: ['50%', '44%'],
        itemStyle: { borderColor: '#fff', borderWidth: 3, borderRadius: 6 },
        label: { show: true, formatter: '{d}%', fontSize: 11, color: '#475569' },
        labelLine: { length: 8, length2: 8 },
        data: [
          { name: '蛋白质', value: r.protein || 0, itemStyle: { color: '#10b981' } },
          { name: '碳水', value: r.carb || 0, itemStyle: { color: '#3b82f6' } },
          { name: '脂肪', value: r.fat || 0, itemStyle: { color: '#f59e0b' } },
        ],
      },
    ],
  };
});

function mealIcon(type) {
  return { breakfast: '🌅', lunch: '☀️', dinner: '🌙', snack: '🍎' }[type] || '🍽️';
}

/** 读取某日饮食汇总 */
async function loadSummary() {
  loading.value = true;
  try {
    summary.value = await api.dietSummary(date.value);
  } finally {
    loading.value = false;
  }
}

/** 食物库搜索 */
async function searchFoods() {
  foods.value = await api.foods({ kw: foodKw.value || undefined });
}

function openAdd(mealType) {
  addMeal.value = mealType;
  addForm.foodId = '';
  addForm.amountG = 100;
  addVisible.value = true;
}

async function confirmAdd() {
  if (!addForm.foodId) {
    ElMessage.warning('请选择食物');
    return;
  }
  adding.value = true;
  try {
    await api.addDietLog({ date: date.value, mealType: addMeal.value, foodId: addForm.foodId, amountG: addForm.amountG });
    ElMessage.success('已添加');
    addVisible.value = false;
    await loadSummary();
  } finally {
    adding.value = false;
  }
}

async function removeItem(id) {
  await api.deleteDietLog(id);
  await loadSummary();
}

/** AI 生成配餐 */
async function recommend() {
  recommending.value = true;
  try {
    const res = await api.recommendDiet({ goal: summary.value.profile?.goal });
    diet.value = res.diet;
    // 明确区分三种来源，避免"缓存命中"被误显示成"本地引擎"（会让人误以为没用上大模型）
    const sourceText =
      res.meta?.provider === 'llm' ? '大模型生成' : res.meta?.cacheHit ? '缓存复用（同一画像，秒级返回）' : '本地规则引擎';
    ElMessage.success(`配餐已生成 · ${sourceText}`);
  } finally {
    recommending.value = false;
  }
}

/** 一键采纳：把 AI 餐单批量写入今日饮食记录 */
async function adoptDiet() {
  const meals = diet.value.meals.map((m) => ({
    mealType: m.mealType,
    items: m.items.map((it) => ({ foodId: it.foodId, foodName: it.foodName, amountG: it.amountG })),
  }));
  const res = await api.addDietBatch({ date: date.value, meals });
  ElMessage.success(`已采纳 ${res.count} 条饮食记录`);
  await loadSummary();
}

onMounted(async () => {
  await Promise.all([loadSummary(), searchFoods()]);
});
</script>

<style scoped>
/* ---------------- 热量区 ---------------- */
.calorie-main {
  display: flex;
  align-items: center;
  gap: 24px;
}
.calorie-ring :deep(.el-progress__text) {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.ring-value {
  font-size: 24px;
  font-weight: 800;
  color: var(--text-1);
}
.ring-label {
  font-size: 10.5px;
  color: var(--text-3);
  margin-top: 2px;
}
.ring-target {
  font-size: 10px;
  color: var(--text-3);
  margin-top: 2px;
}
.calorie-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.detail-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12.5px;
  color: var(--text-2);
  padding-bottom: 8px;
  border-bottom: 1px dashed #eef2f7;
}
.detail-row b {
  font-size: 13px;
  color: var(--text-1);
}

/* ---------------- 餐次卡片 ---------------- */
.meal-card {
  padding: 16px 18px;
}
.meal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.meal-icon {
  font-size: 22px;
}
.meal-name {
  font-size: 14px;
  font-weight: 800;
}
.meal-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.food-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 8px;
  background: #fbfdfe;
  border: 1px solid #f1f5f9;
  font-size: 12.5px;
}
.food-name {
  flex: 1;
  font-weight: 500;
  color: var(--text-1);
}
.food-amount {
  color: var(--text-3);
  font-size: 11.5px;
}
.food-kcal {
  color: var(--brand-dark);
  font-weight: 700;
  font-size: 12px;
  min-width: 68px;
  text-align: right;
}
.meal-empty {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
  background: #fbfdfe;
  border: 1px dashed #e2e8f0;
  border-radius: 10px;
}

/* ---------------- AI 配餐 ---------------- */
.diet-result {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.diet-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.diet-meals {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.diet-meal {
  padding: 12px;
  border-radius: 12px;
  background: #f8fafc;
  border: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.diet-meal-name {
  font-size: 13px;
  font-weight: 800;
  margin-bottom: 2px;
}
.diet-tips {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.7;
  background: #fffbeb;
  border: 1px solid #fef3c7;
  padding: 12px 14px;
  border-radius: 10px;
}

/* ---------------- 拍照识别（多模态）---------------- */
.vision-drop {
  border: 2px dashed #cbd5e1;
  border-radius: 14px;
  background: linear-gradient(135deg, #fbfdff, #f8fafc);
  padding: 26px 18px;
  text-align: center;
  cursor: pointer;
  transition: all 0.25s ease;
}
.vision-drop:hover {
  border-color: var(--brand);
  background: linear-gradient(135deg, #f0fdf4, #ecfdf5);
}
.vision-icon {
  font-size: 34px;
  margin-bottom: 6px;
}
.vision-title {
  font-size: 14.5px;
  font-weight: 700;
  margin-bottom: 6px;
}
.vision-desc {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.7;
  max-width: 460px;
  margin: 0 auto 14px;
}
.vision-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
}
.vision-warn {
  margin-top: 12px;
  font-size: 11.5px;
  color: #92400e;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 8px;
  padding: 8px 10px;
  display: inline-block;
}

.vision-body {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 16px;
}
.vision-left {
  text-align: center;
}
.vision-img {
  width: 100%;
  max-height: 220px;
  object-fit: cover;
  border-radius: 12px;
  border: 1px solid var(--line);
}
.vision-img-meta {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 6px;
}
.vision-right {
  min-width: 0;
}
.vision-loading {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 22px;
  border-radius: 12px;
  background: #f0fdf4;
  border: 1px solid #d1fae5;
}
.vision-loading-title {
  font-size: 13.5px;
  font-weight: 700;
  margin-bottom: 3px;
}

.vision-items {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}
.vision-item {
  padding: 9px 11px;
  border-radius: 10px;
  background: #fbfdfe;
  border: 1px solid #f1f5f9;
}
.vi-name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.vi-model-name {
  font-size: 13px;
  font-weight: 700;
}
.vi-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.vi-select {
  width: 190px;
}
.vi-amount {
  width: 110px;
}
.vi-kcal {
  font-size: 13px;
  font-weight: 800;
  color: var(--brand-dark);
  min-width: 66px;
}
.vi-macro {
  font-size: 11px;
  color: var(--text-3);
}
.vision-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--line);
}
.vision-total {
  font-size: 13px;
  color: var(--text-2);
}
.vision-total b {
  font-size: 18px;
  color: var(--brand-dark);
}

@media (max-width: 900px) {
  .vision-body {
    grid-template-columns: 1fr;
  }
  .vision-img {
    max-height: 200px;
  }
  .vi-select {
    width: 100%;
  }
}
</style>
