# 共享写字板 (网页)

极简协同笔记 — Vite 现代化工程、响应式、SEO 就绪、兼容原有 `/api/notes` API。

## 工程化

- **Vite 6**：`index.html` 为入口，`src/main.js` + `src/styles.css`，`public/` 透传静态资源，`vite.config.js` 代理 `/api` 到 `http://localhost:3000`
- **scripts**：
  ```bash
  npm run dev      # Vite 开发服务器 http://localhost:5173 (代理 /api)
  npm run build    # 产出 dist/
  npm run preview  # 预览 dist
  npm start        # 生产服务 node server.js（优先托管 dist，缺失则回退 public）
  npm test         # 四套件：auth 12 + session-persistence 6 + refactor 16 + api.integration 15
  npm run bench    # HTTP 基准（自起 server 于 :3456，N=200 C=20）
  ```
- **Node >=18**，`package.json` 声明 `engines` 与 `type: commonjs` 保持兼容。

## 认证与会话 (v1.3)

- 登录页 `public/login.html`：SVG 图形验证码（一次性 token，5min TTL）+ 本地账号（`AUTH_USERS` 环境变量覆盖，格式 `user:pass[,user2:pass2]`，默认 `demo:demo1234`）
- 会话：`sid` cookie（HttpOnly + SameSite=Lax），服务端 Map 存储；**重启不丢**——落盘 `data/sessions.json`（唯一 tmp 原子写 + 0600 权限 + 启动加载 + 过期即弃），`SESSIONS_FILE` 可覆盖路径；该文件含 token，已 gitignore
- 限流：`/api/auth/*` 独立桶 `10 次/分钟`，防验证码/登录爆破

## 安全性 (server.js)

- 安全头：`X-Content-Type-Options / X-Frame-Options / Referrer-Policy / HSTS / CSP / Permissions-Policy`（轻量 helmet）
- CORS：`CORS_ORIGIN` 环境变量控制，默认 `*`，处理 `OPTIONS` 预检
- 限流：内存**固定窗口**（窗口边界处理论可 2× 突发）`GET 120/分钟 / POST 30/分钟`，超限 `429`
- 参数校验：`POST /api/notes` 校验 JSON 合法性、`text` 类型与 20000 长度，`413` 超大体
- 原子写入：临时文件 + `rename`，避免并发截断
- 体积限制：`128KB` 请求体上限

## 性能

- 静态资源：`assets/` 不可变缓存 `immutable 1年`，其余 `600s`，`ETag` + `304`
- `dist` 优先托管，`public` 回退；SPA 回退到 `index.html`
- 前端：防抖 `450ms` 保存、`1200ms` 输入冷却、页面不可见时暂停轮询、`fetch` 超时 `5s`、失败重试与 `sendBeacon` 兜底

## 可观测性

- 结构化 JSON 日志：`ts / level / msg / ip / ms / len`
- 健康检查：`GET /health` 与 `GET /api/health` 返回 `{ ok, uptime, version, staticRoot }`
- 优雅退出：监听 `SIGINT/SIGTERM`

## 响应式与 SEO

- 响应式：`clamp` 流体排版、`768px/480px/1280px` 断点、`prefers-reduced-motion`、`100dvh`、打印样式
- SEO：`title/description/canonical/OG/Twitter/JSON-LD WebApplication/robots.txt/sitemap.xml/theme-color/manifest`，`skip-link` 与 `aria-live`
- 无障碍：`label sr-only`、`aria-describedby`、`:focus-visible`

## 登录页 + 验证码（v1.2 冒烟）

- 入口：未登录访问 `/` 自动送 `public/login.html`
- 演示账号：`demo / demo1234`（未设置 `AUTH_USERS` 环境变量时的默认账户）
- 自定义账户：
  ```bash
  AUTH_USERS="alice:secret1,bob:secret2" npm start
  ```
- 接口：
  | Method | Path | 说明 |
  |---|---|---|
  | GET | `/api/auth/captcha` | 取 SVG 验证码，响应头 `X-Token` |
  | POST | `/api/auth/login` | `{username,password,captchaToken,captchaCode}` → 200 + `Set-Cookie: sid=…` |
  | POST | `/api/auth/logout` | 清 cookie + 删 session |
  | GET | `/api/auth/me` | 当前登录态 |
  | POST | `/api/notes` | **需登录**（401 `needLogin:true` 触发跳登录） |
- 详见 `lib/README.md`

### 验证方式

1. **单元/自检脚本**（12 用例，覆盖 captcha 一次性/TTL/大小写、auth 会话生命周期、防枚举时延）
   ```bash
   npm test
   ```
2. **端到端 curl 烟测**
   ```bash
   # 1. 启动
   PORT=3030 npm start &
   # 2. 取验证码
   curl -s -D /tmp/h -o /tmp/c.svg http://localhost:3030/api/auth/captcha
   TOKEN=$(awk -F': ' 'tolower($1)=="x-token"{print $2}' /tmp/h | tr -d '\r\n')
   CODE=$(grep -oE '<text[^>]*>[A-Z0-9]+</text>' /tmp/c.svg | sed -E 's|<text[^>]*>([A-Z0-9]+)</text>|\1|' | tr -d '\n')
   # 3. 登录
   curl -s -c /tmp/c.jar -X POST http://localhost:3030/api/auth/login \
     -H 'Content-Type: application/json' \
     -d "{\"username\":\"demo\",\"password\":\"demo1234\",\"captchaToken\":\"$TOKEN\",\"captchaCode\":\"$CODE\"}"
   # 4. 已登录访问
   curl -s -b /tmp/c.jar http://localhost:3030/api/auth/me
   curl -s -b /tmp/c.jar -X POST http://localhost:3030/api/notes \
     -H 'Content-Type: application/json' -d '{"text":"hi"}'
   # 5. 登出
   curl -s -b /tmp/c.jar -X POST http://localhost:3030/api/auth/logout
   ```
3. **浏览器自检**：打开 `http://localhost:3030/` → 自动跳登录页 → 输入 `demo/demo1234` + 验证码 → 跳回主页并能保存笔记

## API 兼容

- `GET /api/notes` → `{ text, updatedAt }`
- `POST /api/notes` `{ text }` → `{ text, updatedAt }`（保持 20000 截断与 ISO 时间）

## 目录

```
网页/
  index.html (Vite 入口，SEO)
  vite.config.js
  src/main.js
  src/styles.css
  public/ (robots.txt, sitemap.xml, manifest, login.html/css/js)
  dist/ (build 产物)
  server.js (安全/性能/可观测性/登录鉴权)
  lib/ (auth.js 鉴权 + captcha.js 图形验证码)
  tests/auth.test.js (npm test 自检脚本)
  data/notes.json
```
