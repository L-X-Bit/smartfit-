<!--
  登录 / 注册页
  ---------------------------------------------------------------
  设计：左侧品牌区展示平台核心能力（也是演示视频的开场画面），
        右侧为登录表单，支持一键填入演示账号，方便评委快速体验。
-->
<template>
  <div class="login-page">
    <!-- ==================== 左侧品牌区 ==================== -->
    <section class="brand-side">
      <div class="brand-inner">
        <div class="brand-logo">💪 智练 SmartFit</div>
        <h1 class="brand-title">
          AI 驱动的<br />
          个人健康与运动管理平台
        </h1>
        <p class="brand-desc">
          融合大模型、AI Agent 与 RAG 知识库，为你生成真正「长在身上」的训练与饮食方案。
        </p>

        <ul class="feature-list">
          <li v-for="f in features" :key="f.title">
            <span class="feature-icon">{{ f.icon }}</span>
            <div>
              <div class="feature-title">{{ f.title }}</div>
              <div class="feature-desc">{{ f.desc }}</div>
            </div>
          </li>
        </ul>

        <div class="brand-foot">传智杯 · AI WEB 网页开发挑战赛参赛作品</div>
      </div>
      <!-- 装饰光斑 -->
      <div class="blob blob-1"></div>
      <div class="blob blob-2"></div>
    </section>

    <!-- ==================== 右侧表单区 ==================== -->
    <section class="form-side">
      <div class="form-box">
        <h2 class="form-title">{{ mode === 'login' ? '欢迎回来' : '创建账号' }}</h2>
        <p class="form-sub">{{ mode === 'login' ? '登录后开始记录你的每一次进步' : '注册即可体验全部 AI 功能' }}</p>

        <el-tabs v-model="mode" class="mode-tabs">
          <el-tab-pane label="登录" name="login" />
          <el-tab-pane label="注册" name="register" />
        </el-tabs>

        <el-form ref="formRef" :model="form" :rules="rules" label-position="top" size="large" @submit.prevent="onSubmit">
          <el-form-item label="账号" prop="username">
            <el-input v-model="form.username" placeholder="请输入账号" :prefix-icon="User" clearable />
          </el-form-item>

          <el-form-item v-if="mode === 'register'" label="昵称" prop="nickname">
            <el-input v-model="form.nickname" placeholder="给自己起个昵称" :prefix-icon="Avatar" clearable />
          </el-form-item>

          <el-form-item label="密码" prop="password">
            <el-input
              v-model="form.password"
              type="password"
              placeholder="请输入密码"
              :prefix-icon="Lock"
              show-password
              @keyup.enter="onSubmit"
            />
          </el-form-item>

          <el-button type="primary" class="submit-btn btn-gradient" :loading="loading" @click="onSubmit">
            {{ mode === 'login' ? '登 录' : '注 册 并 登 录' }}
          </el-button>
        </el-form>

        <div class="demo-tip">
          <span>演示账号：<b>demo</b> / <b>123456</b></span>
          <el-button link type="primary" @click="fillDemo">一键填入</el-button>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { User, Lock, Avatar } from '@element-plus/icons-vue';
import { useUserStore } from '@/stores/user';

const router = useRouter();
const route = useRoute();
const store = useUserStore();

const mode = ref('login');
const loading = ref(false);
const formRef = ref(null);

const form = reactive({ username: '', password: '', nickname: '' });

/** 表单校验规则 */
const rules = {
  username: [
    { required: true, message: '请输入账号', trigger: 'blur' },
    { min: 3, max: 20, message: '账号长度 3~20 位', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码至少 6 位', trigger: 'blur' },
  ],
  nickname: [{ required: true, message: '请输入昵称', trigger: 'blur' }],
};

const features = [
  { icon: '🤖', title: 'AI 健身教练', desc: '多阶段 Agent 编排，输入身体数据自动生成周计划' },
  { icon: '📚', title: 'RAG 知识库', desc: '动作库 + 训练指南检索增强，拒绝「编造动作」' },
  { icon: '📊', title: '数据可视化', desc: '体重趋势、热量收支、打卡热力图一目了然' },
  { icon: '🥗', title: '健康饮食配比', desc: '按目标热量自动核算三大营养素与一日餐单' },
];

/** 一键填入演示账号 */
function fillDemo() {
  mode.value = 'login';
  form.username = 'demo';
  form.password = '123456';
  ElMessage.success('已填入演示账号，点击登录即可');
}

/** 提交登录 / 注册 */
async function onSubmit() {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  loading.value = true;
  try {
    if (mode.value === 'login') {
      await store.login({ username: form.username, password: form.password });
      ElMessage.success(`欢迎回来，${store.nickname}！`);
    } else {
      await store.register({ username: form.username, password: form.password, nickname: form.nickname });
      ElMessage.success('注册成功，已自动登录');
    }
    router.push(route.query.redirect || '/dashboard');
  } catch {
    /* 错误提示已在 axios 拦截器统一处理 */
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-page {
  display: grid;
  grid-template-columns: 1.05fr 1fr;
  height: 100vh;
  background: #fff;
}
@media (max-width: 900px) {
  .login-page {
    grid-template-columns: 1fr;
  }
  .brand-side {
    display: none;
  }
}

/* ---------------- 左侧品牌区 ---------------- */
.brand-side {
  position: relative;
  overflow: hidden;
  background: linear-gradient(150deg, #064e3b 0%, #065f46 42%, #0f766e 100%);
  color: #ecfdf5;
  display: flex;
  align-items: center;
  padding: 56px 64px;
}
.brand-inner {
  position: relative;
  z-index: 2;
  max-width: 480px;
}
.brand-logo {
  font-size: 17px;
  font-weight: 800;
  letter-spacing: 0.5px;
  margin-bottom: 32px;
}
.brand-title {
  font-size: 38px;
  line-height: 1.28;
  font-weight: 800;
  margin: 0 0 18px;
  letter-spacing: -0.5px;
}
.brand-desc {
  font-size: 14px;
  line-height: 1.8;
  color: rgba(236, 253, 245, 0.78);
  margin: 0 0 34px;
}
.feature-list {
  list-style: none;
  padding: 0;
  margin: 0 0 40px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.feature-list li {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}
.feature-icon {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.12);
  display: grid;
  place-items: center;
  font-size: 18px;
  backdrop-filter: blur(6px);
}
.feature-title {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 3px;
}
.feature-desc {
  font-size: 12px;
  color: rgba(236, 253, 245, 0.62);
  line-height: 1.55;
}
.brand-foot {
  font-size: 11.5px;
  color: rgba(236, 253, 245, 0.45);
  letter-spacing: 0.5px;
}

/* 装饰光斑 */
.blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(70px);
  opacity: 0.4;
}
.blob-1 {
  width: 380px;
  height: 380px;
  background: #34d399;
  right: -120px;
  top: -100px;
}
.blob-2 {
  width: 300px;
  height: 300px;
  background: #22d3ee;
  left: -100px;
  bottom: -110px;
  opacity: 0.28;
}

/* ---------------- 右侧表单区 ---------------- */
.form-side {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
}
.form-box {
  width: 100%;
  max-width: 380px;
}
.form-title {
  font-size: 26px;
  font-weight: 800;
  margin: 0 0 6px;
  letter-spacing: -0.4px;
}
.form-sub {
  font-size: 13px;
  color: var(--text-3);
  margin: 0 0 6px;
}
.mode-tabs {
  margin-bottom: 6px;
}
.submit-btn {
  width: 100%;
  height: 46px;
  font-size: 15px;
  letter-spacing: 1px;
  margin-top: 4px;
}
.demo-tip {
  margin-top: 20px;
  padding: 12px 14px;
  border-radius: 12px;
  background: #f8fafc;
  border: 1px dashed #cbd5e1;
  font-size: 12.5px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.demo-tip b {
  color: var(--brand-dark);
}
</style>
