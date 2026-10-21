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
import { Plus, Close, MagicStick, Check } from '@element-plus/icons-vue';
import dayjsLike from '@/utils/date';
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
</style>
