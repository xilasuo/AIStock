# 复盘簿（fupanbu-trading-journal）Docker 部署
#
# 说明：本项目是为 Cloudflare Workers 设计的（D1 数据库 + Worker 运行时）。
# 数据库层依赖 cloudflare:workers 的 env.DB，无法在纯 Node 下运行，
# 因此这里用 wrangler 的本地运行时（miniflare/workerd）在容器内托管构建产物，
# 并把 D1 持久化到 /data 卷（本质为本地 SQLite 文件）。
FROM node:22-bookworm

WORKDIR /app

# 换 Debian 国内镜像源（百度云等国内环境加速 apt）
RUN sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/debian.sources

# 安装运行时依赖（curl 用于健康检查；tzdata 供容器内时间统一为上海时区）
RUN apt-get update && apt-get install -y --no-install-recommends curl tzdata && \
    rm -rf /var/lib/apt/lists/*

# 容器默认 UTC，若不设置会导致 datetime.now()/new Date() 输出差 8 小时；统一上海时区
ENV TZ=Asia/Shanghai

# 统一走 npmmirror 国内镜像加速（含 @cloudflare/* 与 wrangler/workerd 二进制包均已同步）。
# 注意：不要将 @cloudflare scope 指向 registry.npmjs.org，国内访问极慢会导致构建卡死。
# 说明：package-lock.json 已被 .gitignore 忽略（Windows 开发 / Ubuntu 部署，平台相关
# 依赖 esbuild/workerd/@webassemblyjs 解析不同，不跨平台同步 lock），故此处只复制
# package.json，由 npm install 在容器内按当前平台重新解析依赖。
COPY package.json ./
# BuildKit 缓存挂载：跨构建复用 npm tar 包，第二次起大幅提速
# 依赖 package.json 的 overrides 已把 wrangler 锁到 npmmirror 已同步的稳定版 4.116.0，
# workerd 也用 overrides 统一到 1.20260730.1，避免 hoisting 到旧版二进制导致启动校验失败。
# 依赖安装：用 npm install（不依赖 lock 文件），在 Ubuntu 容器内解析出本平台正确的依赖树。
# 关键：不要用 npm cache clean 清空 /root/.npm 缓存挂载，否则跨构建的 tar 包
# 缓存失效，每次都要重新从 registry 下载（尤其访问 npmjs.org 的国内环境极慢）。
RUN --mount=type=cache,target=/root/.npm \
    npm config set registry https://registry.npmmirror.com && \
    npm install --no-audit --no-fund --prefer-offline --maxsockets=5 \
           --fetch-retries=10 --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=180000 --fetch-timeout=600000

# 复制源码并构建（vinext build 产出 dist/）
# 说明：依赖安装层已通过 BuildKit 缓存挂载复用 npm tar 包；--no-cache 由
# deploy.sh 移除后，仅当 package.json 变化时才重跑本步骤。
# 注意：构建依赖 .openai/hosting.json（已在仓库中），会被一并复制
COPY . .
RUN npm run build

# 关闭 wrangler 遥测，避免启动阻塞
ENV WRANGLER_SEND_METRICS=false

# 启动时由 start.sh 根据环境变量生成 .dev.vars（wrangler 本地 secrets）
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 8787

CMD ["/app/start.sh"]
