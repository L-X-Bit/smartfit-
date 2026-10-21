<!--
  ECharts 通用封装组件
  ---------------------------------------------------------------
  为什么封装：
   1. 统一处理 init / setOption / resize / dispose 生命周期，避免每个页面重复写；
   2. 监听容器尺寸变化（含侧边栏收起、窗口缩放），图表自适应；
   3. 内置 loading 与「暂无数据」两种状态，视觉统一。
  用法：<ChartBox :option="option" height="280px" :loading="loading" :empty="!data.length" />
-->
<template>
  <div class="chart-wrap" :style="{ height }">
    <div ref="chartRef" class="chart-canvas" v-show="!empty && !loading"></div>
    <div v-if="loading" class="chart-mask">
      <el-icon class="is-loading" :size="22"><Loading /></el-icon>
      <span>加载中…</span>
    </div>
    <div v-else-if="empty" class="chart-mask">
      <el-icon :size="22"><DataLine /></el-icon>
      <span>{{ emptyText }}</span>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue';
import * as echarts from 'echarts';

const props = defineProps({
  option: { type: Object, default: () => ({}) },
  height: { type: String, default: '300px' },
  loading: { type: Boolean, default: false },
  empty: { type: Boolean, default: false },
  emptyText: { type: String, default: '暂无数据' },
});

const chartRef = ref(null);
let chart = null;
let observer = null;

/** 初始化图表实例 */
function initChart() {
  if (!chartRef.value) return;
  chart = echarts.init(chartRef.value, null, { renderer: 'canvas' });
  chart.setOption(props.option || {});
}

/** option 变化时增量更新（notMerge=false 保留动画过渡） */
watch(
  () => props.option,
  (val) => {
    if (!val) return;
    if (!chart) nextTick(initChart);
    else chart.setOption(val, true);
  },
  { deep: true },
);

/** 空数据 → 有数据时，DOM 刚从 v-show 恢复显示，需要 resize */
watch(
  () => props.empty,
  (v) => {
    if (!v) nextTick(() => chart?.resize());
  },
);

onMounted(() => {
  initChart();
  // 容器尺寸变化自适应（用 ResizeObserver 比监听 window.resize 更精准）
  if (window.ResizeObserver && chartRef.value) {
    observer = new ResizeObserver(() => chart?.resize());
    observer.observe(chartRef.value);
  } else {
    window.addEventListener('resize', handleResize);
  }
});

function handleResize() {
  chart?.resize();
}

onBeforeUnmount(() => {
  observer?.disconnect();
  window.removeEventListener('resize', handleResize);
  chart?.dispose();
  chart = null;
});
</script>

<style scoped>
.chart-wrap {
  position: relative;
  width: 100%;
}
.chart-canvas {
  width: 100%;
  height: 100%;
}
.chart-mask {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-3);
  font-size: 12.5px;
  background: #fcfdfe;
  border-radius: var(--radius-sm);
}
</style>
