<!--
  数据总览（首页 / 仪表盘）
  ---------------------------------------------------------------
  这是演示视频的「主镜头」页面，聚合了平台最核心的四类信息：
    1. 四张指标卡：今日消耗 / 今日摄入 / 今日运动时长 / 当前体重
    2. 近 7 天热量收支趋势（折线图，直观体现「摄入 vs 消耗」）
    3. 今日训练计划（可直接勾选完成，联动生成打卡）
    4. AI 智能建议（基于用户实时数据的规则化建议）
-->
<template>
  <div v-loading="loading">
    <!-- ==================== 顶部欢迎条 ==================== -->
    <div class="welcome card">
      <div class="welcome-left">
        <div class="hello">你好，{{ store.nickname }} 👋</div>
        <div class="sub">
          今天是 {{ data.date }}，目标「{{ data.user?.goalText || '保持健康' }}」，
          <span v-if="data.streak > 0" class="text-brand">已连续打卡 {{ data.streak }} 天，继续保持！</span>
          <span v-else>开始今天的第一次打卡吧！</span>
        </div>
      </div>
      <div class="welcome-right">
        <el-button type="primary" class="btn-gradient" :icon="Plus" @click="$router.push('/checkin')">立即打卡</el-button>
        <el-button :icon="MagicStick" @click="$router.push('/coach')">问问 AI 教练</el-button>
      </div>
    </div>

    <!-- ==================== 指标卡 ==================== -->
    <div class="grid grid-4 mt-16">
      <StatCard
        label="今日运动消耗"
        :value="data.today?.burn || 0"
        unit="kcal"
        icon="Lightning"
        color="#f59e0b"
        :progress="rateOf('kcalOut')"
        :tip="`目标 ${targetOf('kcalOut')} kcal`"
      />
      <StatCard
        label="今日饮食摄入"
        :value="data.today?.intake || 0"
        unit="kcal"
        icon="Bowl"
        color="#10b981"
        :progress="rateOf('kcalIn')"
        :tip="`目标 ${targetOf('kcalIn')} kcal · 剩余 ${remainingKcal} kcal`"
      />
      <StatCard
        label="今日运动时长"
        :value="data.today?.minutes || 0"
        unit="分钟"
        icon="Timer"
        color="#3b82f6"
        :progress="rateOf('minutes')"
        :tip="`今日打卡 ${data.today?.checkinCount || 0} 次`"
      />
      <StatCard
        label="当前体重"
        :value="data.body?.weight || '-'"
        unit="kg"
        icon="Odometer"
        color="#8b5cf6"
        :delta="data.body?.weightChange"
        delta-unit="kg"
        invert
        :tip="data.body ? `BMI ${data.body.bmi}（${data.body.bmiLevel}）· ${data.body.recordDate}` : '还没有身体数据'"
        clickable
        @click="$router.push('/body')"
      />
    </div>

    <!-- ==================== 图表 + 目标 ==================== -->
    <div class="grid mt-16" style="grid-template-columns: 1.6fr 1fr">
      <div class="card">
        <div class="card-title">
          <span>近 7 天热量收支</span>
          <span class="sub">摄入 vs 消耗（kcal）</span>
        </div>
        <ChartBox :option="trendOption" height="290px" :loading="loading" />
      </div>

      <div class="card">
        <div class="card-title">
          <span>今日目标完成度</span>
          <span class="sub">自动计算</span>
        </div>
        <div class="goals">
          <div v-for="g in data.goals || []" :key="g.key" class="goal-item">
            <div class="goal-head">
              <span class="goal-label">{{ g.label }}</span>
              <span class="goal-value">
                <b>{{ g.current }}</b> / {{ g.target }} {{ g.unit }}
              </span>
            </div>
            <el-progress
              :percentage="g.rate"
              :stroke-width="9"
              :show-text="false"
              :color="progressColor(g.rate)"
            />
            <div class="goal-rate" :style="{ color: progressColor(g.rate) }">{{ g.rate }}%</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== 今日计划 + AI 建议 ==================== -->
    <div class="grid grid-2 mt-16">
      <div class="card">
        <div class="card-title">
          <span>今日训练计划</span>
          <el-button v-if="data.plan" link type="primary" @click="$router.push('/plan')">查看完整计划</el-button>
        </div>

        <template v-if="data.plan">
          <div class="plan-head">
            <div>
              <div class="plan-title">{{ data.plan.title }}</div>
              <div class="text-muted">整体进度 {{ data.plan.weekProgress.done }} / {{ data.plan.weekProgress.total }} 个动作</div>
            </div>
            <el-progress
              type="dashboard"
              :percentage="data.plan.weekProgress.rate"
              :width="76"
              :stroke-width="7"
              color="#10b981"
            />
          </div>
          <div class="plan-tip">
            💡 完成计划中的动作后，勾选即可自动生成运动打卡，形成「计划 → 执行 → 打卡」闭环。
          </div>
        </template>

        <el-empty v-else description="还没有训练计划" :image-size="80">
          <el-button type="primary" class="btn-gradient" @click="$router.push('/plan')">让 AI 生成我的计划</el-button>
        </el-empty>
      </div>

      <div class="card">
        <div class="card-title">
          <span>AI 智能建议</span>
          <span class="ai-chip">规则引擎 · 实时</span>
        </div>
        <div class="tips">
          <div v-for="(tip, i) in data.tips || []" :key="i" class="tip-item">
            <span class="tip-icon">{{ tip.icon }}</span>
            <div>
              <div class="tip-title">{{ tip.title }}</div>
              <div class="tip-content">{{ tip.content }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { Plus, MagicStick } from '@element-plus/icons-vue';
import { api } from '@/api';
import { useUserStore } from '@/stores/user';
import StatCard from '@/components/StatCard.vue';
import ChartBox from '@/components/ChartBox.vue';

const store = useUserStore();
const loading = ref(true);
const data = ref({});

/** 找到指定 key 的目标项 */
const findGoal = (key) => (data.value.goals || []).find((g) => g.key === key);
const rateOf = (key) => findGoal(key)?.rate ?? 0;
const targetOf = (key) => findGoal(key)?.target ?? 0;

const remainingKcal = computed(() => {
  const g = findGoal('kcalIn');
  return g ? Math.max(0, g.target - g.current) : 0;
});

/** 进度颜色：<60% 蓝、60~99% 绿、100% 橙（警示超标） */
function progressColor(rate) {
  if (rate >= 100) return '#f59e0b';
  if (rate >= 60) return '#10b981';
  return '#3b82f6';
}

/** 近 7 天收支折线图配置 */
const trendOption = computed(() => {
  const trend = data.value.trend || [];
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: ['摄入热量', '运动消耗'], right: 10, top: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10 },
    grid: { left: 8, right: 14, top: 40, bottom: 6, containLabel: true },
    xAxis: {
      type: 'category',
      data: trend.map((t) => t.date.slice(5)),
      axisLine: { lineStyle: { color: '#e2e8f0' } },
      axisTick: { show: false },
      axisLabel: { color: '#94a3b8', fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      name: 'kcal',
      nameTextStyle: { color: '#94a3b8', fontSize: 11 },
      splitLine: { lineStyle: { color: '#f1f5f9' } },
      axisLabel: { color: '#94a3b8', fontSize: 11 },
    },
    series: [
      {
        name: '摄入热量',
        type: 'bar',
        data: trend.map((t) => t.intake),
        barWidth: 14,
        itemStyle: { borderRadius: [6, 6, 0, 0], color: '#34d399' },
      },
      {
        name: '运动消耗',
        type: 'line',
        smooth: true,
        symbolSize: 7,
        data: trend.map((t) => t.burn),
        lineStyle: { width: 3, color: '#f59e0b' },
        itemStyle: { color: '#f59e0b' },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(245, 158, 11, 0.28)' },
              { offset: 1, color: 'rgba(245, 158, 11, 0)' },
            ],
          },
        },
      },
    ],
  };
});

onMounted(async () => {
  try {
    data.value = await api.overview();
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.welcome {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: linear-gradient(120deg, #ecfdf5 0%, #f0fdfa 55%, #ffffff 100%);
  border: 1px solid #d1fae5;
}
.hello {
  font-size: 19px;
  font-weight: 800;
  margin-bottom: 6px;
}
.welcome .sub {
  font-size: 13px;
  color: var(--text-2);
}
.welcome-right {
  display: flex;
  gap: 10px;
}

/* ---------------- 目标完成度 ---------------- */
.goals {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.goal-item {
  position: relative;
}
.goal-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 7px;
}
.goal-label {
  font-size: 12.5px;
  color: var(--text-2);
}
.goal-value {
  font-size: 11.5px;
  color: var(--text-3);
}
.goal-value b {
  font-size: 13.5px;
  color: var(--text-1);
}
.goal-rate {
  position: absolute;
  right: 0;
  bottom: -14px;
  font-size: 10.5px;
  font-weight: 700;
}

/* ---------------- 今日计划 ---------------- */
.plan-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-radius: 12px;
  background: #f8fafc;
  margin-bottom: 12px;
}
.plan-title {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 4px;
}
.plan-tip {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
}

/* ---------------- AI 建议 ---------------- */
.tips {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.tip-item {
  display: flex;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  background: linear-gradient(135deg, #fffdf5, #fffbeb);
  border: 1px solid #fef3c7;
}
.tip-icon {
  font-size: 20px;
  line-height: 1.2;
}
.tip-title {
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 4px;
}
.tip-content {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.65;
}
</style>
