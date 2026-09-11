# MEMORY.md — 网页（白板/收藏工具）

一句话定位：原生 Node 无依赖白板应用（raw http server + lib/ 模块化 + 自研测试框架），带登录页/验证码/会话。

## 目录地图
- `server.js` — 入口（路由挂载、CORS、安全头、限流、BENCHMARK_MODE 跳过限流、全局异常兜底）
- `lib/` — auth（pbkdf2+会话持久化+周期清扫 data/sessions.json）/ captcha（SVG 内存态）/ rate-limit（分桶 GET/WRITE）/ notes-store（原子写）/ route-table / http-utils / metrics（基数护栏）
- `public/` — index.html + login.{html,css,js}
- `tests/` — auth(12) / session-persistence(6) / refactor(33) / api.integration(21) / benchmark.js / screenshot.py

## 关键约定
- `npm test` = 四套件串联，全部 rc=0 才算过（现 72 条）
- 集成测试密闭性：主套件 `BENCHMARK_MODE=1`（限流关），限流用例自起独立 server——auth 桶 10 次/分会被前序用例耗尽（曾以 "Invalid captcha" 伪装，实为 captcha 请求吃 429 → token undefined）
- 会话落盘 `data/sessions.json`：原子写（tmp+rename）、启动加载、过期即弃；已 gitignore（token 等同凭证）
- 鉴权面：收藏 API（除 GET /api/share/:token）与 /api/metrics 需会话；GET /api/notes 公开读是产品语义不是漏洞
- bench 阶段 C 读 /api/metrics 需先真实 captcha→login 换 sid（metrics 已鉴权）
- immutable 缓存只发 /assets/ 指纹文件；顶层 app.js/styles.css 是 max-age=600

## 已知坑位
- macOS 大小写不敏感 FS + `core.ignorecase=true`：.gitignore 规则必须锚定根目录（`/UI-TARS-desktop/`），否则误伤 `outputs/ui-tars-desktop/`
- 测试产物（*.png、*-result.json）不入库，规则在 .gitignore
- `process._getActiveHandles()` 在现代 Node 不保证含 JS Timeout 对象——测 timer ref 状态会假红/假绿；正解是 spawn 只 require 模块的子进程看能否自行退出，再配阳性对照（留一个 ref timer 必须被超时杀掉）守卫探针不失明
- 会话残留 server 会在后台一直听端口（实测 8918 挂着 1h 的旧代码实例，/health 版本号是鉴别旧进程的快捷标志）；先 lsof 清理再验入口
- 端口占用时 `node server.js` 默认落 :3000，不会抢 :8918

## AC 历史
- 2026-09-11: npm test 48/48 全绿（12+5+16+15），server / /login.html /health HTTP 200；v1.3 登录+模块化入库（36fed9e），会话持久化+密闭化（41fa891）
- 2026-09-11 下午: 红队审查——_persistSessions 固定 .tmp 并发竞态+0o644 过宽 → 唯一 tmp+0o600+fsync，回归测试第 6 例；npm test 49/49（12+6+16+15）
- 2026-09-11 晚 R1: 六项修复（unref 泄漏/notes 原子写统一/CL 预检/版本对齐/app.js 保存提示/死变量）+4 回归；55/55；4 主题提交（45c2d42..aeeed3f）
- 2026-09-11 晚 R2: 独立红队 11 条（2P1/5P2/4P3）→ 修 10 条：/% 一发崩进程（复现+修+全局兜底）、收藏 API 整组裸奔（挂鉴权，share token 读豁免）、限流 PATCH/DELETE 直通+桶污染（分桶+全方法+GET 300）、metrics 404 探测撑爆内存（归并+500 封顶+鉴权）、immutable 一年缓存、会话无清扫（20min sweep+落盘过滤）、XFF 伪造、密码冒号截断、script-src unsafe-inline、tmp 失败残留；GET /api/notes 公开读记为产品决策。72/72 + bench rc=0 + 实弹验证（/% 400 且存活）；6 提交（f437596..838a6aa）
