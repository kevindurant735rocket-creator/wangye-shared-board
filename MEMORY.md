# MEMORY.md — 网页（白板/收藏工具）

一句话定位：原生 Node 无依赖白板应用（raw http server + lib/ 模块化 + 自研测试框架），带登录页/验证码/会话。

## 目录地图
- `server.js` — 入口（路由挂载、CORS、安全头、限流、BENCHMARK_MODE 跳过限流）
- `lib/` — auth（pbkdf2+会话持久化 data/sessions.json）/ captcha（SVG 内存态）/ rate-limit / notes-store（原子写）/ route-table / http-utils
- `public/` — index.html + login.{html,css,js}
- `tests/` — auth(12) / session-persistence(5) / refactor(16) / api.integration(15) / benchmark.js / screenshot.py

## 关键约定
- `npm test` = 四套件串联，全部 rc=0 才算过
- 集成测试密闭性：主套件 `BENCHMARK_MODE=1`（限流关），限流用例自起独立 server——auth 桶 10 次/分会被前序用例耗尽（曾以 "Invalid captcha" 伪装，实为 captcha 请求吃 429 → token undefined）
- 会话落盘 `data/sessions.json`：原子写（tmp+rename）、启动加载、过期即弃；已 gitignore（token 等同凭证）

## 已知坑位
- macOS 大小写不敏感 FS + `core.ignorecase=true`：.gitignore 规则必须锚定根目录（`/UI-TARS-desktop/`），否则误伤 `outputs/ui-tars-desktop/`
- 测试产物（*.png、*-result.json）不入库，规则在 .gitignore

## AC 历史
- 2026-09-11: npm test 48/48 全绿（12+5+16+15），server / /login.html /health HTTP 200；v1.3 登录+模块化入库（36fed9e），会话持久化+密闭化（41fa891）
- 2026-09-11 下午: 红队审查——_persistSessions 固定 .tmp 并发竞态+0o644 过宽 → 唯一 tmp+0o600+fsync，回归测试第 6 例；npm test 49/49（12+6+16+15）
