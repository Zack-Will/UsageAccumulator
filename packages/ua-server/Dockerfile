# ua-server —— 用 tsx 直接跑 TS（ARCHITECTURE §3 的技术栈变更说明）
# 构建上下文是仓库根目录：pnpm workspace 里 @ua/core 是源码依赖，必须一起进镜像。
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

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/ua-server/node_modules ./packages/ua-server/node_modules
COPY package.json tsconfig.base.json ./
COPY packages/ua-core ./packages/ua-core
COPY packages/ua-server ./packages/ua-server
COPY deploy/migrations ./deploy/migrations
COPY deploy/pricing.json ./deploy/pricing.json

USER node
EXPOSE 8080
# healthz 在 Caddy 之外也可用；compose 里 postgres 就绪后才起
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "packages/ua-server/src/main.ts"]
