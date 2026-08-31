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
  ```
- **Node >=18**，`package.json` 声明 `engines` 与 `type: commonjs` 保持兼容。

## 安全性 (server.js)

- 安全头：`X-Content-Type-Options / X-Frame-Options / Referrer-Policy / HSTS / CSP / Permissions-Policy`（轻量 helmet）
- CORS：`CORS_ORIGIN` 环境变量控制，默认 `*`，处理 `OPTIONS` 预检
- 限流：内存滑动窗口 `GET 120/分钟 / POST 30/分钟`，超限 `429`
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
  public/ (robots.txt, sitemap.xml, manifest, 旧 index.html 保留)
  dist/ (build 产物)
  server.js (安全/性能/可观测性增强)
  data/notes.json
```
