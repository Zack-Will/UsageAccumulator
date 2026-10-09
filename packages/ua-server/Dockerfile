# ua-server —— 用 tsx 直接跑 TS（ARCHITECTURE §3 的技术栈变更说明）
# 构建上下文是仓库根目录：pnpm workspace 里 @ua/core 是源码依赖，必须一起进镜像。
#
# 镜像自带看板（UA_WEB_DIR=/app/web）和探针单文件（/dl/ua-probe.mjs），
# 一个容器就能提供 API、看板和探针下载。发布见 .github/workflows/release.yml。
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ua-core/package.json packages/ua-core/
COPY packages/ua-server/package.json packages/ua-server/
COPY packages/ua-tokens/package.json packages/ua-tokens/
COPY packages/ua-probe/package.json packages/ua-probe/
COPY apps/web/package.json apps/web/
COPY apps/menubar/package.json apps/menubar/
RUN pnpm install --frozen-lockfile --filter @ua/server... --prod=false

# ---- 看板 + 探针单文件 --------------------------------------------------------
FROM base AS web
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ua-core/package.json packages/ua-core/
COPY packages/ua-server/package.json packages/ua-server/
COPY packages/ua-tokens/package.json packages/ua-tokens/
COPY packages/ua-probe/package.json packages/ua-probe/
COPY apps/web/package.json apps/web/
COPY apps/menubar/package.json apps/menubar/
RUN pnpm install --frozen-lockfile --filter @ua/web... --filter @ua/probe...
COPY packages/ua-core ./packages/ua-core
COPY packages/ua-tokens ./packages/ua-tokens
COPY packages/ua-probe ./packages/ua-probe
COPY apps/web ./apps/web
# web 的 prebuild 会先打探针单文件进 public/dl/，vite build 再把 public/ 原样带进 dist
RUN pnpm -F @ua/web build

FROM base AS runtime
ENV NODE_ENV=production UA_WEB_DIR=/app/web
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/ua-server/node_modules ./packages/ua-server/node_modules
COPY package.json tsconfig.base.json ./
COPY packages/ua-core ./packages/ua-core
COPY packages/ua-server ./packages/ua-server
COPY deploy/migrations ./deploy/migrations
COPY deploy/pricing.json ./deploy/pricing.json
COPY --from=web /app/apps/web/dist ./web
# compose 把具名卷挂到这里；卷第一次创建时继承镜像里这个目录的属主，
# 不预先建好就是 root 所有，node 用户存不了 claude.ai 会话
RUN mkdir -p /data/claude-sessions && chown node:node /data/claude-sessions && chmod 700 /data/claude-sessions

USER node
EXPOSE 8080
# healthz 在 Caddy 之外也可用；compose 里 postgres 就绪后才起
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "packages/ua-server/src/main.ts"]
