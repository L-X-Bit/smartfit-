<!--
  AI 健身计划页（本项目的核心 AI 页面）
  ===============================================================
  页面结构：
    ① 生成参数面板：目标 / 每周天数 / 周期 / 单次时长 / 经验 / 可用器械 / 伤病情况
    ② 「AI 生成过程」面板：把后端多阶段 Agent 的每一步耗时与结果可视化
       —— 这是与其他作品拉开差距的地方：AI 不是黑盒，而是可解释的流水线
    ③ 计划正文：按周 / 天 / 动作展示，支持勾选完成（联动生成运动打卡）
    ④ 历史计划列表
-->
<template>
  <div>
    <!-- ==================== ① 生成参数 ==================== -->
    <div class="card">
      <div class="card-title">
        <span>AI 训练计划生成器</span>
        <span class="ai-chip">{{ aiOnline ? '大模型 · 多阶段 Agent' : '离线规则引擎' }}</span>
      </div>

      <el-form :model="form" label-position="top">
        <div class="grid grid-4">
          <el-form-item label="健身目标">
            <el-select v-model="form.goal" style="width: 100%">
              <el-option label="减脂（降体脂）" value="lose" />
              <el-option label="增肌（长肌肉）" value="gain" />
              <el-option label="塑形（改线条）" value="shape" />
              <el-option label="保持健康" value="keep" />
            </el-select>
          </el-form-item>

          <el-form-item label="每周训练天数">
            <el-input-number v-model="form.daysPerWeek" :min="1" :max="7" style="width: 100%" />
          </el-form-item>

          <el-form-item label="计划周期（周）">
            <el-input-number v-model="form.weeks" :min="1" :max="12" style="width: 100%" />
          </el-form-item>

          <el-form-item label="单次时长（分钟）">
            <el-input-number v-model="form.sessionMinutes" :min="15" :max="120" :step="5" style="width: 100%" />
          </el-form-item>
        </div>

        <div class="grid grid-3">
          <el-form-item label="训练经验">
            <el-select v-model="form.level" style="width: 100%">
              <el-option label="新手（<3 个月）" value="beginner" />
              <el-option label="进阶（3~12 个月）" value="intermediate" />
              <el-option label="高阶（1 年以上）" value="advanced" />
            </el-select>
          </el-form-item>

          <el-form-item label="可用器械">
            <el-select v-model="form.equipment" multiple collapse-tags style="width: 100%">
              <el-option v-for="e in equipmentOptions" :key="e" :label="e" :value="e" />
            </el-select>
          </el-form-item>

          <el-form-item label="伤病 / 特殊情况（AI 会自动回避禁忌动作）">
            <el-select v-model="form.conditions" multiple collapse-tags style="width: 100%" placeholder="无则不选">
              <el-option label="膝关节不适" value="knee" />
              <el-option label="腰部不适" value="back" />
              <el-option label="肩关节不适" value="shoulder" />
              <el-option label="高血压" value="hypertension" />
              <el-option label="心血管疾病" value="heart" />
              <el-option label="孕期/产后" value="pregnant" />
              <el-option label="50 岁以上" value="senior" />
              <el-option label="大体重（BMI≥28）" value="bigweight" />
            </el-select>
          </el-form-item>
        </div>

        <el-form-item label="补充说明（可选）">
          <el-input v-model="form.queryText" placeholder="例如：想重点练臀腿，不喜欢跑步，家里只有哑铃和弹力带" maxlength="200" show-word-limit />
        </el-form-item>

        <el-button type="primary" class="btn-gradient" size="large" :loading="generating" :icon="MagicStick" @click="generate">
          {{ generating ? 'AI 正在生成…' : '生成我的专属计划' }}
        </el-button>
        <span class="text-muted" style="margin-left: 12px">
          多阶段 Agent · 全过程可解释
        </span>
      </el-form>
    </div>

    <!-- ==================== ② AI 生成过程（技术亮点） ==================== -->
    <div v-if="aiMeta" class="card mt-16">
      <div class="card-title">
        <span>AI 生成过程（可解释性）</span>
        <span class="sub">
          总耗时 {{ aiMeta.totalLatencyMs }} ms ·
          {{ aiMeta.fallback ? '本地规则引擎' : `大模型 ${aiMeta.model}` }} ·
          RAG 命中 {{ aiMeta.ragHits }} 条
        </span>
      </div>

      <div class="stages">
        <div v-for="(s, i) in aiMeta.stages || []" :key="i" class="stage">
          <div class="stage-dot" :class="{ ok: true }">{{ i + 1 }}</div>
          <div class="stage-body">
            <div class="stage-name">{{ stageName(s.stage) }}</div>
            <div class="stage-note">{{ s.note }}</div>
          </div>
          <div class="stage-ms">{{ s.ms }} ms</div>
        </div>
      </div>

      <!-- RAG 引用来源：让「AI 的依据」看得见 -->
      <div v-if="ragRefs.length" class="refs">
        <div class="refs-title">📚 本次生成引用的知识库条目（RAG）</div>
        <div class="refs-list">
          <el-tag v-for="r in ragRefs.slice(0, 14)" :key="r.id" size="small" :type="refTagType(r.type)" effect="plain">
            {{ r.title }}
          </el-tag>
        </div>
      </div>

      <div v-if="aiMeta.validationErrors?.length" class="warn-box">
        ⚠️ 校验提示：{{ aiMeta.validationErrors.join('；') }}
      </div>
      <div v-if="aiMeta.audit?.notes?.length" class="warn-box">
        🛡️ 安全审核：{{ aiMeta.audit.notes.join('；') }}
      </div>
    </div>

    <!-- ==================== ③ 计划正文 ==================== -->
    <div v-if="plan" class="card mt-16">
      <div class="card-title">
        <span>{{ plan.title }}</span>
        <span class="sub">
          {{ plan.weeks }} 周 · 每周 {{ plan.daysPerWeek }} 练 · 完成度 {{ plan.progress.rate }}%
        </span>
      </div>

      <el-collapse v-if="plan.summary || plan.nutritionTips" v-model="summaryOpen" class="plan-summary">
        <el-collapse-item name="s">
          <template #title>
            <span class="ps-head">
              <span class="ps-title">📋 方案说明与饮食建议</span>
              <span class="ps-sub">展开查看</span>
            </span>
          </template>
          <el-alert v-if="plan.summary" :title="plan.summary" type="success" :closable="false" show-icon class="mb-8" />
          <el-alert v-if="plan.nutritionTips" :title="`饮食配套建议：${plan.nutritionTips}`" type="warning" :closable="false" show-icon />
        </el-collapse-item>
      </el-collapse>

      <el-tabs v-model="activeWeek" class="mt-16">
        <el-tab-pane v-for="w in plan.weeklySchedule" :key="w.week" :label="`第 ${w.week} 周`" :name="String(w.week)">
          <div class="days">
            <div v-for="d in w.days" :key="d.day" class="day-card">
              <div class="day-head">
                <span class="day-name">周{{ weekName(d.day) }}</span>
                <el-tag size="small" effect="plain">{{ d.focus }}</el-tag>
                <span class="day-progress">{{ d.doneCount }}/{{ d.totalCount }}</span>
              </div>

              <div class="items">
                <div v-for="item in d.items" :key="item.id" class="item" :class="{ done: item.done }">
                  <el-checkbox :model-value="Boolean(item.done)" @change="(v) => toggleItem(item, v)" />
                  <div class="item-main">
                    <div class="item-name">{{ item.exercise_name }}</div>
                    <div class="item-meta">
                      <span v-if="item.sets">{{ item.sets }} 组 × {{ item.reps }}</span>
                      <span v-else>{{ item.reps }}</span>
                      <span v-if="item.rest_sec"> · 休息 {{ item.rest_sec }}s</span>
                      <span v-if="item.duration_min"> · {{ item.duration_min }} 分钟</span>
                      <span v-if="item.target_group" class="item-group">{{ item.target_group }}</span>
                    </div>
                    <div v-if="item.note" class="item-note">💡 {{ item.note }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>

    <el-empty v-else-if="!generating" description="还没有训练计划，点击上方按钮让 AI 为你生成一份" />

    <!-- ==================== ④ 历史计划 ==================== -->
    <div v-if="history.length" class="card mt-16">
      <div class="card-title">
        <span>历史计划</span>
        <span class="sub">共 {{ history.length }} 份</span>
      </div>
      <el-table :data="history" size="small">
        <el-table-column prop="title" label="计划名称" min-width="180" />
        <el-table-column prop="weeks" label="周期" width="80">
          <template #default="{ row }">{{ row.weeks }} 周</template>
        </el-table-column>
        <el-table-column label="动作进度" width="140">
          <template #default="{ row }">{{ row.doneCount }} / {{ row.itemCount }}</template>
        </el-table-column>
        <el-table-column label="来源" width="130">
          <template #default="{ row }">
            <el-tag size="small" :type="row.source === 'ai' ? 'success' : row.source === 'cache' ? 'info' : 'warning'">
              {{ sourceText(row.source) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="170" />
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="loadPlan(row.id)">查看</el-button>
            <el-popconfirm title="确定删除该计划？" @confirm="removePlan(row.id)">
              <template #reference>
                <el-button link type="danger">删除</el-button>
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
import { MagicStick } from '@element-plus/icons-vue';
import { api } from '@/api';
import { useUserStore } from '@/stores/user';

const store = useUserStore();

const generating = ref(false);
const plan = ref(null);
const aiMeta = ref(null);
const ragRefs = ref([]);
const history = ref([]);
const activeWeek = ref('1');
/** 「方案说明与饮食建议」折叠面板：默认收起，避免一大段文字压在上面 */
const summaryOpen = ref([]);

/** 生成参数（默认值来自用户档案） */
const form = reactive({
  goal: 'lose',
  daysPerWeek: 4,
  weeks: 4,
  sessionMinutes: 45,
  level: 'beginner',
  equipment: ['徒手', '哑铃'],
  conditions: [],
  queryText: '',
});

const equipmentOptions = ['徒手', '哑铃', '杠铃', '器械', '弹力带', '跑步机', '单车'];
const aiOnline = computed(() => store.aiStatus?.enabled);

/** 阶段英文名 → 中文展示名 */
function stageName(stage) {
  return (
    {
      llm_generate: '大模型生成',
      llm_repair: '自动修复重试',
      validate: '结构校验',
      fallback_engine: '规则引擎降级',
      safety_audit: '安全审核',
      cache: '语义缓存',
    }[stage] || stage
  );
}

function refTagType(type) {
  return { guide: 'success', exercise: 'primary', food: 'warning' }[type] || 'info';
}

function sourceText(s) {
  return { ai: 'AI 生成', fallback: '规则引擎', cache: '缓存复用', manual: '手动' }[s] || s;
}

/** 周几对应的中文 */
function weekName(day) {
  return ['一', '二', '三', '四', '五', '六', '日'][(day - 1) % 7];
}

/** 调用 AI 生成计划 */
async function generate() {
  generating.value = true;
  try {
    const res = await api.generatePlan({ ...form });
    plan.value = res.plan;
    aiMeta.value = res.meta;
    ragRefs.value = res.refs || [];
    activeWeek.value = '1';

    // 展示生成结果的关键信息
    const provider = res.meta.fallback ? '本地规则引擎' : `大模型（${res.meta.model}）`;
    ElMessage.success(`计划生成完成，用时 ${(res.elapsedMs / 1000).toFixed(1)}s，来源：${provider}`);
    await loadHistory();
  } finally {
    generating.value = false;
  }
}

/** 勾选 / 取消勾选动作（勾选时自动生成一条运动打卡） */
async function toggleItem(item, done) {
  const res = await api.togglePlanItem(item.id, { done, autoCheckin: done });
  item.done = done ? 1 : 0;
  if (done && res.checkin) {
    ElMessage.success(`已完成并自动打卡：${item.exercise_name}，消耗约 ${Math.round(res.checkin.calories)} kcal`);
  }
  await loadPlan(plan.value.id);
}

async function loadPlan(id) {
  const detail = await api.planDetail(id);
  plan.value = detail;
  aiMeta.value = detail.aiMeta;
  ragRefs.value = [];
  activeWeek.value = '1';
}

async function loadHistory() {
  history.value = await api.planList();
}

async function removePlan(id) {
  await api.deletePlan(id);
  ElMessage.success('已删除');
  if (plan.value?.id === id) plan.value = null;
  await loadHistory();
}

onMounted(async () => {
  await loadHistory();
  // 默认打开最近一份计划
  if (history.value.length) await loadPlan(history.value[0].id);

  // 用用户档案初始化表单
  if (store.user) {
    form.goal = store.user.goal || 'lose';
    form.daysPerWeek = store.user.weeklyTarget || 4;
  }
});
</script>

<style scoped>
/* ---------------- 方案说明（默认收起） ---------------- */
.plan-summary {
  margin-bottom: 10px;
  border-top: none;
  border-bottom: 1px solid #eef2f7;
}
.plan-summary :deep(.el-collapse-item__header) {
  height: 40px;
  border-bottom: none;
  gap: 8px;
}
.plan-summary :deep(.el-collapse-item__wrap) {
  border-bottom: none;
}
.ps-head {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
}
.ps-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-1);
}
.ps-sub {
  font-size: 11.5px;
  color: var(--text-3);
}

/* ---------------- AI 生成过程 ---------------- */
.stages {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}
.stage {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  background: linear-gradient(135deg, #f0fdf4, #ecfdf5);
  border: 1px solid #d1fae5;
}
.stage-dot {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--brand);
  color: #fff;
  font-size: 11px;
  font-weight: 800;
  display: grid;
  place-items: center;
}
.stage-body {
  flex: 1;
  min-width: 0;
}
.stage-name {
  font-size: 12.5px;
  font-weight: 700;
}
.stage-note {
  font-size: 10.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stage-ms {
  font-size: 10.5px;
  color: var(--brand-dark);
  font-weight: 700;
}

.refs {
  padding: 12px 14px;
  border-radius: 12px;
  background: #f8fafc;
  border: 1px dashed #cbd5e1;
}
.refs-title {
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 8px;
  color: var(--text-2);
}
.refs-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.warn-box {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  font-size: 12px;
  color: #92400e;
  line-height: 1.6;
}

/* ---------------- 计划正文 ---------------- */
.days {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 14px;
}
.day-card {
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
  background: #fff;
}
.day-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: #f8fafc;
  border-bottom: 1px solid var(--line);
}
.day-name {
  font-size: 13px;
  font-weight: 800;
}
.day-progress {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
}
.items {
  padding: 8px 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.item {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px 10px;
  border-radius: 10px;
  background: #fcfdfe;
  border: 1px solid #f1f5f9;
  transition: all 0.2s;
}
.item:hover {
  border-color: #d1fae5;
  background: #f0fdf4;
}
.item.done {
  opacity: 0.55;
  background: #f0fdf4;
}
.item.done .item-name {
  text-decoration: line-through;
}
.item-main {
  flex: 1;
  min-width: 0;
}
.item-name {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 2px;
}
.item-meta {
  font-size: 11px;
  color: var(--text-3);
}
.item-group {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 4px;
  background: #eef2ff;
  color: #4f46e5;
}
.item-note {
  font-size: 10.5px;
  color: #a16207;
  margin-top: 4px;
  line-height: 1.5;
}
</style>
