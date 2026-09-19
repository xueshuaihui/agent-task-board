# node:20-alpine 小镜像：只带编译产物 + 生产依赖 + Prisma 迁移文件。
# 构建标识由 bundle.sh 注入（GIT_REVISION/BUILD_TIME）：烙进镜像 ENV 与 OCI 标签，
# GET /healthz 的 commit 字段与 docker image inspect 的 revision 标签都读它。
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/cloud/package.json apps/cloud/package.json
# prisma generate 需要 client 依赖
RUN npm ci --workspace @atb/cloud --include-workspace-root=false || npm install --workspace @atb/cloud

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY apps/cloud ./apps/cloud
WORKDIR /app/apps/cloud
RUN npx prisma generate --schema prisma/schema.prisma && npx nest build

FROM node:20-alpine
WORKDIR /app
ARG GIT_REVISION=unknown
ARG BUILD_TIME=unknown
ENV NODE_ENV=production \
    CLOUD_PORT=7789 \
    CLOUD_DATA_DIR=/data \
    CLOUD_COMMIT=${GIT_REVISION}
LABEL org.opencontainers.image.revision=${GIT_REVISION} \
      org.opencontainers.image.created=${BUILD_TIME}
RUN mkdir -p /data && chown -R node:node /data
USER node
COPY --from=build /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/cloud/dist ./dist
COPY --from=build --chown=node:node /app/apps/cloud/prisma ./prisma
EXPOSE 7789
VOLUME ["/data"]
# 迁移由应用启动时自执行（src/infra/bootstrap.ts），无需额外 entrypoint。
CMD ["node", "dist/main.js"]
