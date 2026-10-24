<!--
  AI 拍照识热量（多模态独立板块）
  ===============================================================
  这是继「文本大模型」之后的第二种模态能力：图片 → 结构化营养数据。

  页面结构：
    ① 上传区：点击 / 拖拽 / 手机拍照（capture 属性直调后置摄像头）
    ② 识别结果：食物清单（可改份量、显示数据来源）+ 合计 + AI 建议 + 一键记入饮食
    ③ 识别历史：每次识别的原图与结果都留存，可随时回看、重新记入

  工程要点（讲解可展开）：
    · 前端 canvas 压缩（最长边 1280px）后再上传，避免大图拖慢识别、浪费额度；
    · 识别结果里每一项都标注数据来源：「库内精确」= 用本地食物库值换算，
      「模型估算」= 食物库没收录，用模型给的数值——绝不把两种数据混在一起偷偷用；
    · 库值与模型估算相差超过 3 倍时判定为「误匹配」，弃用库值并标红提示（例如「面汤」不能按「意面」算）；
    · 识别结果全部落库（food_scans 表），支持历史回溯与「稍后再记」。
-->
<template>
  <div v-loading="pageLoading">
    <!-- ==================== 顶部功能区 ==================== -->
    <div class="card hero">
      <div class="hero-left">
        <div class="hero-title">📷 AI 拍照识热量</div>
        <div class="hero-desc">
          上传或拍一张饭菜照片，多模态 AI 自动识别食物种类与份量，并与本地食物营养库匹配后换算热量
        </div>
        <div class="hero-chips">
          <span class="ai-chip" :class="{ off: !cap.visionEnabled }">
            {{ cap.visionEnabled ? `多模态 AI · ${cap.model}` : '未启用视觉模型' }}
          </span>
          <el-tag v-if="cap.visionEnabled" size="small" effect="plain" type="success">已识别 {{ history.length }} 次</el-tag>
          <el-tag v-else size="small" effect="plain" type="warning">
            在 server/.env 配置 AI_VISION_MODEL 后即可使用
          </el-tag>
        </div>
      </div>

      <div class="hero-stats">
        <div class="hs-item">
          <div class="hs-label">今日目标</div>
          <div class="hs-value">{{ cap.todayTarget }} <span>kcal</span></div>
        </div>
        <div class="hs-item">
          <div class="hs-label">已摄入</div>
          <div class="hs-value">{{ cap.todayIntake }} <span>kcal</span></div>
        </div>
        <div class="hs-item highlight">
          <div class="hs-label">剩余可摄入</div>
          <div class="hs-value">{{ cap.todayRemaining }} <span>kcal</span></div>
        </div>
      </div>
    </div>

    <div class="grid mt-16" style="grid-template-columns: 1fr 1.25fr">
      <!-- ==================== ① 上传区 ==================== -->
      <div class="card">
        <div class="card-title">
          <span>① 上传食物照片</span>
          <span class="sub">jpg / png / webp · 自动压缩</span>
        </div>

        <!--
          微信内置浏览器专用提示
          ------------------------------------------------------------------
          iPhone 在微信里点开链接时，**拍照和选图都调不起来**——这是微信 iOS 内置浏览器的
          限制（它忽略 capture 属性，对隐藏/包装过的 file input 也不放行），任何网页都绕不过去，
          不是我们代码没写好。所以这里直接告诉用户正确做法（在浏览器中打开），
          并给两个兜底：复制链接、微信里对"原生可见的文件输入"宽容性更高。
        -->
        <div v-if="isWeChat" class="wx-tip">
          <div class="wx-title">⚠️ 你正在微信里打开这个页面</div>
          <div class="wx-body">
            微信内置浏览器不支持网页拍照/选图（iOS 上表现为「点了没反应」）。
            请点右上角 <b>「···」→「在浏览器打开」</b>，就能正常拍照和选图。
            <br />
            如果仍不行，检查手机 <b>设置 → 微信 → 照片</b> 是否允许访问所有照片。
          </div>
          <div class="wx-actions">
            <button type="button" class="pick-btn primary" @click="copyPageLink">复制本页链接</button>
            <span class="wx-hint">复制后粘到 Safari / Chrome 打开</span>
          </div>
          <div class="wx-native">
            <span>微信内也可以先试系统原生选择：</span>
            <input type="file" accept="image/*" class="wx-file" @change="onFileChange" />
          </div>
        </div>

        <!-- 未选择图片：拖拽/点击上传 -->
        <div
          v-if="!preview"
          class="drop-zone"
          :class="{ dragging }"
          @click="openPicker('album')"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="onDrop"
        >
          <div class="drop-icon">🍱</div>
          <div class="drop-title" @click.stop="openPicker('album')">点击选择照片，或把图片拖到这里</div>
          <div class="drop-desc">手机端可直接调用相机拍照</div>

          <!--
            两个原生文件输入：一个带 capture（直接开相机），一个不带（开相册/文件管理）
            ------------------------------------------------------------------
            为什么要两个、而且用 <label for> 而不是 JS 去 click 一个隐藏 input：
            踩过的坑 —— 手机上点「从相册选择」没反应。原因有三层：
              ① 原来的 input 是 display:none，微信 / 夸克 / UC 这类内核会拒绝为隐藏输入
                 打开选择器（表现为点了完全没反应）；
              ② 原来靠 JS 在点击瞬间切换 capture 属性，部分浏览器不生效，仍然只弹相机；
              ③ JS 的 input.click() 在丢失用户手势（中间有 await）时会静默失败。
            改成「两个真实 input + label 原生绑定」：点按钮等于原生点击 input，
            不经过任何 JS，也不需要用户手势校验，是所有手机浏览器最稳的写法。
            input 本身用「视觉隐藏但保留渲染」的 sr-input（不是 display:none）。
          -->
          <input id="scan-album-input" ref="albumInput" class="sr-input" type="file" accept="image/*" @change="onFileChange" />
          <input id="scan-camera-input" ref="cameraInput" class="sr-input" type="file" accept="image/*" capture="environment" @change="onFileChange" />

          <div class="drop-actions">
            <template v-if="cap.visionEnabled">
              <label class="pick-btn primary" for="scan-camera-input">
                <el-icon><Camera /></el-icon> 拍照
              </label>
              <label class="pick-btn" for="scan-album-input">
                <el-icon><Picture /></el-icon> 从相册选择
              </label>
            </template>
            <template v-else>
              <el-button disabled :icon="Camera">拍照</el-button>
              <el-button disabled :icon="Picture">从相册选择</el-button>
            </template>
          </div>
          <!--
            选图失败时的**页面上**的说明（不是一闪而过的 toast）
            ------------------------------------------------------------------
            手机上 toast 很容易被忽略，用户就会以为"选了图没反应"。
            这里把原因（格式 / 体积 / 解码失败）和下一步动作直接摆出来。
          -->
          <div v-if="uploadError" class="upload-error">
            <div class="ue-title">⚠️ {{ uploadError }}</div>
            <div v-if="uploadErrorTip" class="ue-tip">{{ uploadErrorTip }}</div>
            <div class="ue-actions">
              <label class="pick-btn" for="scan-album-input">换一张</label>
              <label class="pick-btn primary" for="scan-camera-input">直接拍照</label>
            </div>
          </div>

          <div class="drop-tips">
            <b>📏 想算准热量，关键是「参照物」</b>：照片没有深度，AI 只能靠已知尺寸的物体推算份量。<br />
            拍摄时请把 <b>筷子、勺子、一元硬币或手</b> 放进食盘旁，并尽量俯拍整盘——有参照物时份量误差可控制在 ±30%，没有则只能凭经验估算。
          </div>
        </div>

        <!-- 已选择图片：预览 -->
        <div v-else class="preview-area">
          <img :src="preview" class="preview-img" alt="待识别的食物照片" />
          <div class="preview-meta">
            <span>{{ imageSize }} KB · {{ imageWH }}</span>
            <div class="row">
              <el-button size="small" :icon="Refresh" :disabled="analyzing" @click="analyze">重新识别</el-button>
              <el-button size="small" :icon="Close" :disabled="analyzing" @click="reset">换一张</el-button>
            </div>
          </div>

          <!-- 图片已经选好了，只是识别接口失败（超时/网络）——单独提示并可一键重试 -->
          <div v-if="analyzeError && !analyzing" class="upload-error">
            <div class="ue-title">⚠️ {{ analyzeError }}</div>
            <div class="ue-actions">
              <el-button size="small" type="primary" :icon="Refresh" @click="analyze">重新识别</el-button>
              <el-button size="small" :icon="Close" @click="reset">换一张图</el-button>
            </div>
          </div>

          <!-- 识别中的步骤提示：让用户知道 AI 在做什么，而不是干等 -->
          <div v-if="analyzing" class="analyzing">
            <el-icon class="is-loading" :size="18"><Loading /></el-icon>
            <span>{{ analyzingStep }}</span>
          </div>
        </div>

        <!-- 隐藏的文件输入已改到上传区内部（见上方的 scan-album-input / scan-camera-input），
             这里保留注释说明，避免后来者又加一个 display:none 的 input（手机端会点不开） -->

        <!-- 识别流程说明：既是排版补充，也是这一功能的技术注解 -->
        <div class="scan-explain">
          <div class="se-title">🔬 识别是怎么做的</div>
          <ol class="se-list">
            <li><b>视觉识别</b>：多模态模型（{{ cap.model || '视觉模型' }}）识别食物种类、按参照物估算克数</li>
            <li><b>库内匹配</b>：名称包含 + 词法相关性（BM25）+ 二元组重叠过半字符；「风味 / 原味 / 迷你 / 袋装」这类口味包装词不算相似依据</li>
            <li><b>以库为准</b>：命中则用食物库每 100g 的数值重算热量；未命中才采用模型估算并明确标注</li>
            <li><b>冲突拦截</b>：命中但库值与估算相差 3 倍以上 → 判为误匹配，弃用库值、按 AI 估算计，并在该条目标注「差了几倍」（例如「面汤」不能按「意面」算）</li>
          </ol>
        </div>
      </div>

      <!-- ==================== ② 识别结果 ==================== -->
      <div class="card">
        <div class="card-title">
          <span>② 识别结果</span>
          <span v-if="result?.meta" class="sub">
            {{ result.meta.model }} · {{ (result.meta.latencyMs / 1000).toFixed(1) }}s · 库匹配 {{ result.meta.libraryRatio }}%
          </span>
        </div>

        <!-- 空状态 -->
        <div v-if="!result && !analyzing" class="empty-state">
          <div class="empty-icon">🔍</div>
          <div class="empty-title">还没有识别结果</div>
          <div class="empty-desc">上传一张照片，AI 会告诉你这一餐大概多少热量</div>
        </div>

        <!-- 非食物提示 -->
        <el-result
          v-else-if="result?.notFood"
          icon="warning"
          title="没有识别到食物"
          :sub-title="result.reason || '请换一张包含饭菜的照片'"
        >
          <template #extra>
            <el-button @click="reset">换一张试试</el-button>
          </template>
        </el-result>

        <template v-else-if="result">
          <!-- 场景描述 -->
          <el-alert v-if="result.scene" :title="result.scene" type="success" :closable="false" show-icon class="mb-8" />

          <!-- 尺度参照信息：照片判断重量靠的就是这个 -->
          <div class="scale-bar">
            <span class="scale-item">
              <span class="scale-label">尺度参照物</span>
              <b :class="result.referenceObject ? 'ok' : 'none'">{{ result.referenceObject || '未检测到' }}</b>
            </span>
            <span class="scale-item">
              <span class="scale-label">份量可信度</span>
              <el-tag size="small" :type="result.scaleConfidence === 'high' ? 'success' : result.scaleConfidence === 'medium' ? 'warning' : 'danger'" effect="plain">
                {{ { high: '高（有参照物）', medium: '中', low: '低（无参照物）' }[result.scaleConfidence] || '未知' }}
              </el-tag>
            </span>
          </div>
          <el-alert
            v-if="result.scaleWarning"
            :title="result.scaleWarning"
            type="warning"
            :closable="false"
            show-icon
            class="mb-8"
          />

          <!-- ⚖️ 快速精确：家里有厨房秤时，直接输入整餐总重量，一步算出精确热量 -->
          <div class="weigh-bar">
            <span class="wb-title">⚖️ 更精确（可选）</span>
            <el-input-number
              v-model="totalWeightInput"
              :min="10"
              :max="5000"
              :step="10"
              size="small"
              controls-position="right"
              placeholder="整餐克数"
              style="width: 128px"
            />
            <span class="wb-unit">g</span>
            <el-button size="small" type="primary" :icon="Check" @click="calibrateByTotal">按总重校准</el-button>
            <el-button v-if="calibrated" size="small" link @click="undoCalibration">撤销</el-button>
            <span v-if="calibrated" class="wb-badge">
              ✓ 已按{{ calibrated.mode === 'total' ? '总重' : '单项' }}校准（×{{ calibrated.factor }}）· 热量已精确换算
            </span>
            <span v-else class="wb-hint">用厨房秤称一下整盘，输入总克数即按识别比例自动分配</span>
          </div>

          <!-- 食物清单 -->
          <div class="fs-items">
            <div v-for="(it, idx) in result.items" :key="idx" class="fs-item" :class="{ conflict: it.conflict }">
              <div class="fs-main">
                <div class="fs-name">
                  {{ it.name }}
                  <el-tag size="small" :type="it.source === 'library' ? 'success' : 'warning'" effect="plain">
                    {{ it.source === 'library' ? '库内精确' : '模型估算' }}
                  </el-tag>
                  <el-tag v-if="it.conflict" size="small" type="info" effect="plain">
                    {{ it.conflictRatio ? `库值 ×${it.conflictRatio} 不符·已弃用` : '库值不符·已弃用' }}
                  </el-tag>
                </div>
                <div class="fs-sub">
                  <template v-if="it.libraryName">已匹配食物库：{{ it.libraryName }}</template>
                  <template v-else-if="it.libraryCandidate">
                    食物库候选「{{ it.libraryCandidate }}{{ it.conflictLibKcal != null ? `，${it.conflictLibKcal} kcal` : '' }}」与 AI 估算{{ it.conflictRatio ? `相差 ${it.conflictRatio} 倍` : '差距过大' }}，判为误匹配，本项按 AI 估算计
                  </template>
                  <template v-else>食物库未收录，采用 AI 估算值</template>
                  <span class="dot">·</span>
                  <span :class="`conf-${it.confidence}`">置信度 {{ confText(it.confidence) }}</span>
                </div>

                <!-- 模型给出的判断依据：让「重量是怎么来的」不再是黑盒 -->
                <div v-if="it.reference" class="fs-ref">📏 {{ it.reference }}</div>

                <!-- 份量校准：用模型给的区间做三档快捷选择，比让用户凭空填克数可靠得多 -->
                <div class="fs-presets">
                  <span class="preset-label">份量校准</span>
                  <button
                    v-for="p in presetOptions(it)"
                    :key="p.gram"
                    type="button"
                    class="preset"
                    :class="{ on: Math.abs(Number(it.amountG) - p.gram) < 5 }"
                    @click="setAmountPreset(it, p.gram)"
                  >
                    {{ p.label }}
                  </button>
                  <span class="preset-hint" :class="{ warn: !inEstimateRange(it) }">
                    {{ inEstimateRange(it) ? `✓ 在估计区间 ${it.amountMin}~${it.amountMax}g 内` : `⚠ 已超出估计区间 ${it.amountMin}~${it.amountMax}g` }}
                  </span>
                  <!-- 只知道某一种食材的实际重量时，用它推算整盘 -->
                  <button
                    v-if="Math.abs(Number(it.amountG) - Number(it._estG || it.amountG)) >= 5"
                    type="button"
                    class="preset preset-accent"
                    @click="calibrateByItem(it)"
                  >
                    按此推算全部
                  </button>
                </div>
              </div>

              <div class="fs-amount">
                <el-input-number
                  v-model="it.amountG"
                  :min="5"
                  :max="2000"
                  :step="10"
                  size="small"
                  controls-position="right"
                  style="width: 96px"
                  @change="(v) => onAmountChange(it, v)"
                />
                <span class="unit">g</span>
              </div>

              <div class="fs-kcal">
                <b>{{ Math.round(it.kcal) }}</b> kcal
                <div class="fs-macro">蛋{{ Math.round(it.protein) }} 脂{{ Math.round(it.fat) }} 碳{{ Math.round(it.carb) }}</div>
              </div>
            </div>
          </div>

          <!-- 合计 + 建议 -->
          <div class="totals">
            <div class="total-main">
              <span class="total-label">这一餐约</span>
              <span class="total-value">{{ totalKcal }}</span>
              <span class="total-unit">kcal</span>
            </div>
            <div class="total-macros">
              <span>蛋白 {{ totalProtein }}g</span>
              <span>脂肪 {{ totalFat }}g</span>
              <span>碳水 {{ totalCarb }}g</span>
            </div>
            <div class="total-compare" :class="compareClass">
              {{ compareText }}
            </div>
          </div>

          <el-alert v-if="result.advice" :title="result.advice" type="warning" :closable="false" show-icon class="mt-16" />

          <!-- 记入饮食 -->
          <div class="log-bar">
            <span class="log-label">记入</span>
            <el-select v-model="mealType" size="default" style="width: 120px">
              <el-option label="早餐" value="breakfast" />
              <el-option label="午餐" value="lunch" />
              <el-option label="晚餐" value="dinner" />
              <el-option label="加餐" value="snack" />
            </el-select>
            <el-button type="success" class="btn-gradient" :icon="Check" :loading="logging" @click="logToDiet">
              加入{{ mealNameMap[mealType] }}
            </el-button>
            <span class="log-tip">会按当前份量写入今日饮食记录</span>
          </div>
        </template>
      </div>
    </div>

    <!-- ==================== ③ 份量试算 + 饮食建议 ==================== -->
    <div class="card mt-16">
      <div class="card-title">
        <span>③ 份量试算 &amp; 饮食建议</span>
        <span class="sub">填克数看热量，AI 结合你的身体条件给建议</span>
      </div>

      <div class="calc-toolbar">
        <el-button size="small" :icon="Download" :disabled="!result?.items?.length" @click="fillFromResult">
          带入上方识别结果
        </el-button>
        <el-select
          v-model="pickerFoodId"
          filterable
          remote
          clearable
          :remote-method="searchFoods"
          placeholder="搜索食物库添加（如：米饭 / 鸡胸肉）"
          size="small"
          style="width: 260px"
          @change="addFromLibrary"
        >
          <el-option v-for="f in foodOptions" :key="f.id" :label="`${f.name}（${f.kcal}kcal/100g）`" :value="f.id" />
        </el-select>
        <span class="toolbar-gap" />
        <span class="toolbar-label">评估餐次</span>
        <el-select v-model="calcMealType" size="small" style="width: 100px">
          <el-option label="早餐" value="breakfast" />
          <el-option label="午餐" value="lunch" />
          <el-option label="晚餐" value="dinner" />
          <el-option label="加餐" value="snack" />
        </el-select>
      </div>

      <!-- 食物行 -->
      <div v-if="calcRows.length" class="calc-rows">
        <div v-for="(row, idx) in calcRows" :key="idx" class="calc-row">
          <span class="cr-name">{{ row.name }}</span>
          <div class="cr-input">
            <el-input-number
              v-model="row.amountG"
              :min="1"
              :max="2000"
              :step="10"
              size="small"
              controls-position="right"
              style="width: 108px"
            />
            <span class="unit">g</span>
          </div>
          <span class="cr-kcal"><b>{{ calcRowKcal(row) }}</b> kcal</span>
          <span class="cr-macro">蛋{{ calcRowMacro(row, 'protein') }} 脂{{ calcRowMacro(row, 'fat') }} 碳{{ calcRowMacro(row, 'carb') }}</span>
          <el-button link type="danger" :icon="Close" size="small" @click="calcRows.splice(idx, 1)" />
        </div>
      </div>
      <el-empty v-else description="还没有食物：可以「带入识别结果」，或搜索食物库添加" :image-size="60" />

      <!-- 合计 + 占目标比例 -->
      <div v-if="calcRows.length" class="calc-summary">
        <div class="cs-main">
          <span class="cs-label">合计</span>
          <span class="cs-value">{{ calcTotals.kcal }}</span>
          <span class="cs-unit">kcal</span>
          <span class="cs-macro">蛋白 {{ calcTotals.protein }}g · 脂肪 {{ calcTotals.fat }}g · 碳水 {{ calcTotals.carb }}g</span>
        </div>
        <div class="cs-share">
          <span>占今日目标 <b>{{ calcShare }}%</b></span>
          <el-progress
            :percentage="Math.min(100, calcShare)"
            :stroke-width="8"
            :show-text="false"
            :color="calcShare > 45 ? '#f59e0b' : '#10b981'"
            style="width: 120px"
          />
          <span class="text-muted">午餐建议 30~42%</span>
        </div>
      </div>

      <!-- AI 评估按钮 -->
      <div v-if="calcRows.length" class="calc-actions">
        <el-button type="primary" class="btn-gradient" :icon="MagicStick" :loading="advising" @click="runAdvice">
          AI 分析这一餐
        </el-button>
        <span class="text-muted">会结合你的体重、BMI、减脂目标与今日已摄入热量给建议</span>
      </div>

      <!-- 评估结果 -->
      <div v-if="advice" class="advice-box" :class="`v-${advice.advice.verdict}`">
        <div class="ab-head">
          <el-tag :type="advice.advice.verdict === 'good' ? 'success' : advice.advice.verdict === 'high' ? 'danger' : 'warning'" effect="dark" size="small">
            {{ advice.advice.verdict === 'good' ? '搭配合理' : advice.advice.verdict === 'high' ? '热量偏高' : '热量偏低' }}
          </el-tag>
          <span class="ab-headline">{{ advice.advice.headline }}</span>
          <span class="ab-provider">{{ advice.meta.provider === 'llm' ? 'AI 生成' : '规则引擎' }} · {{ (advice.meta.latencyMs / 1000).toFixed(1) }}s</span>
        </div>

        <div v-if="advice.advice.issues?.length" class="ab-block">
          <div class="ab-title">⚠️ 需要注意</div>
          <ul>
            <li v-for="(t, i) in advice.advice.issues" :key="i">{{ t }}</li>
          </ul>
        </div>

        <div v-if="advice.advice.suggestions?.length" class="ab-block">
          <div class="ab-title">💡 调整建议</div>
          <ul>
            <li v-for="(t, i) in advice.advice.suggestions" :key="i">{{ t }}</li>
          </ul>
        </div>

        <div class="ab-body">
          依据你的身体条件：体重 {{ advice.body.weight }}kg · BMI {{ advice.body.bmi }}（{{ advice.body.bmiLevel }}）·
          目标「{{ advice.body.goalText }}」· 每日目标 {{ advice.body.targetCalories }} kcal ·
          今日已摄入 {{ advice.body.todayIntake }} kcal（剩余 {{ advice.body.todayRemaining }} kcal）
        </div>
      </div>
    </div>

    <!-- ==================== ④ 识别历史 ==================== -->
    <div class="card mt-16">
      <div class="card-title">
        <span>④ 识别历史</span>
        <span class="sub">共 {{ history.length }} 条 · 点击可回看并记入饮食</span>
      </div>

      <div v-if="history.length" class="hist-grid">
        <div v-for="h in history" :key="h.id" class="hist-card" @click="loadScan(h)">
          <img :src="h.imageUrl" class="hist-img" alt="历史照片" />
          <div class="hist-body">
            <div class="hist-kcal"><b>{{ Math.round(h.totalKcal) }}</b> kcal</div>
            <div class="hist-meta">{{ h.items.length }} 种食物 · {{ h.createdAt.slice(5, 16) }}</div>
            <el-tag v-if="h.loggedMeal" size="small" type="success" effect="plain">已记入{{ mealNameMap[h.loggedMeal] }}</el-tag>
            <el-tag v-else size="small" type="info" effect="plain">未记入</el-tag>
          </div>
          <el-button class="hist-del" link type="danger" :icon="Delete" @click.stop="removeScan(h.id)" />
        </div>
      </div>
      <el-empty v-else description="还没有识别记录" :image-size="70" />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Camera, Picture, Refresh, Close, Check, Delete, Loading, Download, MagicStick } from '@element-plus/icons-vue';
import { api } from '@/api';
import { compressImage, dataUrlSize, looksLikeImage } from '@/utils/image';

const mealNameMap = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };

const pageLoading = ref(false);
const analyzing = ref(false);
const logging = ref(false);
const analyzingStep = ref('AI 正在识别…');
const dragging = ref(false);

const cap = ref({ visionEnabled: false, model: '', todayTarget: 0, todayIntake: 0, todayRemaining: 0 });
const preview = ref('');          // 压缩后的 dataURL（用于预览与提交）
const imageSize = ref(0);
const imageWH = ref('');
const result = ref(null);         // 识别结果（含 scanId）
const history = ref([]);          // 历史记录
const mealType = ref('lunch');

const albumInput = ref(null);      // 相册 / 文件（不带 capture）
const cameraInput = ref(null);     // 相机（capture="environment"）

// ---------------- 份量试算区状态 ----------------
const calcMealType = ref('lunch');
const calcRows = reactive([]);    // 每行：{ name, amountG, per100:{kcal,protein,fat,carb} }
const advising = ref(false);
const advice = ref(null);         // AI 评估结果
const foodOptions = ref([]);      // 食物库搜索结果
const pickerFoodId = ref('');

/** 单行热量 = 每 100g 热量 × 克数 / 100 */
const calcRowKcal = (row) => Math.round(((row.per100?.kcal || 0) * (Number(row.amountG) || 0)) / 100);
const calcRowMacro = (row, key) =>
  Number((((row.per100?.[key] || 0) * (Number(row.amountG) || 0)) / 100).toFixed(1));

/** 合计（跟随克数实时变化，不需要请求后端） */
const calcTotals = computed(() => ({
  kcal: calcRows.reduce((s, r) => s + calcRowKcal(r), 0),
  protein: Number(calcRows.reduce((s, r) => s + calcRowMacro(r, 'protein'), 0).toFixed(1)),
  fat: Number(calcRows.reduce((s, r) => s + calcRowMacro(r, 'fat'), 0).toFixed(1)),
  carb: Number(calcRows.reduce((s, r) => s + calcRowMacro(r, 'carb'), 0).toFixed(1)),
}));

/** 占今日目标百分比 */
const calcShare = computed(() => {
  const target = cap.value.todayTarget || 0;
  if (!target) return 0;
  return Number(((calcTotals.value.kcal / target) * 100).toFixed(0));
});

/** 把上方识别结果带入试算区（每 100g 值由「当前热量/克数」反推） */
function fillFromResult() {
  const items = result.value?.items || [];
  if (!items.length) {
    ElMessage.warning('上方还没有识别结果');
    return;
  }
  calcRows.splice(0, calcRows.length);
  for (const it of items) {
    const g = Number(it.amountG) || 100;
    calcRows.push({
      name: it.name,
      amountG: g,
      per100: {
        kcal: (Number(it.kcal) / g) * 100,
        protein: (Number(it.protein) / g) * 100,
        fat: (Number(it.fat) / g) * 100,
        carb: (Number(it.carb) / g) * 100,
      },
    });
  }
  advice.value = null;
  ElMessage.success(`已带入 ${items.length} 种食物，可直接改克数看热量`);
}

/** 搜索食物库（远程下拉） */
async function searchFoods(kw) {
  foodOptions.value = await api.foods({ kw: kw || undefined });
}

/** 从食物库添加一行（用库里每 100g 数据，最精确） */
function addFromLibrary(foodId) {
  if (!foodId) return;
  const f = foodOptions.value.find((x) => x.id === foodId);
  if (!f) return;
  calcRows.push({
    name: f.name,
    amountG: 100,
    per100: { kcal: f.kcal, protein: f.protein, fat: f.fat, carb: f.carb },
  });
  pickerFoodId.value = '';
  advice.value = null;
}

/** 调 AI 评估这一餐 */
async function runAdvice() {
  if (!calcRows.length) return;
  advising.value = true;
  try {
    const res = await api.foodScanAdvice({
      mealType: calcMealType.value,
      imageDesc: result.value?.scene || '',
      items: calcRows.map((r) => ({
        name: r.name,
        amountG: Number(r.amountG) || 0,
        kcal: calcRowKcal(r),
        protein: calcRowMacro(r, 'protein'),
        fat: calcRowMacro(r, 'fat'),
        carb: calcRowMacro(r, 'carb'),
      })),
    });
    advice.value = res;
    ElMessage.success(res.message || '评估完成');
  } finally {
    advising.value = false;
  }
}

// ---------------- 计算结果：按当前份量实时合计 ----------------
const totalKcal = computed(() => Math.round((result.value?.items || []).reduce((s, i) => s + (Number(i.kcal) || 0), 0)));
const totalProtein = computed(() => Number((result.value?.items || []).reduce((s, i) => s + (Number(i.protein) || 0), 0).toFixed(1)));
const totalFat = computed(() => Number((result.value?.items || []).reduce((s, i) => s + (Number(i.fat) || 0), 0).toFixed(1)));
const totalCarb = computed(() => Number((result.value?.items || []).reduce((s, i) => s + (Number(i.carb) || 0), 0).toFixed(1)));

/** 与今日剩余额度的对比文案（超标时变红） */
const compareText = computed(() => {
  const remain = cap.value.todayRemaining;
  if (!remain) return '';
  const diff = remain - totalKcal.value;
  if (diff >= 0) return `吃完这一餐，今天还剩 ${diff} kcal`;
  return `⚠️ 这一餐会超出今日额度 ${Math.abs(diff)} kcal`;
});
const compareClass = computed(() => ({
  warn: cap.value.todayRemaining > 0 && totalKcal.value > cap.value.todayRemaining,
}));

function confText(c) {
  return { high: '高', medium: '中', low: '低' }[c] || '中';
}

/** 从各项置信度里取最低值，作为整图的份量可信度（老历史记录没有存该字段时使用） */
function minConfidence(items) {
  const rank = { high: 3, medium: 2, low: 1 };
  let worst = null;
  for (const it of items || []) {
    const c = it.confidence;
    if (!rank[c]) continue;
    if (!worst || rank[c] < rank[worst]) worst = c;
  }
  return worst;
}

/** 三档份量预设：直接取模型估算区间的下限 / 估计值 / 上限 */
function presetOptions(it) {
  const min = Number(it.amountMin) || 0;
  const est = Number(it._estG || it.amountG) || 0;
  const max = Number(it.amountMax) || 0;
  if (!min || !max) return [];
  return [
    { label: `小份 ${Math.round(min)}g`, gram: Math.round(min) },
    { label: `估计 ${Math.round(est)}g`, gram: Math.round(est) },
    { label: `大份 ${Math.round(max)}g`, gram: Math.round(max) },
  ];
}

/** 当前克数是否仍落在模型估计区间内（超出时界面标黄，提示用户重新判断） */
function inEstimateRange(it) {
  const g = Number(it.amountG) || 0;
  const min = Number(it.amountMin) || 0;
  const max = Number(it.amountMax) || 0;
  if (!min || !max) return true;
  return g >= min && g <= max;
}

/** 点快捷份量：按比例重算热量与三大营养素 */
function setAmountPreset(it, gram) {
  onAmountChange(it, gram);
}

// ---------------- 快速精确校准（拍照后输入实际重量） ----------------
const totalWeightInput = ref(null);
/** 校准状态：{ mode: 'total' | 'single', value: 输入克数, factor: 缩放倍数 } */
const calibrated = ref(null);

/** 当前各项克数合计 */
const currentTotalG = computed(() => (result.value?.items || []).reduce((s, i) => s + (Number(i.amountG) || 0), 0));

/**
 * 按「整餐实际总重量」等比校准
 * ---------------------------------------------------------------------------
 * 真实场景里多数人只能用厨房秤称整盘、称不了一份份食材。
 * 所以这里按模型识别出的各食材比例，把总重量分配下去，一步得到精确热量。
 * 全程在本地计算，不发请求，改完立即看到结果。
 */
function calibrateByTotal() {
  const target = Number(totalWeightInput.value);
  const items = result.value?.items || [];
  if (!items.length) {
    ElMessage.warning('还没有识别结果');
    return;
  }
  if (!target || target < 10) {
    ElMessage.warning('请输入整餐的实际克数（大于 10g）');
    return;
  }
  const current = currentTotalG.value;
  if (!current) return;

  const factor = target / current;
  for (const it of items) {
    const newG = Math.max(5, Math.round((Number(it.amountG) * factor) / 5) * 5);
    onAmountChange(it, newG);
  }
  calibrated.value = { mode: 'total', value: target, factor: Number(factor.toFixed(2)) };

  const actual = currentTotalG.value;
  const diff = Math.abs(actual - target);
  ElMessage.success(
    diff <= 15
      ? `已按总重 ${target}g 校准，各项按识别比例分配完成`
      : `已按总重 ${target}g 校准（因按 5g 取整，实际合计 ${actual}g）`,
  );
}

/**
 * 按「某一种食材的实际重量」推算整盘
 * 适用：只称了米饭（200g）或只称了主菜的情况 —— 用这一项的偏差比例，等比修正其他项。
 */
function calibrateByItem(item) {
  const est = Number(item._estG) || Number(item.amountG) || 0;
  const cur = Number(item.amountG) || 0;
  if (!est || !cur) return;
  const factor = cur / est;
  if (Math.abs(factor - 1) < 0.03) {
    ElMessage.info('这一项的克数与估计值接近，无需推算');
    return;
  }
  for (const it of result.value?.items || []) {
    if (it === item) continue;
    const newG = Math.max(5, Math.round((Number(it.amountG) * factor) / 5) * 5);
    onAmountChange(it, newG);
  }
  calibrated.value = { mode: 'single', value: cur, factor: Number(factor.toFixed(2)) };
  ElMessage.success(`已按「${item.name} ${cur}g」推算，其余食材按同一比例(×${factor.toFixed(2)})同步修正`);
}

/** 撤销校准：把各项克数恢复为模型原始估计值，热量随之还原 */
function undoCalibration() {
  for (const it of result.value?.items || []) {
    if (it._estG) onAmountChange(it, it._estG);
  }
  calibrated.value = null;
  totalWeightInput.value = null;
  ElMessage.info('已恢复到 AI 原始估算值');
}

// ---------------- 上传与识别 ----------------
/**
 * 打开文件选择器
 * ---------------------------------------------------------------------------
 * mode='camera' → 带 capture 的那个 input（手机直接调后置摄像头）
 * mode='album'  → 不带 capture 的 input（相册 / 文件管理）
 * 说明：手机端两个按钮是 <label for> 原生绑定，**不经过这个函数**；
 * 这里只服务于桌面端"点整块虚线区域"和代码里主动调用的场景。
 */
function openPicker(mode = 'album') {
  if (!cap.value.visionEnabled) {
    ElMessage.warning('未启用视觉模型（AI_VISION_MODEL），无法识别照片');
    return;
  }
  const input = mode === 'camera' ? cameraInput.value : albumInput.value;
  if (!input) return;
  input.value = ''; // 允许重复选择同一张图
  input.click();
}

function onDrop(ev) {
  dragging.value = false;
  const file = ev.dataTransfer?.files?.[0];
  if (file) handleFile(file);
}

function onFileChange(ev) {
  const file = ev.target.files?.[0];
  // 选完立刻清空，否则同一张图第二次选不会触发 change（用户会以为"点了没反应"）
  ev.target.value = '';
  if (file) handleFile(file);
}

/**
 * 选中文件 → 压缩 → 自动识别
 * ---------------------------------------------------------------------------
 * 这里刻意把每一步失败都**显示在页面上**（uploadError），而不只是弹一个 2 秒的 toast。
 * 原因：手机上 toast 很容易被忽略，用户就会以为"选了图没反应"。
 */
const uploadError = ref('');
const uploadErrorTip = ref('');
/** 识别阶段的错误（图片已选好，只是接口失败），单独提示并可一键重试 */
const analyzeError = ref('');
/** 是否在微信内置浏览器里（企业微信也算）：里面拍照/选图基本不可用，要引导到外部浏览器 */
const isWeChat = ref(false);

/** 复制本页链接（微信里 clipboard API 常被禁用，失败就给一个可长按复制的输入框） */
async function copyPageLink() {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    ElMessage.success('链接已复制，粘贴到 Safari / Chrome 打开即可');
  } catch {
    ElMessageBox.alert(
      `<div style="word-break:break-all;font-size:13px;line-height:1.7">${url}</div>
       <div style="margin-top:8px;color:#64748b;font-size:12px">长按上面链接全选 → 复制 → 粘贴到浏览器打开</div>`,
      '请手动复制链接',
      { dangerouslyUseHTMLString: true, confirmButtonText: '知道了' },
    );
  }
}

async function handleFile(file) {
  uploadError.value = '';
  uploadErrorTip.value = '';

  // ① 类型：有些安卓文件选择器给出的 MIME 是空串，只能用扩展名兜底
  if (!looksLikeImage(file)) {
    uploadError.value = `这个文件不是图片（${file.type || '未识别格式'}）`;
    uploadErrorTip.value = `文件名：${file.name || '未知'}。请选择 JPG / PNG / WebP 格式的照片。`;
    ElMessage.warning('请选择图片文件');
    return;
  }

  // ② 体积：手机原图常见 5~12MB，上限放宽到 20MB，并在提示里告诉用户实际大小
  const mb = file.size / 1024 / 1024;
  if (mb > 20) {
    uploadError.value = `图片太大（${mb.toFixed(1)}MB），上限 20MB`;
    uploadErrorTip.value = '可以在相册里先压缩/裁剪一下，或直接用「拍照」按钮拍一张（会自动压到 1280px）。';
    ElMessage.warning(`图片请小于 20MB（当前 ${mb.toFixed(1)}MB）`);
    return;
  }

  try {
    pageLoading.value = true;
    const dataUrl = await compressImage(file, { maxEdge: 1280, quality: 0.85 });
    preview.value = dataUrl;
    imageSize.value = dataUrlSize(dataUrl);
    // 记录压缩后的分辨率，便于用户判断清晰度是否足够
    const img = new Image();
    img.src = dataUrl;
    await new Promise((r) => {
      img.onload = r;
      img.onerror = r;
    });
    imageWH.value = `${img.width}×${img.height}`;
    pageLoading.value = false;
    await analyze();
  } catch (err) {
    pageLoading.value = false;
    const info = err.fileInfo;
    uploadError.value = err.message || '图片处理失败';
    uploadErrorTip.value = info
      ? `文件名 ${info.name || '未知'} · 类型 ${info.type || '未知'} · ${Math.round((info.size || 0) / 1024)}KB`
      : '如果反复失败，请换一张 JPG/PNG 照片，或直接用「拍照」按钮。';
    ElMessage.error(err.message || '图片处理失败');
  } finally {
    pageLoading.value = false;
  }
}

/** 调用多模态识别接口 */
async function analyze() {
  if (!preview.value) return;
  analyzing.value = true;
  result.value = null;
  analyzingStep.value = '正在上传照片…';
  const t = setTimeout(() => {
    analyzingStep.value = 'AI 正在识别食物种类与份量…';
  }, 600);
  try {
    const res = await api.foodScanAnalyze(preview.value);
    initResultItems(res);
    result.value = res;
    analyzeError.value = '';
    if (res.notFood) {
      ElMessage.warning(res.reason || '没有识别到食物');
    } else {
      ElMessage.success(`识别完成：${res.items.length} 种食物，约 ${res.totals.kcal} kcal`);
    }
    await loadHistory();      // 识别成功会落库，刷新历史
  } catch (err) {
    /**
     * 识别失败要说清楚是"网"的问题，而不是让用户以为图没传上去。
     * 线上用的是免费实例，休眠时首个请求可能要等 30~60 秒，容易触发前端 60 秒超时。
     */
    const msg = String(err?.message || '');
    analyzeError.value = /timeout/i.test(msg)
      ? '识别请求超时了：免费实例正在从休眠中唤醒（首个请求要 30~60 秒）。点「重新识别」再试一次就好。'
      : `识别失败：${msg || '网络异常'}。图片已经选好了，点「重新识别」重试即可。`;
    ElMessage.error(/timeout/i.test(msg) ? '识别超时，请点「重新识别」重试' : '识别失败，请重试');
  } finally {
    clearTimeout(t);
    analyzing.value = false;
  }
}

/**
 * 给识别结果的每一项补上内部状态：
 *   _estG       模型原始估计克数（用于「估计」快捷按钮，避免被用户改动后基准漂移）
 *   _lastAmount 上一次的克数（份量改动时按比例重算热量）
 */
function initResultItems(res) {
  for (const it of res?.items || []) {
    it._estG = Number(it.amountG) || 100;
    it._lastAmount = Number(it.amountG) || 100;
  }
}

function reset() {
  preview.value = '';
  result.value = null;
  imageSize.value = 0;
  imageWH.value = '';
  analyzing.value = false;
}

/**
 * 修改份量：按「每克热量」等比缩放（库内精确与模型估算都适用）
 * 这样用户把「米饭 200g」改成「150g」时，热量与三大营养素会同步刷新。
 */
function onAmountChange(item, newAmount) {
  const amount = Number(newAmount) || 0;
  const oldAmount = Number(item._lastAmount || item.amountG) || 0;
  if (!amount || !oldAmount) {
    item._lastAmount = amount;
    return;
  }
  const ratio = amount / oldAmount;
  item.kcal = Math.round(item.kcal * ratio);
  item.protein = Number((item.protein * ratio).toFixed(1));
  item.fat = Number((item.fat * ratio).toFixed(1));
  item.carb = Number((item.carb * ratio).toFixed(1));
  item.amountG = amount;
  item._lastAmount = amount;
}

// ---------------- 记入饮食 ----------------
async function logToDiet() {
  if (!result.value?.scanId) {
    ElMessage.warning('这条识别记录不可用，请重新识别');
    return;
  }
  const items = (result.value.items || []).map((i) => ({
    name: i.name,
    amountG: i.amountG,
    foodId: i.foodId || null,
    kcal: i.kcal,
    protein: i.protein,
    fat: i.fat,
    carb: i.carb,
  }));
  if (!items.length) {
    ElMessage.warning('没有可记录的食物');
    return;
  }
  logging.value = true;
  try {
    const res = await api.foodScanLog(result.value.scanId, { mealType: mealType.value, items });
    ElMessage.success(res.message || `已记入${mealNameMap[mealType.value]}`);
    await Promise.all([loadHistory(), loadCapability()]);
    result.value = null;
    preview.value = '';
  } finally {
    logging.value = false;
  }
}

// ---------------- 历史记录 ----------------
async function loadHistory() {
  history.value = await api.foodScanHistory(20);
}

/** 点历史卡片：把历史结果载回右侧面板（可改份量后记入） */
async function loadScan(h) {
  try {
    const detail = await api.foodScanDetail(h.id);
    const wrapper = {
      notFood: false,
      scene: '',
      items: detail.items || [],
      totals: detail.totals,
      advice: detail.advice,
      scanId: detail.id,
      // 历史记录现在也会持久化参照物与整体可信度；老记录没有该字段时回退为「取各项最低置信度」
      referenceObject: detail.referenceObject || null,
      scaleConfidence: detail.scaleConfidence || minConfidence(detail.items),
      scaleWarning: null,
      meta: null,
    };
    initResultItems(wrapper);
    result.value = wrapper;
    preview.value = h.imageUrl;   // 预览用原图地址
    imageSize.value = 0;
    imageWH.value = '历史记录';
    ElMessage.info('已载入历史结果，可改份量后记入饮食');
  } catch {
    ElMessage.error('载入失败');
  }
}

async function removeScan(id) {
  try {
    await ElMessageBox.confirm('删除这条识别记录？原图也会从列表中移除。', '提示', { type: 'warning' });
  } catch {
    return;
  }
  await api.foodScanDelete(id);
  ElMessage.success('已删除');
  await loadHistory();
}

// ---------------- 初始化 ----------------
async function loadCapability() {
  cap.value = await api.foodScanCapability();
}

onMounted(async () => {
  // 微信 / 企业微信内置浏览器：拍照与选图基本不可用，提前把提示亮出来
  isWeChat.value = /MicroMessenger|wxwork/i.test(navigator.userAgent || '');
  pageLoading.value = true;
  try {
    await Promise.all([loadCapability(), loadHistory()]);
  } finally {
    pageLoading.value = false;
  }
});
</script>

<style scoped>
/* ---------------- 顶部功能区 ---------------- */
.hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  background: linear-gradient(120deg, #ecfdf5 0%, #f0fdfa 55%, #ffffff 100%);
  border: 1px solid #d1fae5;
}
.hero-title {
  font-size: 20px;
  font-weight: 800;
  margin-bottom: 6px;
}
.hero-desc {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.6;
  max-width: 560px;
}
.hero-chips {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.hero-stats {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}
.hs-item {
  padding: 10px 16px;
  border-radius: 12px;
  background: #fff;
  border: 1px solid var(--line);
  text-align: center;
  min-width: 96px;
}
.hs-item.highlight {
  background: linear-gradient(135deg, #ecfdf5, #f0fdf4);
  border-color: #a7f3d0;
}
.hs-label {
  font-size: 11.5px;
  color: var(--text-3);
  margin-bottom: 4px;
}
.hs-value {
  font-size: 19px;
  font-weight: 800;
  color: var(--text-1);
}
.hs-value span {
  font-size: 10px;
  color: var(--text-3);
  font-weight: 500;
}

/* ---------------- 微信内置浏览器提示 ---------------- */
.wx-tip {
  margin-bottom: 14px;
  padding: 12px 14px;
  border-radius: 12px;
  background: #fffbeb;
  border: 1px solid #fcd34d;
}
.wx-title {
  font-size: 13px;
  font-weight: 800;
  color: #92400e;
}
.wx-body {
  font-size: 12px;
  line-height: 1.75;
  color: #78350f;
  margin-top: 5px;
}
.wx-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.wx-hint {
  font-size: 11px;
  color: #a16207;
}
/* 微信里对"原生可见的 file input"兼容性最好 */
.wx-native {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed #fcd34d;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: #78350f;
}
.wx-file {
  font-size: 12px;
  max-width: 100%;
}
.wx-file::file-selector-button {
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid #fcd34d;
  background: #fff;
  color: #92400e;
  font-size: 12px;
  margin-right: 8px;
}

/* ---------------- 上传区 ---------------- */
.hidden-input {
  display: none;
}
/*
  视觉隐藏但**保留渲染**的文件输入（不能用 display:none）
  ---------------------------------------------------------------------------
  手机浏览器（微信 / 夸克 / UC / 小米）对 display:none 的文件输入会拒绝弹出选择器，
  表现就是"点了没反应"。这个类把 input 缩到 1px 透明，仍在布局里，
  再由外层 <label for> 原生触发，兼容性最好。
*/
.sr-input {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
  left: 0;
  top: 0;
}
/* label 版按钮（原生触发 input，不依赖 JS 点击） */
.pick-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 20px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.2;
  cursor: pointer;
  border: 1px solid var(--line);
  background: #fff;
  color: var(--text-1);
  transition: all 0.18s ease;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.pick-btn:hover {
  border-color: var(--brand);
  color: var(--brand-dark);
}
.pick-btn:active {
  transform: translateY(1px);
}
.pick-btn.primary {
  background: linear-gradient(135deg, #10b981, #059669);
  border-color: transparent;
  color: #fff;
  box-shadow: 0 6px 16px rgba(16, 185, 129, 0.28);
}
.pick-btn.primary:hover {
  color: #fff;
}
.pick-btn .el-icon {
  font-size: 15px;
}
/* 选图/识别失败的页面内提示 */
.upload-error {
  margin-top: 12px;
  padding: 11px 13px;
  border-radius: 12px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  text-align: left;
}
.ue-title {
  font-size: 12.5px;
  font-weight: 700;
  color: #b91c1c;
  line-height: 1.6;
}
.ue-tip {
  font-size: 11.5px;
  color: #7f1d1d;
  line-height: 1.65;
  margin-top: 4px;
  word-break: break-all;
}
.ue-actions {
  display: flex;
  gap: 8px;
  margin-top: 9px;
  flex-wrap: wrap;
}
.ue-actions .pick-btn {
  padding: 7px 14px;
  font-size: 12.5px;
}
.drop-zone {
  border: 2px dashed #cbd5e1;
  border-radius: 14px;
  padding: 28px 20px;
  text-align: center;
  cursor: pointer;
  transition: all 0.22s ease;
  background: #fcfdfe;
}
.drop-zone:hover,
.drop-zone.dragging {
  border-color: var(--brand);
  background: #f0fdf4;
  transform: translateY(-1px);
}
.drop-icon {
  font-size: 40px;
  margin-bottom: 10px;
}
.drop-title {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 4px;
}
.drop-desc {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 16px;
}
.drop-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
  margin-bottom: 14px;
}
.drop-tips {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.6;
  padding-top: 12px;
  border-top: 1px dashed #e2e8f0;
}

.preview-area {
  display: flex;
  flex-direction: column;
  gap: 10px;
}.preview-img {
  width: 100%;
  max-height: 330px;
  object-fit: contain;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: #f8fafc;
}
.preview-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-3);
  flex-wrap: wrap;
  gap: 8px;
}
.analyzing {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  color: #1e40af;
  font-size: 12.5px;
}

/* ---------------- 份量试算区 ---------------- */
.calc-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.toolbar-gap {
  flex: 1;
  min-width: 0;
}
.toolbar-label {
  font-size: 12.5px;
  color: var(--text-2);
}
.calc-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.calc-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 10px;
  background: #fbfdfe;
  border: 1px solid #f1f5f9;
}
.cr-name {
  flex: 1;
  min-width: 70px;
  font-size: 13.5px;
  font-weight: 600;
}
.cr-input {
  display: flex;
  align-items: center;
  gap: 3px;
}
.cr-input .unit {
  font-size: 12px;
  color: var(--text-3);
}
.cr-kcal {
  font-size: 12px;
  color: var(--text-2);
  min-width: 82px;
  text-align: right;
}
.cr-kcal b {
  font-size: 15px;
  color: var(--brand-dark);
}
.cr-macro {
  font-size: 10.5px;
  color: var(--text-3);
  min-width: 108px;
  text-align: right;
}
.calc-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 12px;
  padding: 12px 16px;
  border-radius: 12px;
  background: linear-gradient(135deg, #f0fdf4, #f0fdfa);
  border: 1px solid #d1fae5;
  flex-wrap: wrap;
}
.cs-main {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}
.cs-label {
  font-size: 12.5px;
  color: var(--text-2);
}
.cs-value {
  font-size: 26px;
  font-weight: 800;
  color: var(--brand-dark);
  letter-spacing: -0.5px;
}
.cs-unit {
  font-size: 12px;
  color: var(--text-3);
}
.cs-macro {
  font-size: 12px;
  color: var(--text-2);
  margin-left: 10px;
}
.cs-share {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  color: var(--text-2);
  flex-wrap: wrap;
}
.cs-share b {
  color: var(--brand-dark);
  font-size: 15px;
}
.calc-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  flex-wrap: wrap;
}

/* ---------------- AI 评估结果 ---------------- */
.advice-box {
  margin-top: 14px;
  padding: 14px 16px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: #fff;
}
.advice-box.v-good {
  border-color: #a7f3d0;
  background: #f0fdf4;
}
.advice-box.v-high {
  border-color: #fecaca;
  background: #fef2f2;
}
.advice-box.v-low {
  border-color: #fde68a;
  background: #fffbeb;
}
.ab-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.ab-headline {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
  flex: 1;
  min-width: 200px;
}
.ab-provider {
  font-size: 11px;
  color: var(--text-3);
}
.ab-block {
  margin-bottom: 8px;
}
.ab-title {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text-2);
  margin-bottom: 4px;
}
.ab-block ul {
  margin: 0;
  padding-left: 18px;
}
.ab-block li {
  font-size: 12.5px;
  color: var(--text-1);
  line-height: 1.7;
}
.ab-body {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed #cbd5e1;
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.6;
}

/* ---------------- 快速精确校准条 ---------------- */
.weigh-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  margin-bottom: 10px;
  border-radius: 10px;
  background: linear-gradient(135deg, #eef2ff, #f5f3ff);
  border: 1px solid #c7d2fe;
  flex-wrap: wrap;
}
.wb-title {
  font-size: 12.5px;
  font-weight: 700;
  color: #3730a3;
}
.wb-unit {
  font-size: 12px;
  color: var(--text-3);
}
.wb-hint {
  font-size: 11.5px;
  color: #6366f1;
}
.wb-badge {
  font-size: 11.5px;
  font-weight: 700;
  color: #047857;
  background: #d1fae5;
  border-radius: 999px;
  padding: 2px 10px;
}
.preset-accent {
  border-color: #c7d2fe;
  background: #eef2ff;
  color: #4338ca;
  font-weight: 600;
}
.preset-accent:hover {
  background: #e0e7ff;
  border-color: #a5b4fc;
  color: #3730a3;
}

/* ---------------- 尺度参照信息 ---------------- */
.scale-bar {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 9px 14px;
  margin-bottom: 8px;
  border-radius: 10px;
  background: #f8fafc;
  border: 1px dashed #cbd5e1;
  flex-wrap: wrap;
}
.scale-item {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
}
.scale-label {
  color: var(--text-3);
}
.scale-item b {
  color: var(--text-1);
}
.scale-item b.ok {
  color: var(--brand-dark);
}
.scale-item b.none {
  color: #b45309;
}

/* ---------------- 判断依据 + 份量校准 ---------------- */
.fs-ref {
  margin-top: 4px;
  font-size: 11.5px;
  color: #0f766e;
  line-height: 1.5;
  background: #f0fdfa;
  border-radius: 6px;
  padding: 3px 8px;
  display: inline-block;
}
.fs-presets {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 7px;
  flex-wrap: wrap;
}
.preset-label {
  font-size: 11px;
  color: var(--text-3);
}
.preset {
  border: 1px solid var(--line);
  background: #fff;
  color: var(--text-2);
  font-size: 11.5px;
  padding: 3px 9px;
  border-radius: 999px;
  cursor: pointer;
  transition: all 0.18s ease;
}
.preset:hover {
  border-color: #a7f3d0;
  background: #f0fdf4;
  color: var(--brand-dark);
}
.preset.on {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
  font-weight: 700;
}
.preset-hint {
  font-size: 11px;
  color: #047857;
}
.preset-hint.warn {
  color: #b45309;
  font-weight: 600;
}

/* ---------------- 识别流程说明 ---------------- */
.scan-explain {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 12px;
  background: #f8fafc;
  border: 1px dashed #cbd5e1;
}
.se-title {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text-2);
  margin-bottom: 8px;
}
.se-list {
  margin: 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.se-list li {
  font-size: 11.5px;
  color: var(--text-2);
  line-height: 1.6;
}
.se-list b {
  color: var(--brand-dark);
}

/* ---------------- 空状态 ---------------- */
.empty-state {
  padding: 46px 20px;
  text-align: center;
}
.empty-icon {
  font-size: 40px;
  margin-bottom: 10px;
}
.empty-title {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 6px;
}
.empty-desc {
  font-size: 12.5px;
  color: var(--text-3);
}

/* ---------------- 食物清单 ---------------- */
.fs-items {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 12px 0;
}
.fs-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  background: #fbfdfe;
  border: 1px solid #f1f5f9;
}
.fs-item.conflict {
  background: #fff7ed;
  border-color: #fed7aa;
}
.fs-main {
  flex: 1;
  min-width: 0;
}
.fs-name {
  font-size: 13.5px;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
/* 标签不允许被压缩：名字标签 + 「库内精确/模型估算」+ 冲突提示三个标签在手机窄屏下
   flex 会把它们压到内容宽度以下，文字溢出到相邻标签上（截图里出现过标签互相压字）。
   这里固定不收缩 + 允许换行，最多占两行，绝不重叠。 */
.fs-name .el-tag {
  flex-shrink: 0;
  white-space: nowrap;
}
.fs-sub {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 3px;
  line-height: 1.5;
}
.fs-sub .dot {
  margin: 0 4px;
}
.conf-high {
  color: #047857;
}
.conf-medium {
  color: #b45309;
}
.conf-low {
  color: #b91c1c;
}
.fs-amount {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.fs-amount .unit {
  font-size: 12px;
  color: var(--text-3);
}
.fs-kcal {
  text-align: right;
  font-size: 12.5px;
  color: var(--text-2);
  min-width: 86px;
  flex-shrink: 0;
}
.fs-kcal b {
  font-size: 16px;
  color: var(--brand-dark);
}
.fs-macro {
  font-size: 10.5px;
  color: var(--text-3);
  margin-top: 2px;
}

/* ---------------- 合计 ---------------- */
.totals {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 16px;
  border-radius: 12px;
  background: linear-gradient(135deg, #0f172a, #134e4a);
  color: #fff;
  flex-wrap: wrap;
}
.total-main {
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.total-label {
  font-size: 12px;
  color: #a7f3d0;
}
.total-value {
  font-size: 28px;
  font-weight: 800;
  letter-spacing: -0.5px;
}
.total-unit {
  font-size: 12px;
  color: #a7f3d0;
}
.total-macros {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: #cbd5e1;
}
.total-compare {
  margin-left: auto;
  font-size: 12px;
  color: #6ee7b7;
}
.total-compare.warn {
  color: #fca5a5;
  font-weight: 700;
}

/* ---------------- 记入饮食 ---------------- */
.log-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
  flex-wrap: wrap;
}
.log-label {
  font-size: 13px;
  color: var(--text-2);
  font-weight: 600;
}
.log-tip {
  font-size: 11.5px;
  color: var(--text-3);
}

/* ---------------- 历史记录 ---------------- */
.hist-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}
.hist-card {
  position: relative;
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.2s ease;
  background: #fff;
}
.hist-card:hover {
  border-color: #a7f3d0;
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
}
.hist-img {
  width: 100%;
  height: 92px;
  object-fit: cover;
  display: block;
  background: #f1f5f9;
}
.hist-body {
  padding: 8px 10px 10px;
}
.hist-kcal {
  font-size: 12px;
  color: var(--text-2);
}
.hist-kcal b {
  font-size: 16px;
  color: var(--brand-dark);
}
.hist-meta {
  font-size: 10.5px;
  color: var(--text-3);
  margin: 3px 0 6px;
}
.hist-del {
  position: absolute;
  top: 4px;
  right: 4px;
  background: rgba(255, 255, 255, 0.9);
  border-radius: 8px;
}

/* ---------------- 移动端 ---------------- */
@media (max-width: 900px) {
  .hero {
    flex-direction: column;
    align-items: stretch;
  }
  /* 上传区两个按钮在手机上各占一半，点按面积更大（手机上最怕按钮太小点不中） */
  .drop-actions {
    gap: 8px;
  }
  .pick-btn {
    flex: 1;
    padding: 11px 10px;
    font-size: 13.5px;
  }
  .hero-stats {
    justify-content: space-between;
  }
  .hs-item {
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
  }
  .hs-value {
    font-size: 16px;
  }
  .fs-item {
    flex-wrap: wrap;
    gap: 8px;
  }
  /* 手机上「名称 + 来源说明」必须独占一行：
     .fs-main 是 flex:1（basis 0），不会主动换行，只会被右侧的克数输入框和热量挤成一条窄缝，
     实测窄到一行只放得下 5~6 个字，说明文字被拉成很高的竖条。改成整行占满，克数/热量落到下一行。 */
  .fs-main {
    flex: 1 1 100%;
  }
  .fs-amount {
    margin-left: auto;
  }
  .fs-kcal {
    min-width: 70px;
  }
  .totals {
    gap: 8px;
  }
  .total-compare {
    margin-left: 0;
    width: 100%;
  }
  .hist-grid {
    grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
  }
  .hist-img {
    height: 78px;
  }
  /* 份量试算区在手机上纵向堆叠 */
  .calc-row {
    flex-wrap: wrap;
    gap: 8px;
  }
  .cr-name {
    flex-basis: 100%;
  }
  .cr-macro {
    min-width: 0;
    text-align: left;
  }
  .cs-share {
    gap: 8px;
  }
  .calc-toolbar .el-select {
    width: 100% !important;
  }
}
</style>
