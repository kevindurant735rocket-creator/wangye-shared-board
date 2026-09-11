# syntax=docker/dockerfile:1
# 多阶段构建：build 装全量依赖跑 vite 产出 dist；runtime 零 npm 依赖（server 只用 stdlib）。
# 依据 nodejs/docker-node BestPractices：NODE_ENV=production、非 root（node uid 1000）、
# STOPSIGNAL + 建议 --init（PID1 信号）、HEALTHCHECK 用 node fetch（alpine 无 curl）。
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.js index.html ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
COPY server.js ./
COPY lib ./lib
COPY src ./src
COPY public ./public
COPY --from=build /app/dist ./dist
# data/ 挂卷持久化（sessions/notes/bookmarks），运行身份 node(uid 1000) 可写
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME /app/data
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
