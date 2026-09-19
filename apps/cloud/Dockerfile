# node:20-alpine 小镜像：只带编译产物 + 生产依赖 + Prisma 迁移文件。
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
ENV NODE_ENV=production \
    CLOUD_PORT=7789 \
    CLOUD_DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data
USER node
COPY --from=build /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/cloud/dist ./dist
COPY --from=build --chown=node:node /app/apps/cloud/prisma ./prisma
EXPOSE 7789
VOLUME ["/data"]
# 迁移由应用启动时自执行（src/infra/bootstrap.ts），无需额外 entrypoint。
CMD ["node", "dist/main.js"]
