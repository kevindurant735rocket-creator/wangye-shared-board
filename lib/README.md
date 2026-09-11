# lib/ — 鉴权核心模块

## 模块一览

| 模块 | 职责 |
|---|---|
| `captcha.js` | 内存型 SVG 图形验证码（4位字母+数字，去易混字符，TTL 5min，一次性） |
| `auth.js` | pbkdf2 密码哈希 + 内存会话（HttpOnly cookie） |

## API

### captcha
- `captcha.create()` → `{ token, svg, expiresIn }`
- `captcha.verify(token, code)` → `boolean`（一次性消费）
- 测试用：`captcha._size()`, `captcha._clear()`

### auth
- `auth.loadFromEnv(envValue)` — `AUTH_USERS="u1:p1,u2:p2"`，无值时默认 `demo/demo1234`
- `auth.login(user, pass)` → `userId | null`（含用户枚举时延防御）
- `auth.startSession(userId)` → `token`
- `auth.verifySession(token)` → `userId | null`（含滑动续期）
- `auth.logout(token)` → `boolean`
- 常量：`SESSION_TTL_MS`

## HTTP API（由 server.js 暴露）

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/auth/captcha` | 取 SVG，响应头 `X-Token` |
| POST | `/api/auth/login` | `{username,password,captchaToken,captchaCode}` → 200 + `Set-Cookie: sid=` |
| POST | `/api/auth/logout` | 清 cookie + 删 session |
| GET | `/api/auth/me` | 当前登录态 |
| POST | `/api/notes` | **需登录**（401 `needLogin:true` 触发跳登录） |

## 安全要点

- 密码：pbkdf2-sha256 / 100k 迭代 / 16B salt / 32B key，常数时间比较
- 会话：32B 随机 token，HttpOnly + SameSite=Lax，8h TTL（>30min 才续期）
- 限流：登录/验证码接口单独桶 10/min（默认 GET 120, POST 30）
- CSP：`script-src 'self' 'unsafe-inline'`（登录页需要 inline 加载 SVG）
- 防用户枚举：未知用户也跑一次等量 pbkdf2

## 替换说明

- 用 bcrypt/argon2 时只改 `auth.js`，调用方不变
- 接入持久化（Redis/DB）：替换 `users`/`sessions` 两个 Map 即可
- 验证码要加噪线/扭曲：在 `captcha.js` `create()` 增加更多 SVG 元素
