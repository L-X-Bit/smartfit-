<!--
  指标卡片组件
  ---------------------------------------------------------------
  统一「数值 + 单位 + 环比变化 + 进度条」的展示方式，
  仪表盘、身体数据、饮食页都会复用，保证视觉一致性。
-->
<template>
  <div class="stat-card" :class="{ clickable: clickable }">
    <div class="stat-head">
      <span class="stat-label">{{ label }}</span>
      <span class="stat-icon" :style="{ background: bgColor, color: color }">
        <el-icon><component :is="icon" /></el-icon>
      </span>
    </div>

    <div class="stat-value">
      <span class="num">{{ displayValue }}</span>
      <span class="unit">{{ unit }}</span>
      <span v-if="delta !== null && delta !== undefined" class="delta" :class="deltaClass">
        {{ delta > 0 ? '↑' : delta < 0 ? '↓' : '—' }} {{ Math.abs(delta) }}{{ deltaUnit }}
      </span>
    </div>

    <div v-if="progress !== undefined && progress !== null" class="stat-progress">
      <div class="bar" :style="{ width: `${Math.min(100, progress)}%`, background: color }"></div>
    </div>

    <div v-if="tip" class="stat-tip">{{ tip }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  label: String,
  value: { type: [Number, String], default: 0 },
  unit: { type: String, default: '' },
  icon: { type: String, default: 'DataLine' },
  color: { type: String, default: '#10b981' },
  /** 环比变化值，正负决定箭头方向与颜色（invert=true 时颜色反转，如体重下降是好） */
  delta: { type: Number, default: null },
  deltaUnit: { type: String, default: '' },
  invert: { type: Boolean, default: false },
  /** 0~100 进度百分比 */
  progress: { type: Number, default: null },
  tip: { type: String, default: '' },
  clickable: { type: Boolean, default: false },
});

const displayValue = computed(() => props.value ?? '-');

/** 图标底色用 12% 透明度 */
const bgColor = computed(() => `${props.color}1f`);

const deltaClass = computed(() => {
  if (props.delta === null || props.delta === undefined || props.delta === 0) return 'flat';
  const positive = props.delta > 0;
  // invert：数值上升是"坏"（例如体重上升），则显示红色
  const good = props.invert ? !positive : positive;
  return good ? 'up' : 'down';
});
</script>

<style scoped>
.stat-card {
  background: #fff;
  border-radius: var(--radius);
  border: 1px solid rgba(226, 232, 240, 0.9);
  box-shadow: var(--shadow-sm);
  padding: 18px 18px 16px;
  transition: transform 0.25s ease, box-shadow 0.25s ease;
}
.stat-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}
.clickable {
  cursor: pointer;
}

.stat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.stat-label {
  font-size: 12.5px;
  color: var(--text-2);
  font-weight: 500;
}
.stat-icon {
  width: 32px;
  height: 32px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  font-size: 16px;
}

.stat-value {
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.num {
  font-size: 26px;
  font-weight: 800;
  letter-spacing: -0.5px;
  color: var(--text-1);
}
.unit {
  font-size: 12px;
  color: var(--text-3);
}
.delta {
  margin-left: 6px;
  font-size: 11.5px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 999px;
}
.delta.up {
  color: #047857;
  background: #d1fae5;
}
.delta.down {
  color: #b91c1c;
  background: #fee2e2;
}
.delta.flat {
  color: var(--text-3);
  background: #f1f5f9;
}

.stat-progress {
  margin-top: 12px;
  height: 6px;
  border-radius: 999px;
  background: #f1f5f9;
  overflow: hidden;
}
.stat-progress .bar {
  height: 100%;
  border-radius: 999px;
  transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
}

.stat-tip {
  margin-top: 10px;
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.5;
}
</style>
