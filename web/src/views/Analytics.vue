<!--
  数据可视化页（分析大屏）
  ---------------------------------------------------------------
  把散落在各模块的数据汇聚成 6 张图，一屏看清「练得怎么样、吃得怎么样、身体怎么变」：
    ① 综合完成度仪表盘    ② 近 30 天训练量柱状图
    ③ 热量收支与缺口      ④ 训练部位雷达图
    ⑤ 体重/体脂趋势       ⑥ 打卡热力图
  讲解要点：所有图表都基于 ECharts，统一封装在 ChartBox 组件里，
           数据全部来自后端聚合接口，前端不做二次计算，保证「一处数据、多处一致」。
-->
<template>
  <div v-loading="loading">
    <!-- 顶部筛选 -->
    <div class="card toolbar">
      <div class="row">
        <span class="toolbar-label">统计周期</span>
        <el-radio-group v-model="range" size="default" @change="loadAll">
          <el-radio-button :value="7">近 7 天</el-radio-button>
          <el-radio-button :value="30">近 30 天</el-radio-button>
          <el-radio-button :value="90">近 90 天</el-radio-button>
        </el-radio-group>
      </div>
      <div class="row">
        <el-tag effect="plain" type="success">总训练 {{ stats.totalMinutes || 0 }} 分钟</el-tag>
        <el-tag effect="plain" type="warning">总消耗 {{ stats.totalCalories || 0 }} kcal</el-tag>
        <el-tag effect="plain" type="info">打卡 {{ stats.totalDays || 0 }} 天</el-tag>
        <el-tag effect="plain">连续 {{ stats.streak || 0 }} 天</el-tag>
      </div>
    </div>

    <!-- 图表网格 -->
    <div class="grid grid-3 mt-16">
      <!-- ① 本周目标完成度仪表盘 -->
      <div class="card">
        <div class="card-title"><span>本周训练完成度</span></div>
        <ChartBox :option="gaugeOption" height="240px" />
      </div>

      <!-- ② 训练部位雷达 -->
      <div class="card">
        <div class="card-title"><span>训练部位均衡度</span><span class="sub">按动作出现次数</span></div>
        <ChartBox :option="muscleRadarOption" height="240px" />
      </div>

      <!-- ③ 热量收支 -->
      <div class="card">
        <div class="card-title"><span>热量收支对比</span><span class="sub">摄入 vs 消耗</span></div>
        <ChartBox :option="calorieOption" height="240px" />
      </div>
    </div>

    <div class="grid mt-16" style="grid-template-columns: 1.5fr 1fr">
      <!-- ④ 近 N 天训练量 -->
      <div class="card">
        <div class="card-title">
          <span>近 {{ range }} 天训练量</span>
          <span class="sub">柱：时长 · 线：消耗</span>
        </div>
        <ChartBox :option="volumeOption" height="300px" />
      </div>

      <!-- ⑤ 体重与体脂 -->
      <div class="card">
        <div class="card-title">
          <span>身体成分变化</span>
          <span class="sub">体重 / 体脂率 / 肌肉量</span>
        </div>
        <ChartBox :option="bodyOption" height="300px" />
      </div>
    </div>

    <!-- ⑥ 打卡热力图 -->
    <div class="card mt-16">
      <div class="card-title">
        <span>打卡热力图</span>
        <span class="sub">颜色越深，当日训练时长越长</span>
      </div>
      <ChartBox :option="heatmapOption" height="240px" />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import dayjsLike from '@/utils/date';
import { api } from '@/api';
import ChartBox from '@/components/ChartBox.vue';

const loading = ref(true);
const range = ref(30);
const stats = ref({});
const overview = ref({});
const bodyAnalysis = ref({});

/** ① 仪表盘：本周训练天数 / 目标天数 */
const gaugeOption = computed(() => {
  const week = stats.value.week || { days: 0, target: 3 };
  const rate = Math.min(100, Math.round((week.days / (week.target || 3)) * 100));
  return {
    series: [
      {
        type: 'gauge',
        startAngle: 210,
        endAngle: -30,
        radius: '92%',
        center: ['50%', '58%'],
        progress: { show: true, width: 14, roundCap: true, itemStyle: { color: '#10b981' } },
        axisLine: { lineStyle: { width: 14, color: [[1, '#eef2f7']] } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        pointer: { show: false },
        anchor: { show: false },
        title: { show: true, offsetCenter: [0, '32%'], fontSize: 12, color: '#94a3b8' },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, '2%'],
          fontSize: 30,
          fontWeight: 800,
          color: '#0f172a',
          formatter: '{value}%',
        },
        data: [{ value: rate, name: `本周 ${week.days} / ${week.target} 天` }],
      },
    ],
  };
});

/** ② 部位雷达：把各类型时长归一化为占比，六个维度同一量纲更易比较 */
const muscleRadarOption = computed(() => {
  const share = stats.value.categoryShare || [];
  const total = share.reduce((s, x) => s + x.value, 0) || 1;
  const pct = share.map((s) => ({ name: s.name, value: Math.round((s.value / total) * 100) }));
  const indicator = pct.length ? pct.map((s) => ({ name: s.name, max: 100 })) : [{ name: '暂无数据', max: 100 }];
  return {
    tooltip: { formatter: (p) => p.value.map((v, i) => `${indicator[i].name}: ${v}%`).join('<br/>') },
    radar: {
      indicator,
      radius: '64%',
      axisName: { color: '#64748b', fontSize: 11 },
      splitLine: { lineStyle: { color: '#e2e8f0' } },
      splitArea: { areaStyle: { color: ['#fff', '#f8fafc'] } },
      axisLine: { lineStyle: { color: '#e2e8f0' } },
    },
    series: [
      {
        type: 'radar',
        data: [
          {
            value: pct.map((s) => s.value),
            name: '训练时长占比(%)',
            areaStyle: { color: 'rgba(59, 130, 246, 0.22)' },
            lineStyle: { color: '#3b82f6', width: 2 },
            itemStyle: { color: '#3b82f6' },
          },
        ],
      },
    ],
  };
});

/** ③ 热量收支（近 7 天） */
const calorieOption = computed(() => {
  const trend = overview.value.trend || [];
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: ['摄入', '消耗'], top: 0, right: 0, itemWidth: 9, itemHeight: 9, textStyle: { fontSize: 11 } },
    grid: { left: 4, right: 10, top: 34, bottom: 2, containLabel: true },
    xAxis: {
      type: 'category',
      data: trend.map((t) => t.date.slice(5)),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#e2e8f0' } },
      axisLabel: { fontSize: 10, color: '#94a3b8' },
    },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f1f5f9' } }, axisLabel: { fontSize: 10, color: '#94a3b8' } },
    series: [
      { name: '摄入', type: 'bar', barWidth: 12, data: trend.map((t) => t.intake), itemStyle: { color: '#34d399', borderRadius: [5, 5, 0, 0] } },
      { name: '消耗', type: 'bar', barWidth: 12, data: trend.map((t) => t.burn), itemStyle: { color: '#fbbf24', borderRadius: [5, 5, 0, 0] } },
    ],
  };
});

/** ④ 训练量柱线组合（按 range 取最近 N 天热力图数据） */
const volumeOption = computed(() => {
  const heatmap = (stats.value.heatmap || []).slice(-range.value);
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: ['训练时长(分)', '消耗(kcal)'], top: 0, right: 0, itemWidth: 9, itemHeight: 9, textStyle: { fontSize: 11 } },
    grid: { left: 6, right: 12, top: 34, bottom: 4, containLabel: true },
    xAxis: {
      type: 'category',
      data: heatmap.map((d) => d.date.slice(5)),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#e2e8f0' } },
      axisLabel: { fontSize: 10, color: '#94a3b8', interval: range.value > 30 ? 6 : 0 },
    },
    yAxis: [
      { type: 'value', name: '分', nameTextStyle: { fontSize: 10, color: '#94a3b8' }, splitLine: { lineStyle: { color: '#f1f5f9' } }, axisLabel: { fontSize: 10, color: '#94a3b8' } },
      { type: 'value', name: 'kcal', nameTextStyle: { fontSize: 10, color: '#94a3b8' }, splitLine: { show: false }, axisLabel: { fontSize: 10, color: '#94a3b8' } },
    ],
    series: [
      {
        name: '训练时长(分)',
        type: 'bar',
        barMaxWidth: 16,
        data: heatmap.map((d) => d.minutes),
        itemStyle: {
          borderRadius: [5, 5, 0, 0],
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: '#34d399' },
              { offset: 1, color: '#d1fae5' },
            ],
          },
        },
      },
      {
        name: '消耗(kcal)',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbolSize: 5,
        data: heatmap.map((d) => d.calories),
        lineStyle: { width: 2, color: '#f59e0b' },
        itemStyle: { color: '#f59e0b' },
      },
    ],
  };
});

/** ⑤ 身体成分 */
const bodyOption = computed(() => {
  const trend = bodyAnalysis.value.trend || [];
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: ['体重', '体脂率', '骨骼肌'], top: 0, right: 0, itemWidth: 9, itemHeight: 9, textStyle: { fontSize: 11 } },
    grid: { left: 6, right: 12, top: 34, bottom: 4, containLabel: true },
    xAxis: {
      type: 'category',
      data: trend.map((t) => t.date.slice(5)),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#e2e8f0' } },
      axisLabel: { fontSize: 10, color: '#94a3b8' },
    },
    yAxis: { type: 'value', scale: true, splitLine: { lineStyle: { color: '#f1f5f9' } }, axisLabel: { fontSize: 10, color: '#94a3b8' } },
    series: [
      { name: '体重', type: 'line', smooth: true, symbolSize: 5, data: trend.map((t) => t.weight), lineStyle: { width: 2.5, color: '#10b981' }, itemStyle: { color: '#10b981' } },
      { name: '体脂率', type: 'line', smooth: true, symbolSize: 5, connectNulls: true, data: trend.map((t) => t.bodyFat), lineStyle: { width: 2, color: '#f59e0b' }, itemStyle: { color: '#f59e0b' } },
      { name: '骨骼肌', type: 'line', smooth: true, symbolSize: 5, connectNulls: true, data: trend.map((t) => t.muscle), lineStyle: { width: 2, color: '#8b5cf6' }, itemStyle: { color: '#8b5cf6' } },
    ],
  };
});

/** ⑥ 热力图 */
const heatmapOption = computed(() => {
  const data = (stats.value.heatmap || []).map((d) => [d.date, d.minutes]);
  const maxMinutes = Math.max(60, ...data.map((d) => d[1]));
  return {
    tooltip: { formatter: (p) => `${p.data[0]}<br/>训练 ${p.data[1]} 分钟` },
    visualMap: {
      min: 0,
      max: maxMinutes,
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
      cellSize: [14, 14],
      range: [dayjsLike.shift(dayjsLike.today(), -89), dayjsLike.today()],
      splitLine: { show: false },
      itemStyle: { borderWidth: 2, borderColor: '#fff', color: '#f8fafc' },
      yearLabel: { show: false },
      dayLabel: { firstDay: 1, fontSize: 10, color: '#94a3b8' },
      monthLabel: { fontSize: 10, color: '#94a3b8' },
    },
    series: [{ type: 'heatmap', coordinateSystem: 'calendar', data }],
  };
});

async function loadAll() {
  loading.value = true;
  try {
    const [s, o, b] = await Promise.all([api.checkinStats(), api.overview(), api.bodyAnalysis()]);
    stats.value = s || {};
    overview.value = o || {};
    bodyAnalysis.value = b || {};
  } finally {
    loading.value = false;
  }
}

onMounted(loadAll);
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
}
.toolbar-label {
  font-size: 13px;
  color: var(--text-2);
  font-weight: 600;
  margin-right: 4px;
}
</style>
