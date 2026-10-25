<!--
  身体数据页
  ---------------------------------------------------------------
  功能：
    · 录入身体数据（体重必填，体脂/围度/心率/睡眠可选）
    · 四项核心指标卡（体重、体脂率、BMI、肌肉量）+ 与首次记录的对比
    · 六维健康雷达图（BMI/体脂/肌肉/腰围/心率/睡眠 → 换算成 0~100 达成度）
    · 体重 & 体脂趋势双轴折线图
    · 历史记录表格
  讲解要点：雷达图的分数不是拍脑袋，而是把每项指标映射到「理想区间」的线性得分，
           全部逻辑在 server/src/modules/body/routes.js 中可查，公开透明。
-->
<template>
  <div v-loading="loading">
    <div class="grid" style="grid-template-columns: 340px 1fr">
      <!-- ==================== 录入表单 ==================== -->
      <div class="card">
        <div class="card-title">
          <span>记录身体数据</span>
          <span class="sub">建议晨起空腹测量</span>
        </div>

        <el-form :model="form" label-position="top">
          <el-form-item label="体重（kg）*">
            <el-input-number v-model="form.weightKg" :min="20" :max="300" :precision="1" :step="0.1" style="width: 100%" />
          </el-form-item>

          <div class="row-2">
            <el-form-item label="体脂率（%）">
              <el-input-number v-model="form.bodyFat" :min="1" :max="70" :precision="1" :step="0.1" style="width: 100%" />
            </el-form-item>
            <el-form-item label="骨骼肌（kg）">
              <el-input-number v-model="form.muscleKg" :min="1" :max="120" :precision="1" :step="0.1" style="width: 100%" />
            </el-form-item>
          </div>

          <div class="row-3">
            <el-form-item label="腰围(cm)">
              <el-input-number v-model="form.waistCm" :min="30" :max="200" :precision="1" style="width: 100%" controls-position="right" />
            </el-form-item>
            <el-form-item label="胸围(cm)">
              <el-input-number v-model="form.chestCm" :min="30" :max="200" :precision="1" style="width: 100%" controls-position="right" />
            </el-form-item>
            <el-form-item label="臀围(cm)">
              <el-input-number v-model="form.hipCm" :min="30" :max="200" :precision="1" style="width: 100%" controls-position="right" />
            </el-form-item>
          </div>

          <div class="row-2">
            <el-form-item label="静息心率">
              <el-input-number v-model="form.restingHr" :min="30" :max="150" style="width: 100%" />
            </el-form-item>
            <el-form-item label="睡眠（小时）">
              <el-input-number v-model="form.sleepHours" :min="0" :max="24" :precision="1" :step="0.5" style="width: 100%" />
            </el-form-item>
          </div>

          <el-form-item label="记录日期">
            <el-date-picker v-model="form.recordDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
          </el-form-item>

          <el-button type="primary" class="btn-gradient full-btn" :loading="submitting" @click="submit">保存记录</el-button>
        </el-form>

        <div class="tips-box">
          💡 每周固定同一天、同一时间测量，数据更可比。
        </div>
      </div>

      <!-- ==================== 指标 + 图表 ==================== -->
      <div>
        <div class="grid grid-4">
          <StatCard label="当前体重" :value="analysis.latest?.weightKg || '-'" unit="kg" icon="Odometer" color="#10b981" :delta="analysis.changes?.weight" delta-unit="kg" invert />
          <StatCard label="体脂率" :value="analysis.latest?.bodyFat ?? '-'" unit="%" icon="PieChart" color="#f59e0b" :delta="analysis.changes?.bodyFat" delta-unit="%" invert :tip="analysis.bodyFatLevel ? `评估：${analysis.bodyFatLevel}` : ''" />
          <StatCard label="BMI" :value="analysis.bmi?.value || '-'" unit="" icon="DataLine" color="#3b82f6" :tip="analysis.bmi ? `等级：${analysis.bmi.level}` : ''" />
          <StatCard label="骨骼肌" :value="analysis.latest?.muscleKg ?? '-'" unit="kg" icon="Medal" color="#8b5cf6" :delta="analysis.changes?.muscle" delta-unit="kg" />
        </div>

        <div class="grid grid-2 mt-16">
          <div class="card">
            <div class="card-title">
              <span>六维健康评分</span>
              <span class="sub">越靠外越接近理想区间</span>
            </div>
            <ChartBox :option="radarOption" height="280px" :empty="!analysis.hasData" />
          </div>

          <div class="card">
            <div class="card-title">
              <span>体重 / 体脂趋势</span>
              <span class="sub">双 Y 轴</span>
            </div>
            <ChartBox :option="trendOption" height="280px" :empty="!analysis.hasData" />
          </div>
        </div>

        <!-- 代谢指标 -->
        <div v-if="analysis.metabolism" class="card mt-16">
          <div class="card-title">
            <span>代谢与目标（用于 AI 配餐 / 训练计划）</span>
            <span class="sub">Mifflin-St Jeor 公式</span>
          </div>
          <div class="grid grid-4">
            <div class="meta-item">
              <div class="meta-label">基础代谢 BMR</div>
              <div class="meta-value">{{ analysis.metabolism.bmr }} <span>kcal</span></div>
            </div>
            <div class="meta-item">
              <div class="meta-label">每日总消耗 TDEE</div>
              <div class="meta-value">{{ analysis.metabolism.tdee }} <span>kcal</span></div>
            </div>
            <div class="meta-item highlight">
              <div class="meta-label">每日目标热量</div>
              <div class="meta-value">{{ analysis.metabolism.targetCalories }} <span>kcal</span></div>
            </div>
            <div class="meta-item">
              <div class="meta-label">蛋白质 / 碳水 / 脂肪</div>
              <div class="meta-value small">
                {{ analysis.metabolism.macros.protein }} / {{ analysis.metabolism.macros.carb }} / {{ analysis.metabolism.macros.fat }} <span>g</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== 历史记录 ==================== -->
    <div class="card mt-16">
      <div class="card-title">
        <span>历史记录</span>
        <span class="sub">共 {{ records.length }} 条</span>
      </div>
      <el-table :data="records" stripe max-height="380" size="small">
        <el-table-column prop="recordDate" label="日期" width="110" />
        <el-table-column prop="weightKg" label="体重(kg)" width="100" />
        <el-table-column label="体脂(%)" width="90">
          <template #default="{ row }">{{ row.bodyFat ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="肌肉(kg)" width="95">
          <template #default="{ row }">{{ row.muscleKg ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="腰围(cm)" width="95">
          <template #default="{ row }">{{ row.waistCm ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="静息心率" width="95">
          <template #default="{ row }">{{ row.restingHr ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="睡眠(h)" width="90">
          <template #default="{ row }">{{ row.sleepHours ?? '—' }}</template>
        </el-table-column>
        <el-table-column prop="note" label="备注" min-width="120" show-overflow-tooltip />
        <el-table-column label="操作" width="70" fixed="right">
          <template #default="{ row }">
            <el-popconfirm title="确定删除？" @confirm="removeRecord(row.id)">
              <template #reference>
                <el-button link type="danger" :icon="Delete" />
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Delete } from '@element-plus/icons-vue';
import dayjsLike from '@/utils/date';
import { api } from '@/api';
import StatCard from '@/components/StatCard.vue';
import ChartBox from '@/components/ChartBox.vue';

const loading = ref(false);
const submitting = ref(false);
const records = ref([]);
const analysis = ref({});

const form = reactive({
  weightKg: 70,
  bodyFat: undefined,
  muscleKg: undefined,
  waistCm: undefined,
  chestCm: undefined,
  hipCm: undefined,
  restingHr: undefined,
  sleepHours: undefined,
  recordDate: dayjsLike.today(),
});

/** 雷达图配置 */
const radarOption = computed(() => {
  const radar = analysis.value.radar || [];
  if (!radar.length) return {};
  return {
    tooltip: {},
    radar: {
      indicator: radar.map((r) => ({ name: r.name, max: 100 })),
      radius: '66%',
      splitNumber: 4,
      axisName: { color: '#64748b', fontSize: 11 },
      splitLine: { lineStyle: { color: '#e2e8f0' } },
      splitArea: { areaStyle: { color: ['#ffffff', '#f8fafc'] } },
      axisLine: { lineStyle: { color: '#e2e8f0' } },
    },
    series: [
      {
        type: 'radar',
        data: [
          {
            value: radar.map((r) => r.value),
            name: '健康评分',
            areaStyle: { color: 'rgba(16, 185, 129, 0.25)' },
            lineStyle: { color: '#10b981', width: 2 },
            itemStyle: { color: '#10b981' },
          },
        ],
      },
    ],
  };
});

/** 双轴趋势图 */
const trendOption = computed(() => {
  const trend = analysis.value.trend || [];
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: ['体重(kg)', '体脂率(%)'], right: 0, top: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 11 } },
    grid: { left: 10, right: 12, top: 40, bottom: 6, containLabel: true },
    xAxis: {
      type: 'category',
      data: trend.map((t) => t.date.slice(5)),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#e2e8f0' } },
      axisLabel: { color: '#94a3b8', fontSize: 10 },
    },
    yAxis: [
      { type: 'value', name: 'kg', scale: true, nameTextStyle: { fontSize: 10, color: '#94a3b8' }, splitLine: { lineStyle: { color: '#f1f5f9' } }, axisLabel: { fontSize: 10, color: '#94a3b8' } },
      { type: 'value', name: '%', scale: true, nameTextStyle: { fontSize: 10, color: '#94a3b8' }, splitLine: { show: false }, axisLabel: { fontSize: 10, color: '#94a3b8' } },
    ],
    series: [
      {
        name: '体重(kg)',
        type: 'line',
        smooth: true,
        symbolSize: 6,
        data: trend.map((t) => t.weight),
        lineStyle: { width: 3, color: '#10b981' },
        itemStyle: { color: '#10b981' },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(16, 185, 129, 0.22)' },
              { offset: 1, color: 'rgba(16, 185, 129, 0)' },
            ],
          },
        },
      },
      {
        name: '体脂率(%)',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbolSize: 6,
        connectNulls: true,
        data: trend.map((t) => t.bodyFat),
        lineStyle: { width: 2, color: '#f59e0b', type: 'dashed' },
        itemStyle: { color: '#f59e0b' },
      },
    ],
  };
});

/** 保存记录 */
async function submit() {
  if (!form.weightKg) {
    ElMessage.warning('请填写体重');
    return;
  }
  submitting.value = true;
  try {
    await api.addBodyRecord({ ...form });
    ElMessage.success('身体数据已记录');
    await refresh();
  } finally {
    submitting.value = false;
  }
}

async function removeRecord(id) {
  await api.deleteBodyRecord(id);
  ElMessage.success('已删除');
  await refresh();
}

async function refresh() {
  loading.value = true;
  try {
    const [list, ana] = await Promise.all([api.bodyRecords(120), api.bodyAnalysis()]);
    records.value = list;
    analysis.value = ana || {};
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);
</script>

<style scoped>
.row-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.row-3 {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 12px;
}
.full-btn {
  width: 100%;
  height: 42px;
  font-weight: 600;
}
.tips-box {
  margin-top: 14px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #f0fdf4;
  border: 1px solid #d1fae5;
  font-size: 11.5px;
  color: var(--text-2);
  line-height: 1.6;
}

/* ---------------- 代谢指标 ---------------- */
.meta-item {
  padding: 14px 16px;
  border-radius: 12px;
  background: #f8fafc;
  border: 1px solid var(--line);
}
.meta-item.highlight {
  background: linear-gradient(135deg, #ecfdf5, #f0fdf4);
  border-color: #a7f3d0;
}
.meta-label {
  font-size: 11.5px;
  color: var(--text-3);
  margin-bottom: 6px;
}
.meta-value {
  font-size: 22px;
  font-weight: 800;
  color: var(--text-1);
  letter-spacing: -0.5px;
}
.meta-value.small {
  font-size: 16px;
}
.meta-value span {
  font-size: 11px;
  color: var(--text-3);
  font-weight: 500;
}
</style>
