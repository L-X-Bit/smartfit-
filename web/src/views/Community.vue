<!--
  运动社区页
  ===============================================================
  功能：
    ① 发帖：文字 + 图片（前端 canvas 压缩后 base64 上传）+ 话题 + 关联今日打卡
    ② 信息流：热门（时间衰减热度分）/ 最新 两种排序 + 话题筛选
    ③ 互动：点赞（乐观更新）、评论（展开/收起）
    ④ 本周打卡排行榜：社区激励
  讲解要点（社区设计亮点）：
    · 热度分 = 点赞×3 + 评论×5 + 基础 6，再乘时间衰减因子（每 24h 衰减 10%），
      既能形成「新内容优先」的信息流节奏，又避免旧帖长期霸榜；
    · 点赞用 (post_id, user_id) 联合主键，天然防重复；
    · 分享打卡会自动带出「运动数据卡片」，这是健康社区区别于普通论坛的关键设计。
-->
<template>
  <div class="grid" style="grid-template-columns: 1fr 300px">
    <!-- ==================== 左侧：发布 + 信息流 ==================== -->
    <div>
      <!-- 发布框 -->
      <div class="card">
        <div class="publish-head">
          <el-avatar :size="34" :src="store.avatar || undefined">{{ store.nickname.slice(0, 1) }}</el-avatar>
          <el-input v-model="form.content" type="textarea" :rows="3" resize="none" maxlength="1000" show-word-limit placeholder="今天练了什么？分享一下你的打卡心得吧～" />
        </div>

        <div v-if="form.images.length" class="image-preview">
          <div v-for="(img, i) in form.images" :key="i" class="preview-item">
            <img :src="img" alt="预览" />
            <span class="remove" @click="form.images.splice(i, 1)">×</span>
          </div>
        </div>

        <div class="publish-foot">
          <div class="row">
            <!-- 图片上传：压缩后以 base64 提交（见 utils 说明） -->
            <el-upload :show-file-list="false" :before-upload="handleUpload" accept="image/*">
              <el-button size="small" :icon="Picture">图片</el-button>
            </el-upload>

            <el-select v-model="form.topic" placeholder="选择话题" size="small" clearable style="width: 130px">
              <el-option v-for="t in topicOptions" :key="t" :label="t" :value="t" />
            </el-select>

            <el-select v-model="form.workoutLogId" placeholder="关联今日打卡" size="small" clearable style="width: 170px">
              <el-option
                v-for="log in todayLogs"
                :key="log.id"
                :label="`${log.exerciseName} ${Math.round(log.durationMin)}分/${log.calories}kcal`"
                :value="log.id"
              />
            </el-select>
          </div>

          <el-button type="primary" class="btn-gradient" size="default" :loading="publishing" @click="publish">发布</el-button>
        </div>
      </div>

      <!-- 排序 + 话题 -->
      <div class="filter-bar">
        <el-radio-group v-model="sort" size="small" @change="loadPosts">
          <el-radio-button value="hot">🔥 热门</el-radio-button>
          <el-radio-button value="new">🕐 最新</el-radio-button>
        </el-radio-group>

        <div class="topic-tags">
          <span class="topic-tag" :class="{ active: !activeTopic }" @click="filterTopic(null)">全部</span>
          <span
            v-for="t in topics"
            :key="t.topic"
            class="topic-tag"
            :class="{ active: activeTopic === t.topic }"
            @click="filterTopic(t.topic)"
          >
            #{{ t.topic }}
          </span>
        </div>
      </div>

      <!-- 帖子列表 -->
      <div v-loading="loading">
        <div v-for="post in posts" :key="post.id" class="card post-card">
          <div class="post-head">
            <el-avatar :size="36" :src="post.author.avatar || undefined">{{ post.author.nickname.slice(0, 1) }}</el-avatar>
            <div class="post-author">
              <div class="name">{{ post.author.nickname }}</div>
              <div class="time">{{ dayjsLike.formatTime(post.createdAt) }}</div>
            </div>
            <el-tag v-if="post.topic" size="small" effect="plain" class="post-topic">#{{ post.topic }}</el-tag>
            <el-popconfirm v-if="post.author.id === store.user?.id" title="删除这条动态？" @confirm="removePost(post.id)">
              <template #reference>
                <el-button link type="danger" :icon="Delete" class="del-btn" />
              </template>
            </el-popconfirm>
          </div>

          <div class="post-content">{{ post.content }}</div>

          <!-- 关联打卡数据卡片 -->
          <div v-if="post.workout" class="workout-card">
            <span class="wc-icon">🏃</span>
            <div>
              <div class="wc-name">{{ post.workout.exerciseName }}</div>
              <div class="wc-meta">{{ Math.round(post.workout.durationMin) }} 分钟 · 消耗 {{ post.workout.calories }} kcal</div>
            </div>
          </div>

          <div v-if="post.images.length" class="post-images" :class="`n-${Math.min(post.images.length, 3)}`">
            <img v-for="(img, i) in post.images" :key="i" :src="img" alt="打卡图片" />
          </div>

          <div class="post-actions">
            <button class="action-btn" :class="{ liked: post.liked }" @click="toggleLike(post)">
              <el-icon><Star /></el-icon>
              {{ post.liked ? '已赞' : '点赞' }} {{ post.likeCount || '' }}
            </button>
            <button class="action-btn" @click="toggleComments(post)">
              <el-icon><ChatDotRound /></el-icon>
              评论 {{ post.commentCount || '' }}
            </button>
          </div>

          <!-- 评论区 -->
          <div v-if="expanded[post.id]" class="comments">
            <div v-for="c in commentsMap[post.id] || []" :key="c.id" class="comment">
              <el-avatar :size="24" :src="c.author.avatar || undefined">{{ c.author.nickname.slice(0, 1) }}</el-avatar>
              <div class="comment-body">
                <span class="comment-name">{{ c.author.nickname }}</span>
                <span class="comment-text">{{ c.content }}</span>
              </div>
            </div>

            <div class="comment-input">
              <el-input v-model="commentDraft[post.id]" placeholder="友善评论，干货交流～" size="small" @keyup.enter="submitComment(post)" />
              <el-button size="small" type="primary" @click="submitComment(post)">发送</el-button>
            </div>
          </div>
        </div>

        <el-empty v-if="!loading && !posts.length" description="还没有动态，来发布第一条吧" />

        <div v-if="hasMore" class="load-more">
          <el-button :loading="loading" @click="loadMore">加载更多</el-button>
        </div>
      </div>
    </div>

    <!-- ==================== 右侧：排行榜 + 话题 ==================== -->
    <div class="side">
      <div class="card">
        <div class="card-title"><span>🏆 本周打卡榜</span></div>
        <div class="rank-list">
          <div v-for="r in leaderboard" :key="r.id" class="rank-item">
            <span class="rank-no" :class="`n${r.rank}`">{{ r.rank }}</span>
            <el-avatar :size="28" :src="r.avatar || undefined">{{ r.nickname.slice(0, 1) }}</el-avatar>
            <div class="rank-info">
              <div class="rank-name">{{ r.nickname }}</div>
              <div class="rank-meta">{{ r.times }} 次 · {{ Math.round(r.minutes) }} 分钟</div>
            </div>
            <span class="rank-kcal">{{ Math.round(r.calories) }} kcal</span>
          </div>
          <el-empty v-if="!leaderboard.length" description="本周还没有人打卡" :image-size="60" />
        </div>
      </div>

      <div class="card mt-16">
        <div class="card-title"><span>热门话题</span></div>
        <div class="topic-list">
          <div v-for="t in topics" :key="t.topic" class="topic-row" @click="filterTopic(t.topic)">
            <span>#{{ t.topic }}</span>
            <span class="topic-count">{{ t.c }} 条</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Picture, Delete, Star, ChatDotRound } from '@element-plus/icons-vue';
import dayjsLike from '@/utils/date';
import { api } from '@/api';
import { useUserStore } from '@/stores/user';

const store = useUserStore();

const posts = ref([]);
const topics = ref([]);
const leaderboard = ref([]);
const loading = ref(false);
const publishing = ref(false);
const sort = ref('hot');
const activeTopic = ref(null);
const page = ref(1);
const hasMore = ref(false);
const todayLogs = ref([]);

const expanded = reactive({}); // postId -> bool
const commentsMap = reactive({}); // postId -> comments
const commentDraft = reactive({}); // postId -> string

const topicOptions = ['减脂日记', '增肌记录', '塑形打卡', '跑步日常', '健身干货', '健康饮食'];

const form = reactive({ content: '', images: [], topic: '', workoutLogId: null });

/** 图片上传：前端压缩后 base64 传给后端落盘，返回可访问 URL */
async function handleUpload(file) {
  if (file.size > 8 * 1024 * 1024) {
    ElMessage.warning('图片请小于 8MB');
    return false;
  }
  const dataUrl = await compressImage(file);
  const res = await api.uploadImage(dataUrl);
  form.images.push(res.url);
  ElMessage.success('图片已上传');
  return false; // 阻止 el-upload 自动上传
}

/** 用 canvas 把图片压到最大边 1000px、质量 0.82，减小体积 */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1000;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** 发布动态 */
async function publish() {
  if (!form.content.trim()) {
    ElMessage.warning('说点什么吧');
    return;
  }
  publishing.value = true;
  try {
    await api.createPost({
      content: form.content,
      images: form.images,
      topic: form.topic || undefined,
      workoutLogId: form.workoutLogId || undefined,
    });
    ElMessage.success('发布成功！');
    form.content = '';
    form.images = [];
    form.topic = '';
    form.workoutLogId = null;
    page.value = 1;
    await loadPosts();
  } finally {
    publishing.value = false;
  }
}

/** 拉取帖子 */
async function loadPosts(append = false) {
  loading.value = true;
  try {
    const res = await api.posts({ sort: sort.value, page: page.value, size: 10, topic: activeTopic.value || undefined });
    posts.value = append ? [...posts.value, ...res.list] : res.list;
    topics.value = res.topics || [];
    hasMore.value = posts.value.length < res.total;
  } finally {
    loading.value = false;
  }
}

function loadMore() {
  page.value += 1;
  loadPosts(true);
}

function filterTopic(topic) {
  activeTopic.value = topic;
  page.value = 1;
  loadPosts();
}

/** 点赞（乐观更新，失败回滚由拦截器提示） */
async function toggleLike(post) {
  const before = { liked: post.liked, likeCount: post.likeCount };
  post.liked = !post.liked;
  post.likeCount += post.liked ? 1 : -1;
  try {
    const res = await api.likePost(post.id);
    post.liked = res.liked;
    post.likeCount = res.likeCount;
  } catch {
    post.liked = before.liked;
    post.likeCount = before.likeCount;
  }
}

/** 展开 / 收起评论 */
async function toggleComments(post) {
  if (expanded[post.id]) {
    expanded[post.id] = false;
    return;
  }
  expanded[post.id] = true;
  commentsMap[post.id] = await api.comments(post.id);
}

/** 提交评论 */
async function submitComment(post) {
  const content = (commentDraft[post.id] || '').trim();
  if (!content) return;
  const res = await api.addComment(post.id, { content });
  commentDraft[post.id] = '';
  post.commentCount = res.commentCount;
  commentsMap[post.id] = await api.comments(post.id);
}

async function removePost(id) {
  await api.deletePost(id);
  ElMessage.success('已删除');
  await loadPosts();
}

onMounted(async () => {
  await loadPosts();
  leaderboard.value = await api.leaderboard();
  const logs = await api.checkinLogs({ from: dayjsLike.today(), to: dayjsLike.today() });
  todayLogs.value = logs;
});
</script>

<style scoped>
/* ---------------- 发布框 ---------------- */
.publish-head {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}
.image-preview {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.preview-item {
  position: relative;
  width: 76px;
  height: 76px;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--line);
}
.preview-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.preview-item .remove {
  position: absolute;
  right: 2px;
  top: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: rgba(15, 23, 42, 0.65);
  color: #fff;
  font-size: 12px;
  line-height: 15px;
  text-align: center;
  cursor: pointer;
}
.publish-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* ---------------- 筛选条 ---------------- */
.filter-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 16px 0 12px;
  flex-wrap: wrap;
}
.topic-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.topic-tag {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  background: #fff;
  border: 1px solid var(--line);
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.2s;
}
.topic-tag:hover,
.topic-tag.active {
  background: #ecfdf5;
  border-color: #a7f3d0;
  color: var(--brand-dark);
  font-weight: 600;
}

/* ---------------- 帖子 ---------------- */
.post-card {
  margin-bottom: 14px;
}
.post-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.post-author .name {
  font-size: 13.5px;
  font-weight: 700;
}
.post-author .time {
  font-size: 11px;
  color: var(--text-3);
}
.post-topic {
  margin-left: auto;
}
.del-btn {
  margin-left: 4px;
}
.post-content {
  font-size: 13.5px;
  line-height: 1.8;
  color: var(--text-1);
  white-space: pre-wrap;
  margin-bottom: 12px;
}

.workout-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  background: linear-gradient(135deg, #ecfdf5, #f0fdfa);
  border: 1px solid #d1fae5;
  margin-bottom: 12px;
}
.wc-icon {
  font-size: 22px;
}
.wc-name {
  font-size: 13px;
  font-weight: 700;
  color: #065f46;
}
.wc-meta {
  font-size: 11.5px;
  color: #059669;
  margin-top: 2px;
}

.post-images {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
}
.post-images.n-1 img {
  max-height: 320px;
  width: auto;
  border-radius: 12px;
}
.post-images.n-2 {
  grid-template-columns: 1fr 1fr;
}
.post-images.n-3 {
  grid-template-columns: repeat(3, 1fr);
}
.post-images img {
  width: 100%;
  height: 100%;
  max-height: 220px;
  object-fit: cover;
  border-radius: 10px;
}

.post-actions {
  display: flex;
  gap: 8px;
  border-top: 1px solid #f1f5f9;
  padding-top: 10px;
}
.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: #f8fafc;
  color: var(--text-2);
  font-size: 12.5px;
  padding: 6px 14px;
  border-radius: 999px;
  cursor: pointer;
  transition: all 0.2s;
}
.action-btn:hover {
  background: #ecfdf5;
  color: var(--brand-dark);
}
.action-btn.liked {
  background: #fef2f2;
  color: #dc2626;
  font-weight: 700;
}

/* ---------------- 评论区 ---------------- */
.comments {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--line);
}
.comment {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
.comment-body {
  font-size: 12.5px;
  line-height: 1.6;
  background: #f8fafc;
  padding: 7px 11px;
  border-radius: 10px;
  flex: 1;
}
.comment-name {
  font-weight: 700;
  color: var(--brand-dark);
  margin-right: 6px;
}
.comment-text {
  color: var(--text-1);
}
.comment-input {
  display: flex;
  gap: 8px;
}

.load-more {
  text-align: center;
  padding: 8px 0 20px;
}

/* ---------------- 侧栏 ---------------- */
.side {
  position: sticky;
  top: 0;
  align-self: start;
}
.rank-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rank-item {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rank-no {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 800;
  background: #f1f5f9;
  color: var(--text-3);
}
.rank-no.n1 {
  background: linear-gradient(135deg, #fbbf24, #f59e0b);
  color: #fff;
}
.rank-no.n2 {
  background: linear-gradient(135deg, #cbd5e1, #94a3b8);
  color: #fff;
}
.rank-no.n3 {
  background: linear-gradient(135deg, #fdba74, #fb923c);
  color: #fff;
}
.rank-info {
  flex: 1;
  min-width: 0;
}
.rank-name {
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rank-meta {
  font-size: 10.5px;
  color: var(--text-3);
}
.rank-kcal {
  font-size: 11.5px;
  font-weight: 700;
  color: #f59e0b;
}

.topic-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.topic-row {
  display: flex;
  justify-content: space-between;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 12.5px;
  color: var(--text-2);
  cursor: pointer;
  transition: background 0.2s;
}
.topic-row:hover {
  background: #f0fdf4;
  color: var(--brand-dark);
}
.topic-count {
  color: var(--text-3);
  font-size: 11px;
}
</style>
