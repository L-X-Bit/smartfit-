<!--
  AI 健身教练（流式对话）
  ===============================================================
  这是「AI 原生 Web 应用」体验的核心页面，技术要点：
    ① SSE 流式输出：后端逐 token 推送，前端边收边渲染 → 首字延迟 < 1 秒，
       打字机效果比「等 8 秒一次性出来」体验好一个数量级；
    ② RAG 引用可解释：每条回答下方展示引用的知识库条目，用户可验证依据；
    ③ 上下文个性化：右侧展示注入给模型的「用户实时数据快照」，
       让评委直观看到「AI 为什么答得准」；
    ④ 降级提示：未配置大模型时，自动切换为「离线知识库检索式问答」并在气泡上标注。
-->
<template>
  <div class="coach-page">
    <!-- ==================== 左侧：对话区 ==================== -->
    <div class="chat-card card">
      <div class="chat-head">
        <div class="row">
          <div class="coach-avatar">🤖</div>
          <div>
            <div class="coach-name">小智 · AI 健身教练</div>
            <div class="coach-status">
              <span class="dot" :class="{ on: aiOnline }"></span>
              {{ aiOnline ? `已接入大模型（${aiStatus?.model}）· RAG 知识库增强` : '离线知识库模式 · 检索式问答' }}
            </div>
          </div>
        </div>
        <div class="row">
          <el-button size="small" :icon="Delete" @click="clearHistory">清空</el-button>
        </div>
      </div>

      <!-- 消息列表 -->
      <div ref="scrollRef" class="chat-body">
        <!-- 欢迎语 -->
        <div v-if="!messages.length" class="welcome">
          <div class="welcome-emoji">🏋️</div>
          <div class="welcome-title">你好，我是你的 AI 健身教练</div>
          <div class="welcome-desc">
            我可以结合你的身体数据、训练记录与饮食情况，给出可执行的建议。<br />
            试试下面的问题：
          </div>
          <div class="quick-list">
            <div v-for="q in quickQuestions" :key="q" class="quick-item" @click="ask(q)">{{ q }}</div>
          </div>
        </div>

        <!-- 对话气泡 -->
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <div class="msg-avatar">{{ m.role === 'user' ? '👤' : '🤖' }}</div>
          <div class="msg-main">
            <div class="bubble" :class="{ typing: m.streaming }">
              <!-- 用 v-html 渲染简单 Markdown（后端输出含 **加粗** 与换行） -->
              <div class="bubble-text" v-html="renderMarkdown(m.content)"></div>
            </div>

            <!-- RAG 引用 -->
            <div v-if="m.refs?.length" class="msg-refs">
              <span class="refs-label">📚 引用</span>
              <el-tag v-for="r in m.refs.slice(0, 6)" :key="r.id" size="small" effect="plain" :type="refType(r.type)">
                {{ r.title }}
              </el-tag>
            </div>

            <div v-if="m.provider === 'fallback'" class="msg-note">⚙️ 本条由离线知识库（RAG 检索）生成</div>
          </div>
        </div>
      </div>

      <!-- 输入区 -->
      <div class="chat-input">
        <el-input
          v-model="question"
          type="textarea"
          :rows="2"
          resize="none"
          placeholder="描述你的问题，例如：我想减脂但膝盖有伤，应该怎么练？"
          maxlength="500"
          @keydown.enter.exact.prevent="ask()"
        />
        <div class="input-foot">
          <span class="text-muted">Enter 发送 · Shift+Enter 换行 · 回答仅供参考，不构成医疗建议</span>
          <el-button type="primary" class="btn-gradient" :loading="sending" :icon="Promotion" @click="ask()">发送</el-button>
        </div>
      </div>
    </div>

    <!-- ==================== 右侧：上下文面板 ==================== -->
    <div class="side">
      <div class="card">
        <div class="card-title">
          <span>注入给 AI 的数据快照</span>
          <span class="ai-chip">实时</span>
        </div>
        <pre class="snapshot">{{ snapshotText || '加载中…' }}</pre>
        <div class="text-muted" style="margin-top: 8px">
          上面这段文本会随问题一起发送给大模型，让回答「长在你的数据上」。
        </div>
      </div>

      <div class="card mt-16">
        <div class="card-title"><span>推荐提问</span></div>
        <div class="quick-list side-quick">
          <div v-for="q in quickQuestions" :key="q" class="quick-item" @click="ask(q)">{{ q }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { nextTick, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Delete, Promotion } from '@element-plus/icons-vue';
import { api, streamCoach } from '@/api';
import { useUserStore } from '@/stores/user';

const store = useUserStore();
const messages = ref([]);
const question = ref('');
const sending = ref(false);
const scrollRef = ref(null);
const snapshotText = ref('');
const aiStatus = ref(null);

const aiOnline = ref(false);

const quickQuestions = [
  '我想减脂，但膝盖有旧伤，怎么安排训练？',
  '训练后肌肉酸痛正常吗？需要休息几天？',
  '每天要吃多少蛋白质？怎么分配？',
  '平台期一个月没变化，怎么突破？',
  '帮我看看这周的打卡安排是否合理？',
];

function refType(type) {
  return { guide: 'success', exercise: 'primary', food: 'warning' }[type] || 'info';
}

/** 极简 Markdown 渲染：只处理 **加粗**、换行、> 引用，避免引入额外依赖 */
function renderMarkdown(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^&gt; (.*)$/gm, '<span class="quote">$1</span>')
    .replace(/\n/g, '<br/>');
}

/** 滚动到底部 */
async function scrollToBottom() {
  await nextTick();
  const el = scrollRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

/** 发送问题（流式接收回答） */
async function ask(preset) {
  const q = (preset || question.value).trim();
  if (!q || sending.value) return;

  messages.value.push({ role: 'user', content: q });
  question.value = '';
  const assistant = { role: 'assistant', content: '', refs: [], streaming: true, provider: 'llm' };
  messages.value.push(assistant);
  await scrollToBottom();

  sending.value = true;
  try {
    await streamCoach(q, {
      onMeta: (meta) => {
        assistant.provider = meta.ai?.enabled ? 'llm' : 'fallback';
      },
      onDelta: (text) => {
        assistant.content += text;
        scrollToBottom();
      },
      onDone: (info) => {
        assistant.streaming = false;
        assistant.refs = info.refs || [];
        assistant.provider = info.provider || 'llm';
        scrollToBottom();
      },
      onError: (msg) => {
        assistant.streaming = false;
        assistant.content = assistant.content || `⚠️ ${msg}`;
        ElMessage.error(msg);
      },
    });
  } catch (err) {
    assistant.streaming = false;
    assistant.content = assistant.content || `⚠️ 请求失败：${err.message}`;
  } finally {
    assistant.streaming = false;
    sending.value = false;
    await scrollToBottom();
  }
}

/** 清空历史 */
async function clearHistory() {
  await api.clearAiHistory();
  messages.value = [];
  ElMessage.success('对话已清空');
}

onMounted(async () => {
  const [status, history, suggestion] = await Promise.all([api.aiStatus(), api.aiHistory(), api.aiSuggestions()]);
  aiStatus.value = status;
  aiOnline.value = Boolean(status?.enabled);
  snapshotText.value = suggestion?.snapshot?.text || '';

  // 展示最近 10 条历史对话
  messages.value = (history || []).slice(-10).map((m) => ({
    role: m.role,
    content: m.content,
    refs: m.refs || [],
    provider: 'llm',
  }));
  await scrollToBottom();
});
</script>

<style scoped>
.coach-page {
  display: grid;
  grid-template-columns: 1fr 330px;
  gap: 16px;
  height: calc(100vh - 130px);
}
@media (max-width: 1100px) {
  .coach-page {
    grid-template-columns: 1fr;
    height: auto;
  }
  .side {
    display: none;
  }
}

/* ---------------- 对话卡片 ---------------- */
.chat-card {
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
  height: 100%;
}
.chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(120deg, #f0fdf4, #ffffff);
}
.coach-avatar {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: linear-gradient(135deg, #10b981, #059669);
  display: grid;
  place-items: center;
  font-size: 20px;
  box-shadow: 0 6px 16px rgba(16, 185, 129, 0.3);
}
.coach-name {
  font-size: 14px;
  font-weight: 800;
}
.coach-status {
  font-size: 11px;
  color: var(--text-3);
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 2px;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #cbd5e1;
}
.dot.on {
  background: #10b981;
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.18);
}

/* ---------------- 消息区 ---------------- */
.chat-body {
  flex: 1;
  overflow-y: auto;
  padding: 18px;
  background: #fbfdff;
}

.welcome {
  text-align: center;
  padding: 30px 20px;
}
.welcome-emoji {
  font-size: 42px;
  margin-bottom: 10px;
}
.welcome-title {
  font-size: 17px;
  font-weight: 800;
  margin-bottom: 8px;
}
.welcome-desc {
  font-size: 12.5px;
  color: var(--text-3);
  line-height: 1.8;
  margin-bottom: 18px;
}

.quick-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}
.side-quick {
  justify-content: flex-start;
  flex-direction: column;
}
.quick-item {
  padding: 8px 12px;
  border-radius: 10px;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.2s;
}
.quick-item:hover {
  background: #ecfdf5;
  border-color: #a7f3d0;
  color: var(--brand-dark);
  transform: translateY(-1px);
}

.msg {
  display: flex;
  gap: 10px;
  margin-bottom: 18px;
}
.msg.user {
  flex-direction: row-reverse;
}
.msg-avatar {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: 10px;
  background: #eef2f7;
  display: grid;
  place-items: center;
  font-size: 15px;
}
.msg.user .msg-avatar {
  background: #dbeafe;
}
.msg-main {
  max-width: 76%;
}
.msg.user .msg-main {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.bubble {
  padding: 12px 15px;
  border-radius: 14px;
  background: #fff;
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
  font-size: 13.5px;
  line-height: 1.75;
  color: var(--text-1);
  word-break: break-word;
}
.msg.user .bubble {
  background: linear-gradient(135deg, #10b981, #059669);
  border: none;
  color: #fff;
}
.bubble.typing::after {
  content: '▋';
  color: var(--brand);
  animation: blink 1s step-end infinite;
}
.bubble-text :deep(.quote) {
  display: block;
  padding: 6px 10px;
  margin: 6px 0;
  border-left: 3px solid #fbbf24;
  background: #fffbeb;
  color: #92400e;
  border-radius: 0 6px 6px 0;
  font-size: 12.5px;
}

.msg-refs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  margin-top: 7px;
}
.refs-label {
  font-size: 10.5px;
  color: var(--text-3);
}
.msg-note {
  margin-top: 6px;
  font-size: 10.5px;
  color: var(--text-3);
}

/* ---------------- 输入区 ---------------- */
.chat-input {
  padding: 12px 16px 14px;
  border-top: 1px solid var(--line);
  background: #fff;
}
.input-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}

/* ---------------- 右侧面板 ---------------- */
.side {
  overflow-y: auto;
}
.snapshot {
  margin: 0;
  padding: 12px;
  border-radius: 10px;
  background: #0f172a;
  color: #a7f3d0;
  font-size: 11px;
  line-height: 1.75;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: 'Consolas', 'Menlo', monospace;
  max-height: 320px;
  overflow-y: auto;
}

/* ---------------- 移动端：对话区占满一屏，气泡更宽 ---------------- */
@media (max-width: 900px) {
  /* 用 dvh 让手机浏览器地址栏收起/展开时高度自适应；vh 作为旧浏览器兜底 */
  .coach-page {
    height: calc(100vh - 108px);
    height: calc(100dvh - 108px);
  }
  .chat-card {
    height: 100%;
  }
  .chat-body {
    padding: 12px;
  }
  .welcome {
    padding: 18px 8px;
  }
  .welcome-emoji {
    font-size: 34px;
  }
  .msg-main {
    max-width: 86%;
  }
  .bubble {
    font-size: 13px;
    padding: 10px 12px;
  }
  .chat-input {
    padding: 10px 12px 12px;
  }
}
</style>
