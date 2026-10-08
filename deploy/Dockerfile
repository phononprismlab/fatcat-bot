# 肥肥风筝猫 · 镜像
#
# 构建（在项目根目录）：
#   docker build -f deploy/Dockerfile -t fatcat-bot:latest .
# 或者直接用 deploy/docker-compose.yml（它会顺带把 NapCat 一起拉起来）。
#
# 关于字体：PDF 导出要靠系统里的中文 TTF/TTC，所以这里必须装 fonts-noto-cjk，
# 不装的话 /导出 pdf 会自动降级成 txt（不会报错，但等于白做了 PDF 功能）。
# 装的正好是 src/config.js 里探测的 /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc。

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      tzdata \
      fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    DATA_DIR=/data \
    ADMIN_PORT=8787

WORKDIR /app

# 零依赖：不需要 npm install，源码拷进去就能跑
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY deploy ./deploy
COPY .env.example ./.env.example

# 数据目录（数据库 / 导出 / 上传文件）
RUN mkdir -p /data && chown -R node:node /data

USER node

VOLUME ["/data"]
EXPOSE 8787

# 探活走 /healthz：机器人模式下 OneBot 掉线会返回 503，容器因此被标记 unhealthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "/app/deploy/docker-healthcheck.js"]

# node:sqlite 在 Node 22 仍是实验特性，必须带 flag
CMD ["node", "--experimental-sqlite", "src/index.js"]
