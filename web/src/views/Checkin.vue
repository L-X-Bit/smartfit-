<!--
  运动打卡页
  ---------------------------------------------------------------
  功能构成：
    · 左侧：快速打卡表单（动作库搜索 → 自动带出 MET → 后端按 MET 公式算热量）
    · 右上：连续打卡天数 + 本周进度
    · 中部：近 7 天运动柱状图 + 打卡日历热力图（GitHub 风格的贡献图）
    · 底部：打卡记录列表（可删除）
  讲解要点：热量不是前端随便填的，而是「MET × 体重 × 时长 × 强度系数」由后端计算，
           保证数据可信 —— 这是健康类应用与普通待办应用的本质区别。
-->
<template>
  <div v-loading="loading">
    <div class="grid" style="grid-template-columns: 380px 1fr">
      <!-- ==================== 打卡表单 ==================== -->
      <div class="card">
        <div class="card-title">
          <span>快速打卡</span>
          <span class="ai-chip">自动计算热量</span>
        </div>

        <el-form :model="form" label-position="top" size="default">
          <el-form-item label="选择运动（也可直接输入自定义名称）">
            <el-select
              v-model="form.exerciseId"
              filterable
              clearable
              remote
              :remote-method="searchExercises"
              placeholder="搜索动作，如 深蹲 / 慢跑"
              style="width: 100%"
              @change="onExerciseChange"
            >
              <el-option-group v-for="group in exerciseGroups" :key="group.label" :label="group.label">
                <el-option v-for="ex in group.items" :key="ex.id" :label="`${ex.name}（${ex.category}·MET ${ex.met}）`" :value="ex.id" />
              </el-option-group>
            </el-select>
          </el-form-item>

          <el-form-item v-if="!form.exerciseId" label="自定义运动名称">
            <el-input v-model="form.exerciseName" placeholder="如：爬山、羽毛球" />
          </el-form-item>

          <div class="row-2">
            <el-form-item label="时长（分钟）">
              <el-input-number v-model="form.durationMin" :min="1" :max="300" :step="5" style="width: 100%" />
            </el-form-item>
            <el-form-item label="强度">
              <el-select v-model="form.intensity" style="width: 100%">
                <el-option label="轻松" value="low" />
                <el-option label="适中" value="medium" />
                <el-option label="力竭" value="high" />
              </el-select>
            </el-form-item>
          </div>

          <div class="row-2">
            <el-form-item label="组数（力量类）">
              <el-input-number v-model="form.sets" :min="0" :max="20" style="width: 100%" />
            </el-form-item>
            <el-form-item label="每组次数">
              <el-input-number v-model="form.reps" :min="0" :max="200" style="width: 100%" />
            </el-form-item>
          </div>

          <el-form-item label="打卡日期">
            <el-date-picker v-model="form.logDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
          </el-form-item>

          <el-form-item label="今天的感受">
            <el-radio-group v-model="form.feeling">
              <el-radio-button value="轻松">轻松</el-radio-button>
              <el-radio-button value="适中">适中</el-radio-button>
              <el-radio-button value="力竭">力竭</el-radio-button>
            </el-radio-group>
          </el-form-item>

          <el-form-item label="备注">
            <el-input v-model="form.note" type="textarea" :rows="2" placeholder="今天状态如何？" />
          </el-form-item>

          <el-button type="primary" class="btn-gradient full-btn" :loading="submitting" @click="submit">完成打卡</el-button>
        </el-form>

        <!-- 预计消耗提示：让用户体验「数据可信」 -->
        <div v-if="estimatedKcal" class="estimate">
          预计消耗 <b>{{ estimatedKcal }}</b> kcal
          <span class="text-muted">（按最近体重与 MET 估算，实际以后端计算为准）</span>
        </div>
      </div>

      <!-- ==================== 右侧统计 ==================== -->
      <div>
        <div class="grid grid-4">
          <StatCard label="连续打卡" :value="stats.streak || 0" unit="天" icon="Trophy" color="#f59e0b" />
          <StatCard label="本周训练" :value="stats.week?.days || 0" unit="天" icon="Calendar" color="#10b981" :tip="`目标 ${stats.week?.target || 3} 天`" :progress="weekRate" />
          <StatCard label="本周时长" :value="stats.week?.minutes || 0" unit="分钟" icon="Timer" color="#3b82f6" />
          <StatCard label="本周消耗" :value="stats.week?.calories || 0" unit="kcal" icon="Lightning" color="#ef4444" />
        </div>

        <div class="grid grid-2 mt-16">
          <div class="card">
            <div class="card-title">
              <span>近 7 天运动量</span>
              <span class="sub">分钟 / kcal</span>
            </div>
            <ChartBox :option="weekBarOption" height="230px" :empty="!stats.last7?.length" />
          </div>

          <div class="card">
            <div class="card-title">
              <span>运动类型分布</span>
              <span class="sub">按时长占比</span>
            </div>
            <ChartBox :option="categoryPieOption" height="230px" :empty="!stats.categoryShare?.length" />
          </div>
        </div>

        <div class="card mt-16">
          <div class="card-title">
            <span>打卡日历</span>
            <span class="sub">最近 3 个月 · 颜色越深训练越多</span>
          </div>
          <ChartBox :option="heatmapOption" height="230px" />
        </div>
      </div>
    </div>

    <!-- ==================== 打卡记录 ==================== -->
    <div class="card mt-16">
      <div class="card-title">
        <span>打卡记录</span>
        <span class="sub">共 {{ logs.length }} 条</span>
      </div>
      <el-table :data="logs" style="width: 100%" max-height="360" stripe>
        <el-table-column prop="logDate" label="日期" width="110" />
        <el-table-column prop="exerciseName" label="运动" min-width="130" />
        <el-table-column prop="category" label="类型" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="categoryTagType(row.category)">{{ row.category }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="durationMin" label="时长" width="90">
          <template #default="{ row }">{{ Math.round(row.durationMin) }} 分</template>
        </el-table-column>
        <el-table-column label="组数×次数" width="110">
          <template #default="{ row }">
            <span v-if="row.sets">{{ row.sets }} × {{ row.reps }}</span>
            <span v-else class="text-muted">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="calories" label="消耗" width="100">
          <template #default="{ row }"><b class="text-brand">{{ row.calories }}</b> kcal</template>
        </el-table-column>
        <el-table-column prop="feeling" label="感受" width="80" />
        <el-table-column prop="note" label="备注" min-width="140" show-overflow-tooltip />
        <el-table-column label="操作" width="80" fixed="right">
          <template #default="{ row }">
            <el-popconfirm title="确定删除这条打卡记录？" @confirm="removeLog(row.id)">
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
const logs = ref([]);
const stats = ref({});
const exercises = ref([]);

/** 打卡表单：默认今天、30 分钟、中等强度 */
const form = reactive({
  exerciseId: '',
  exerciseName: '',
  durationMin: 30,
  intensity: 'medium',
  sets: 3,
  reps: 12,
  logDate: dayjsLike.today(),
  feeling: '适中',
  note: '',
});

const weekRate = computed(() => {
  const w = stats.value.week;
  if (!w) return 0;
  return Math.min(100, Math.round((w.days / (w.target || 3)) * 100));
});

/** 按分类分组展示动作（下拉框更清爽） */
const exerciseGroups = computed(() => {
  const map = {};
  for (const ex of exercises.value) {
    if (!map[ex.category]) map[ex.category] = { label: ex.category, items: [] };
    map[ex.category].items.push(ex);
  }
  return Object.values(map);
});

/** 选中的动作对象 */
const selectedExercise = computed(() => exercises.value.find((e) => e.id === form.exerciseId));

/** 前端预估热量：MET × 体重(默认65) × 小时 × 强度系数 */
const estimatedKcal = computed(() => {
  if (!selectedExercise.value) return 0;
  const factor = form.intensity === 'low' ? 0.85 : form.intensity === 'high' ? 1.15 : 1;
  return Math.round(selectedExercise.value.met * 65 * (form.durationMin / 60) * factor);
});

/** 选择动作后自动带出分类与默认组次 */
function onExerciseChange(id) {
  const ex = exercises.value.find((e) => e.id === id);
  if (!ex) return;
  if (['力量', '核心'].includes(ex.category)) {
    form.sets = 3;
    form.reps = 12;
    form.durationMin = 15;
  } else {
    form.sets = 0;
    form.reps = 0;
    form.durationMin = 30;
  }
}

/** 远程搜索动作（数据量小，这里直接本地过滤即可） */
async function searchExercises(kw) {
  const list = await api.exercises({ kw: kw || undefined });
  exercises.value = list;
}

/** 提交打卡 */
async function submit() {
  const name = selectedExercise.value?.name || form.exerciseName;
  if (!name) {
    ElMessage.warning('请选择运动或填写运动名称');
    return;
  }
  submitting.value = true;
  try {
    const res = await api.addCheckin({
      exerciseId: form.exerciseId || null,
      exerciseName: name,
      category: selectedExercise.value?.category,
      durationMin: form.durationMin,
      intensity: form.intensity,
      sets: form.sets,
      reps: form.reps,
      feeling: form.feeling,
      note: form.note,
      logDate: form.logDate,
    });
    ElMessage.success(res ? `打卡成功，消耗约 ${res.calories} kcal` : '打卡成功');
    await refresh();
  } finally {
    submitting.value = false;
  }
}

/** 删除打卡 */
async function removeLog(id) {
  await api.deleteCheckin(id);
  ElMessage.success('已删除');
  await refresh();
}

function categoryTagType(c) {
  return { 力量: 'success', 有氧: 'primary', HIIT: 'danger', 核心: 'warning', 柔韧: 'info' }[c] || 'info';
}

// ---------------- 图表配置 ----------------
/** 近 7 天柱状图 */
const weekBarOption = computed(() => {
  const last7 = stats.value.last7 || [];
  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 6, right: 10, top: 24, bottom: 4, containLabel: true },
    xAxis: {
      type: 'category',
      data: last7.map((d) => d.date.slice(5)),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#e2e8f0' } },
      axisLabel: { color: '#94a3b8', fontSize: 11 },
    },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f1f5f9' } }, axisLabel: { color: '#94a3b8', fontSize: 11 } },
    series: [
      {
        name: '运动时长(分)',
        type: 'bar',
        data: last7.map((d) => Math.round(d.minutes)),
        barWidth: 16,
        itemStyle: {
          borderRadius: [6, 6, 0, 0],
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: '#34d399' },
              { offset: 1, color: '#a7f3d0' },
            ],
          },
        },
      },
    ],
  };
});

/** 分类占比饼图 */
const categoryPieOption = computed(() => {
  const share = stats.value.categoryShare || [];
  return {
    tooltip: { trigger: 'item', formatter: '{b}: {c} 分钟 ({d}%)' },
    legend: { bottom: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { fontSize: 11, color: '#64748b' } },
    series: [
      {
        type: 'pie',
        radius: ['42%', '66%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: 6 },
        label: { show: false },
        data: share.map((s) => ({ name: s.name, value: s.value })),
        color: ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ef4444', '#14b8a6'],
      },
    ],
  };
});

/** 日历热力图（GitHub 贡献图风格） */
const heatmapOption = computed(() => {
  const heatmap = stats.value.heatmap || [];
  const end = dayjsLike.today();
  const start = dayjsLike.shift(end, -89);
  const data = heatmap.map((d) => [d.date, d.minutes]);
  const maxMinutes = Math.max(60, ...heatmap.map((d) => d.minutes));

  return {
    tooltip: {
      formatter: (p) => `${p.data[0]}<br/>运动 ${p.data[1]} 分钟`,
    },
    visualMap: {
      min: 0,
      max: maxMinutes,
      calculable: false,
      orient: 'horizontal',
      right: 0,
      top: 0,
      itemWidth: 10,
      itemHeight: 70,
      textStyle: { fontSize: 10, color: '#94a3b8' },
      inRange: { color: ['#eef2f7', '#a7f3d0', '#34d399', '#059669'] },
    },
    calendar: {
      top: 40,
      left: 32,
      right: 10,
      // 固定单元格尺寸，避免容器高度变化时图表被压扁
      cellSize: [14, 14],
      orient: 'horizontal',
      range: [start, end],
      splitLine: { show: false },
      itemStyle: { borderWidth: 2, borderColor: '#fff', color: '#f8fafc' },
      yearLabel: { show: false },
      dayLabel: { firstDay: 1, fontSize: 10, color: '#94a3b8' },
      monthLabel: { fontSize: 10, color: '#94a3b8' },
    },
    series: [{ type: 'heatmap', coordinateSystem: 'calendar', data }],
  };
});

/** 载入数据 */
async function refresh() {
  loading.value = true;
  try {
    const [logList, statData] = await Promise.all([api.checkinLogs({ limit: 200 }), api.checkinStats()]);
    logs.value = logList;
    stats.value = statData;
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await searchExercises('');
  await refresh();
});
</script>

<style scoped>
.row-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.full-btn {
  width: 100%;
  height: 42px;
  font-weight: 600;
}
.estimate {
  margin-top: 14px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #f0fdf4;
  border: 1px solid #d1fae5;
  font-size: 12.5px;
  color: var(--text-2);
}
.estimate b {
  color: var(--brand-dark);
  font-size: 15px;
}
</style>
