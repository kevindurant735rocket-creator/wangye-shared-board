# 部署指南

本仓自包含（收藏后端 `src/core/` 已收编，零 npm 运行时依赖），三条部署路径任选。
改完代码先跑 `npm test`，部署后用 `deploy/smoke.sh` 验活（探针覆盖：health、版本一致性、
畸形 URL 400、鉴权门 401、登录页 200）。

## 0. 通用前置

```bash
AUTH_USERS='用户名:密码'        # 生产必设；不设则用 demo:demo1234 演示账号
PORT=3000                       # 默认 3000
NODE_ENV=production             # systemd/Dockerfile 已代设；裸跑建议手动带上
```

## 1. Docker（推荐，已按 nodejs/docker-node 最佳实践写好）

```bash
docker build -t whiteboard .
docker run -d --name whiteboard --init -p 3000:3000 \
  -e AUTH_USERS='admin:CHANGE_ME' \
  -v whiteboard-data:/app/data \
  whiteboard
SMOKE_BASE=http://127.0.0.1:3000 bash deploy/smoke.sh
```

- `--init`：Node 不宜做 PID1（信号/僵尸进程），tini 兜底；容器内也已注册 SIGTERM 优雅停机
- `-v .../data`：会话/笔记/收藏持久化，容器重建不丢
- HEALTHCHECK 用 node fetch 自检 `/health`（alpine 无 curl）
- 反代（nginx/caddy）后面加 `TRUST_PROXY=1` 才会信任 `X-Forwarded-For`

## 2. systemd（Linux 裸机/VM）

```bash
sudo mkdir -p /opt/whiteboard/data
sudo git clone <本仓> /opt/whiteboard   # 或 rsync 源码；data/ 归运行用户可写
sudo cp deploy/whiteboard.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now whiteboard
bash deploy/smoke.sh SMOKE_BASE=http://127.0.0.1:3000
```

## 3. 裸 Node（macOS/开发机）

```bash
npm run build        # 产出 dist（server 优先托管 dist，缺失回退 public）
NODE_ENV=production AUTH_USERS='admin:CHANGE_ME' PORT=3000 node server.js
bash deploy/smoke.sh
```

## 4. Cloudflare Pages（⚠️ 仅静态，别直接用）

`wrangler.toml` 是历史遗留的 Pages 配置：Pages 只托管 `dist/` 静态资源，
**Node 后端（登录/验证码/笔记/收藏 API）不会运行**，页面会全部打到死 API。
除非把后端移植成 Pages Functions，否则请走上面三条路径。
