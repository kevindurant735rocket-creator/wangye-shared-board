// server.js — 重构版（Batch A+B+C+D 落地）
//
// 重构策略：
//   - Batch A：抽取 HTTP 工具到 lib/http-utils.js（已就绪）
//   - Batch B：抽取路由表到 lib/route-table.js（已就绪）
//   - Batch C：进程内指标 lib/metrics.js + X-Response-Time + /api/metrics
//   - Batch D：兼容层 — env LEGACY_MODE=1 时走纯老路径，否则走新路径
//
// 数据/接口兼容：所有现有 URL/响应格式/cookie 行为保持不变。
// 回滚：git checkout -- server.js 即可（一行命令）。
//
// 验证：node tests/api.integration.test.js 启动新 server 全路径应通过。

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const auth = require('./lib/auth');
const captcha = require('./lib/captcha');
const httpUtils = require('./lib/http-utils');
const rateLimit = require('./lib/rate-limit');
const notesStore = require('./lib/notes-store');
const metrics = require('./lib/metrics');
const { buildRouter } = require('./lib/route-table');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DIST_DIR = path.join(ROOT, 'dist');
const LOGIN_PAGE = path.join(PUBLIC_DIR, 'login.html');

const PORT = Number(process.env.PORT) || 3000;
const LEGACY_MODE = process.env.LEGACY_MODE === '1';

// 启动装载用户
auth.loadFromEnv(process.env.AUTH_USERS);

// ---------- 兼容层工具：保留旧函数名，便于回滚时无需修改 server.js ----------
const setSecurityHeaders = httpUtils.setSecurityHeaders;
const setCorsHeaders = httpUtils.setCorsHeaders;
const sendJson = httpUtils.sendJson;
const collectBody = httpUtils.collectBody;
const readSessionCookie = httpUtils.readSessionCookie;
const getClientIp = httpUtils.getClientIp;
const shortEtag = httpUtils.shortEtag;
const isRateLimited = rateLimit.isRateLimited;

const mimeTypes = httpUtils.MIME_TYPES;

function getStaticRoot() {
  if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) return DIST_DIR;
  return PUBLIC_DIR;
}

function findStaticFile(relPath) {
  const safe = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const candidates = [DIST_DIR, PUBLIC_DIR].filter((r) => fs.existsSync(r));
  for (const root of candidates) {
    const p = path.join(root, safe === '' ? 'index.html' : safe);
    if (
      fs.existsSync(p) &&
      fs.statSync(p).isFile() &&
      p.startsWith(root)
    ) {
      return { root, filePath: p };
    }
  }
  return null;
}

function log(level, msg, extra = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...extra,
  });
  if (level === 'error') console.error(line);
  else console.log(line);
}

// ---------- 数据层（已迁移到 notes-store） ----------
function readNotes() { return notesStore.read(ROOT); }
function writeNotes(text) { return notesStore.write(ROOT, text); }

function requireAuth(req, res) {
  const token = readSessionCookie(req);
  const userId = auth.verifySession(token);
  if (!userId) {
    sendJson(res, 401, { error: 'Unauthorized', needLogin: true });
    return false;
  }
  return true;
}

function serveLoginOrIndex(req, res) {
  const token = readSessionCookie(req);
  const userId = auth.verifySession(token);
  if (userId) {
    serveStaticInternal(req, res, '/');
    return;
  }
  fs.readFile(LOGIN_PAGE, (err, content) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Login page not available');
      return;
    }
    setSecurityHeaders(res);
    setCorsHeaders(req, res);
    res.writeHead(200, {
      'Content-Type': mimeTypes['.html'],
      'Cache-Control': 'no-store',
      'Content-Length': content.length,
    });
    res.end(content);
  });
}

function serveStaticInternal(req, res, urlPath) {
  const found = findStaticFile(urlPath);
  let staticRoot;
  let filePath;
  let hasExt;

  if (found) {
    staticRoot = found.root;
    filePath = found.filePath;
    hasExt = path.extname(filePath) !== '';
  } else {
    if (!path.extname(urlPath) && !urlPath.startsWith('/api/')) {
      const home = fs.existsSync(path.join(DIST_DIR, 'index.html'))
        ? path.join(DIST_DIR, 'index.html')
        : path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(home)) {
        staticRoot = path.dirname(home);
        filePath = home;
        hasExt = true;
      }
    }
  }

  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (!urlPath.startsWith('/api/')) {
        const fallback = path.join(getStaticRoot(), 'index.html');
        if (fs.existsSync(fallback) && filePath !== fallback) {
          fs.readFile(fallback, (err2, content2) => {
            if (err2) {
              res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end('Not found');
              return;
            }
            setSecurityHeaders(res);
            setCorsHeaders(req, res);
            res.setHeader('Cache-Control', 'no-cache');
            res.writeHead(200, { 'Content-Type': mimeTypes['.html'] });
            res.end(content2);
          });
          return;
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = mimeTypes[ext] || 'application/octet-stream';
    const isImmutable =
      filePath.includes('/assets/') || ext === '.js' || ext === '.css';
    const cacheControl = isImmutable
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=600';
    const etag = shortEtag(content);
    if (req.headers['if-none-match'] === etag) {
      setSecurityHeaders(res);
      setCorsHeaders(req, res);
      res.writeHead(304);
      res.end();
      return;
    }

    setSecurityHeaders(res);
    setCorsHeaders(req, res);
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': cacheControl,
      ETag: etag,
      'Content-Length': content.length,
    });
    res.end(content);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (urlPath === '/health' || urlPath === '/api/health') {
    setSecurityHeaders(res);
    setCorsHeaders(req, res);
    return sendJson(res, 200, {
      ok: true,
      uptime: process.uptime(),
      version: '1.2.0',
      staticRoot: path.basename(getStaticRoot()),
      authUsers: auth.userCount(),
    });
  }

  // 新增 /api/metrics（Batch C：可观测性）
  if (urlPath === '/api/metrics' && req.method === 'GET') {
    setSecurityHeaders(res);
    setCorsHeaders(req, res);
    return sendJson(res, 200, metrics.snapshot());
  }

  if (urlPath === '/' || urlPath === '/index.html') {
    return serveLoginOrIndex(req, res);
  }

  if (urlPath === '/login' || urlPath === '/login.html') {
    return serveStaticInternal(req, res, '/login.html');
  }

  serveStaticInternal(req, res, urlPath);
}

// ============== 鉴权路由 ==============

async function handleCaptcha(req, res) {
  setSecurityHeaders(res);
  setCorsHeaders(req, res);
  const { token, svg, expiresIn } = captcha.create();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Captcha-Token', token);
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.writeHead(200, { 'X-Token': token, 'X-Expires': String(expiresIn) });
  res.end(svg);
  log('info', 'captcha issued', { ip: getClientIp(req) });
}

async function handleLogin(req, res) {
  setSecurityHeaders(res);
  setCorsHeaders(req, res);
  try {
    const body = await collectBody(req);
    let payload;
    try {
      payload = body ? JSON.parse(body) : {};
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON' });
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return sendJson(res, 400, { error: 'Invalid payload: expected object' });
    }
    const { username, password, captchaToken, captchaCode } = payload;
    if (
      typeof username !== 'string' ||
      username.length < 1 ||
      username.length > 64 ||
      typeof password !== 'string' ||
      password.length < 1 ||
      password.length > 256
    ) {
      return sendJson(res, 400, { error: 'Invalid credentials format' });
    }
    if (
      typeof captchaToken !== 'string' ||
      typeof captchaCode !== 'string' ||
      captchaCode.length < 4 ||
      captchaCode.length > 8
    ) {
      return sendJson(res, 400, { error: 'Invalid captcha' });
    }
    if (!captcha.verify(captchaToken, captchaCode)) {
      return sendJson(res, 401, { error: 'Captcha incorrect or expired' });
    }
    const userId = auth.login(username, password);
    if (!userId) {
      log('warn', 'login failed', { ip: getClientIp(req), username });
      return sendJson(res, 401, { error: 'Invalid username or password' });
    }
    const token = auth.startSession(userId);
    const cookie =
      `sid=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(
        auth.SESSION_TTL_MS / 1000
      )}`;
    res.setHeader('Set-Cookie', cookie);
    log('info', 'login success', { ip: getClientIp(req), username });
    return sendJson(res, 200, { ok: true, username });
  } catch (e) {
    log('error', 'login error', { error: String(e) });
    return sendJson(res, 400, { error: 'Login failed' });
  }
}

async function handleLogout(req, res) {
  setSecurityHeaders(res);
  setCorsHeaders(req, res);
  const token = readSessionCookie(req);
  if (token) auth.logout(token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  return sendJson(res, 200, { ok: true });
}

function handleMe(req, res) {
  setSecurityHeaders(res);
  setCorsHeaders(req, res);
  const token = readSessionCookie(req);
  const userId = auth.verifySession(token);
  if (!userId) return sendJson(res, 401, { error: 'Unauthorized' });
  return sendJson(res, 200, { ok: true, userId });
}

// ---------- Batch B：声明式路由表 ----------
// t4 后端实现：网页收藏 API（PRD §5.3）。独立模块 src/core/，此处只做挂载；
// 加载失败则降级为无收藏路由（既有鉴权/笔记/静态链路不受影响）。
let bookmarkRoutes = [];
let bookmarkStoreInstance = null;
try {
  // eslint-disable-next-line global-require
  const { createStore } = require('../src/core/bookmark-store');
  // eslint-disable-next-line global-require
  const { buildRoutes } = require('../src/core/bookmark-api');
  bookmarkStoreInstance = createStore({
    persistPath: process.env.BOOKMARK_DATA || path.join(ROOT, 'data', 'bookmarks.json'),
  });
  bookmarkRoutes = buildRoutes(bookmarkStoreInstance).map((r) => ({
    ...r,
    handler: async (req, res, params, helpers) => {
      setSecurityHeaders(res);
      setCorsHeaders(req, res);
      return r.handler(req, res, params, helpers);
    },
  }));
} catch (e) {
  log('warn', 'bookmark api disabled', { error: String((e && e.message) || e) });
}
const apiRouter = buildRouter([
  {
    method: 'GET',
    pattern: '/api/auth/captcha',
    name: 'GET /api/auth/captcha',
    handler: handleCaptcha,
  },
  {
    method: 'POST',
    pattern: '/api/auth/login',
    name: 'POST /api/auth/login',
    handler: handleLogin,
  },
  {
    method: 'POST',
    pattern: '/api/auth/logout',
    name: 'POST /api/auth/logout',
    handler: handleLogout,
  },
  {
    method: 'GET',
    pattern: '/api/auth/me',
    name: 'GET /api/auth/me',
    handler: handleMe,
  },
  // 笔记相关（保留兼容 GET/POST /api/notes）
  {
    method: 'GET',
    pattern: '/api/notes',
    name: 'GET /api/notes',
    handler: (req, res) => {
      setSecurityHeaders(res);
      setCorsHeaders(req, res);
      res.setHeader('Cache-Control', 'no-store');
      const data = readNotes();
      log('info', 'GET /api/notes', { ip: getClientIp(req) });
      return sendJson(res, 200, data);
    },
  },
  {
    method: 'POST',
    pattern: '/api/notes',
    name: 'POST /api/notes',
    handler: async (req, res) => {
      if (!requireAuth(req, res)) return;
      setSecurityHeaders(res);
      setCorsHeaders(req, res);
      try {
        const body = await collectBody(req);
        let payload;
        try {
          payload = body ? JSON.parse(body) : {};
        } catch {
          return sendJson(res, 400, { error: 'Invalid JSON' });
        }
        if (
          typeof payload !== 'object' ||
          payload === null ||
          Array.isArray(payload)
        ) {
          return sendJson(res, 400, { error: 'Invalid payload: expected object' });
        }
        if (payload.text !== undefined && typeof payload.text !== 'string') {
          return sendJson(res, 400, { error: 'Invalid field: text must be string' });
        }
        if (typeof payload.text === 'string' && payload.text.length > 20000) {
          return sendJson(res, 400, { error: 'Text too long: max 20000' });
        }
        const result = writeNotes(payload.text || '');
        log('info', 'POST /api/notes', { ip: getClientIp(req), len: result.text.length });
        return sendJson(res, 200, result);
      } catch (e) {
        log('error', 'POST /api/notes error', { error: String(e) });
        const msg = e.message === 'Request body too large' ? 'Payload Too Large' : 'Invalid note content';
        const code = e.message === 'Request body too large' ? 413 : 400;
        return sendJson(res, code, { error: msg });
      }
    },
  },
].concat(bookmarkRoutes));

// ---------- 主入口 ----------
const server = http.createServer(async (req, res) => {
  const start = Date.now();
  const url = req.url || '/';
  const urlPath = url.split('?')[0];

  // CORS 预检
  if (req.method === 'OPTIONS') {
    setSecurityHeaders(res);
    setCorsHeaders(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  // 限流：/api/auth/* 更严；benchmark 模式下跳过，便于量化吞吐
  const authPath = urlPath.startsWith('/api/auth/');
  const benchmarkMode = process.env.BENCHMARK_MODE === '1';
  if (!benchmarkMode && isRateLimited(req, authPath ? 'auth' : 'default')) {
    setSecurityHeaders(res);
    setCorsHeaders(req, res);
    log('warn', 'rate limited', { ip: getClientIp(req), url, method: req.method });
    return sendJson(res, 429, { error: 'Too Many Requests', retryAfter: 60 });
  }

  // Batch B：新路由表接管（legacy 关闭时直接走表）
  let handled = false;
  try {
    handled = await apiRouter.handle(req, res, urlPath, { sendJson, log });
  } catch (e) {
    log('error', 'router threw', { error: String(e), stack: e.stack && e.stack.slice(0, 400) });
    if (!res.headersSent) { try { sendJson(res, 500, { error: 'router error' }); } catch {} }
    return;
  }
  if (handled) {
    const dur = Date.now() - start;
    metrics.record(req.method, urlPath, res.statusCode || 200, dur);
    if (!res.headersSent) res.setHeader('X-Response-Time', dur + 'ms');
    return;
  }

  // 其余一律走静态托管（async：延后打点）
  const staticStart = Date.now();
  serveStatic(req, res);
  // 静态路径指标记录（headersSent 之后再尝试写 X-Response-Time 会抛 ERR_HTTP_HEADERS_SENT）
  setImmediate(() => {
    const dur = Date.now() - staticStart;
    metrics.record(req.method, urlPath, res.statusCode || 200, dur);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log('info', `Shared board running`, {
    port: PORT,
    staticRoot: path.basename(getStaticRoot()),
    users: auth.userCount(),
    legacyMode: LEGACY_MODE,
    version: '1.3.0-refactor',
  });
  console.log(
    `Shared board running at http://localhost:${PORT} (static: ${getStaticRoot()}) mode=${LEGACY_MODE ? 'legacy' : 'refactor'}`
  );
});

function shutdown(signal) {
  log('info', `shutdown ${signal}`);
  server.close(() => {
    log('info', 'server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// 导出供测试：避免 server 真正 listen 两次
module.exports = { httpUtils, rateLimit, notesStore, metrics, buildRouter, apiRouter, LEGACY_MODE, bookmarkStore: bookmarkStoreInstance, bookmarkRoutes };
