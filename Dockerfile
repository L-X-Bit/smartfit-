# ============================================================================
#  智练 SmartFit —— 生产镜像
#  ---------------------------------------------------------------------------
#  为什么要这个文件：本机演示用「双击启动」就够了，但要把**一个永久不变的网址**
#  发给别人（别人用 4G 也能直接打开），最省事的方式是把整个应用丢到云平台上跑，
#  平台会给你一个固定域名（如 https://smartfit-xxxx.onrender.com）。
#
#  构建：docker build -t smartfit .
#  运行：docker run -p 3000:3000 -e AI_API_KEY=sk-xxx smartfit
#
#  设计取舍：
#   · 分两阶段构建：前端在 build 阶段用 Vite 打包成静态文件，运行镜像里不需要 devDependencies；
#   · 依赖全部是纯 JS（bcryptjs / express / zod / node:sqlite 内置），因此用 slim 镜像即可，
#     无需 gcc/python 等编译链，镜像小、构建快；
#   · 数据库是 SQLite 单文件，容器启动时若发现库为空会自动导入知识库与演示数据，
#     所以云上第一次访问就是有内容的演示状态（不需要手动 init:db）。
# ============================================================================

# ---------- 阶段 1：构建前端 ----------
FROM node:22-slim AS build
WORKDIR /app

# 先只拷贝清单文件，利用 Docker 层缓存：业务代码改动时不会重新装依赖
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --workspaces --include-workspace-root

# 再拷贝源码并打包前端（产物 web/dist 由后端同源托管）
COPY . .
RUN npm run build

# ---------- 阶段 2：运行 ----------
FROM node:22-slim
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=data/smartfit.db

COPY --from=build /app /app

# SQLite 与上传目录需要可写（云平台若挂载持久盘，挂到 /app/server/data 即可保住数据）
RUN mkdir -p /app/server/data /app/server/uploads

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
