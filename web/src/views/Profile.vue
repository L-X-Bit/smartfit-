<!--
  个人中心
  ===============================================================
  ① 基础档案：性别、生日、身高、目标、每周训练天数（这些是 AI 生成方案的输入）
  ② AI 运行统计：真实的调用次数、平均耗时、缓存命中率、降级率
     —— 这是「AI 可观测性」的展示窗口，也是技术文档里数据指标的来源
  ③ 演示说明：账号信息与使用提示
-->
<template>
  <div class="grid" style="grid-template-columns: 1fr 1.1fr">
    <!-- ==================== ① 基础档案 ==================== -->
    <div class="card">
      <div class="card-title">
        <span>基础档案</span>
        <span class="sub">填写越完整，AI 建议越准确</span>
      </div>

      <div class="profile-head">
        <el-avatar :size="62" :src="store.avatar || undefined">{{ store.nickname.slice(0, 1) }}</el-avatar>
        <div>
          <div class="profile-name">{{ store.user?.nickname }}</div>
          <div class="text-muted">账号：{{ store.user?.username }} · 注册于 {{ store.user?.createdAt?.slice(0, 10) }}</div>
        </div>
      </div>

      <el-form :model="form" label-position="top" class="mt-16">
        <div class="grid grid-2">
          <el-form-item label="昵称">
            <el-input v-model="form.nickname" maxlength="20" />
          </el-form-item>
          <el-form-item label="性别">
            <el-select v-model="form.gender" style="width: 100%">
              <el-option label="男" value="male" />
              <el-option label="女" value="female" />
              <el-option label="不透露" value="unknown" />
            </el-select>
          </el-form-item>
        </div>

        <div class="grid grid-2">
          <el-form-item label="出生日期">
            <el-date-picker v-model="form.birthDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
          </el-form-item>
          <el-form-item label="身高（cm）">
            <el-input-number v-model="form.heightCm" :min="100" :max="250" :precision="1" style="width: 100%" />
          </el-form-item>
        </div>

        <div class="grid grid-2">
          <el-form-item label="健身目标">
            <el-select v-model="form.goal" style="width: 100%">
              <el-option label="减脂" value="lose" />
              <el-option label="增肌" value="gain" />
              <el-option label="塑形" value="shape" />
              <el-option label="保持健康" value="keep" />
            </el-select>
          </el-form-item>
          <el-form-item label="每周训练天数">
            <el-input-number v-model="form.weeklyTarget" :min="1" :max="7" style="width: 100%" />
          </el-form-item>
        </div>

        <el-button type="primary" class="btn-gradient" :loading="saving" @click="save">保存档案</el-button>
        <el-button @click="logout">退出登录</el-button>
      </el-form>
    </div>

    <div>
      <!-- ==================== ② AI 运行统计 ==================== -->
      <div class="card">
        <div class="card-title">
          <span>AI 运行统计</span>
          <span class="sub">最近 {{ stats.days || 7 }} 天 · 实时读取</span>
        </div>

        <div class="grid grid-2">
          <div class="stat-mini">
            <div class="sm-label">AI 调用次数</div>
            <div class="sm-value">{{ stats.totalCalls || 0 }}</div>
          </div>
          <div class="stat-mini">
            <div class="sm-label">平均耗时</div>
            <div class="sm-value">{{ stats.avgLatencyMs || 0 }}<span>ms</span></div>
          </div>
          <div class="stat-mini">
            <div class="sm-label">缓存命中率</div>
            <div class="sm-value">{{ Math.round((stats.cacheHitRate || 0) * 100) }}<span>%</span></div>
          </div>
          <div class="stat-mini">
            <div class="sm-label">降级率</div>
            <div class="sm-value">{{ Math.round((stats.fallbackRate || 0) * 100) }}<span>%</span></div>
          </div>
        </div>

        <el-table v-if="stats.byScene?.length" :data="stats.byScene" size="small" class="mt-16">
          <el-table-column label="场景" width="100">
            <template #default="{ row }">
              {{ { plan: '训练计划', coach: '教练对话', diet: '饮食配餐' }[row.scene] || row.scene }}
            </template>
          </el-table-column>
          <el-table-column prop="total" label="调用" width="70" />
          <el-table-column prop="cached" label="缓存" width="70" />
          <el-table-column prop="fallback" label="降级" width="70" />
          <el-table-column label="平均耗时" width="100">
            <template #default="{ row }">{{ row.avgLatencyMs }} ms</template>
          </el-table-column>
          <el-table-column prop="ragHits" label="RAG 命中" width="90" />
        </el-table>
        <el-empty v-else description="还没有 AI 调用记录，去生成一份计划吧" :image-size="60" />
      </div>

      <!-- ==================== ③ 平台信息 ==================== -->
      <div class="card mt-16">
        <div class="card-title"><span>平台信息</span></div>
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="AI 模式">
            <el-tag :type="aiStatus?.enabled ? 'success' : 'info'" size="small">
              {{ aiStatus?.enabled ? '大模型在线' : '离线知识库模式' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="模型">{{ aiStatus?.model || '-' }}</el-descriptions-item>
          <el-descriptions-item label="服务地址">{{ aiStatus?.provider || '-' }}</el-descriptions-item>
          <el-descriptions-item label="多模态识别">
            {{ aiStatus?.vision ? '已启用（拍照识别食物）' : '未启用' }}
          </el-descriptions-item>
          <el-descriptions-item label="语义缓存">
            {{ aiStatus?.cache ? `开启（当前 ${aiStatus.cache.size}/${aiStatus.cache.maxSize} 条）` : '关闭' }}
          </el-descriptions-item>
          <el-descriptions-item label="调用限流">{{ aiStatus?.rateLimitPerMin || 20 }} 次 / 分钟</el-descriptions-item>
        </el-descriptions>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useRouter } from 'vue-router';
import { api } from '@/api';
import { useUserStore } from '@/stores/user';

const store = useUserStore();
const router = useRouter();

const saving = ref(false);
const stats = ref({});
const aiStatus = ref(null);

const form = reactive({
  nickname: '',
  gender: 'unknown',
  birthDate: '',
  heightCm: 170,
  goal: 'keep',
  weeklyTarget: 3,
});

/** 保存档案 */
async function save() {
  saving.value = true;
  try {
    await api.updateProfile({ ...form });
    await store.refresh();
    ElMessage.success('档案已保存，AI 建议将基于最新档案生成');
  } finally {
    saving.value = false;
  }
}

function logout() {
  store.logout();
  router.push('/login');
}

onMounted(async () => {
  const me = await store.refresh();
  form.nickname = me.nickname;
  form.gender = me.gender || 'unknown';
  form.birthDate = me.birthDate || '';
  form.heightCm = me.heightCm || 170;
  form.goal = me.goal || 'keep';
  form.weeklyTarget = me.weeklyTarget || 3;

  const [s, status] = await Promise.all([api.aiStats(), api.aiStatus()]);
  stats.value = s;
  aiStatus.value = status;
});
</script>

<style scoped>
.profile-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px;
  border-radius: 12px;
  background: linear-gradient(135deg, #f0fdf4, #f8fafc);
  border: 1px solid #d1fae5;
}
.profile-name {
  font-size: 16px;
  font-weight: 800;
  margin-bottom: 3px;
}

.stat-mini {
  padding: 14px 16px;
  border-radius: 12px;
  background: #f8fafc;
  border: 1px solid var(--line);
}
.sm-label {
  font-size: 11.5px;
  color: var(--text-3);
  margin-bottom: 6px;
}
.sm-value {
  font-size: 22px;
  font-weight: 800;
  color: var(--text-1);
  letter-spacing: -0.5px;
}
.sm-value span {
  font-size: 11px;
  color: var(--text-3);
  margin-left: 2px;
}
</style>
