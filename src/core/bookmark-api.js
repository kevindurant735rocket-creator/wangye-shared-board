/**
 * bookmark-api.js — 网页收藏 HTTP 层（t4 后端实现）
 *
 * 端点（对齐 PRD t1 §5.3 七个端点，另加 FR-05/FR-06 闭环所需的最小补充）：
 *   POST   /api/bookmarks            创建（含快照任务）            §5.3 ✓
 *   GET    /api/bookmarks            检索 ?q&tag&customer&status     §5.3 ✓
 *   GET    /api/bookmarks/:id        详情（联调必需，§5.3 隐含）
 *   PATCH  /api/bookmarks/:id        编辑/恢复                     §5.3 ✓
 *   DELETE /api/bookmarks/:id        软删（?hard=true 彻底删除）    §5.3 ✓
 *   POST   /api/bookmarks/import     书签 HTML 导入 {html}          §5.3 ✓
 *   POST   /api/bookmarks/:id/share  生成分享链接（GET 只读需先有 token）
 *   DELETE /api/bookmarks/:id/share  关闭分享链接
 *   GET    /api/share/:token         只读打开 + 访问计数（免登录）  §5.3 ✓
 *   POST   /api/bookmarks/:id/check  坏链探测                      §5.3 ✓
 *   GET    /api/bookmarks/:id/snapshot  快照文本视图/重试状态
 *   POST   /api/bookmarks/:id/snapshot  快照重试
 *   GET    /api/tags/suggest?url=    规则推荐标签（FR-03，非 AI）
 *   GET    /api/bookmarks-stats      计数（t5 验收抽样用）
 *
 * 错误格式统一：4xx 带 {error, reason}（reason 可直显，PRD §5.3）。
 * 两种挂载方式：buildRoutes(store, helpers) → 路由表数组（给 网页/server.js）；
 * createServer(store, port) → 独立进程（单测/联调用）。
 */
'use strict';

const http = require('http');
const { STATUS } = require('./bookmark-store');

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function collectBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) {
        reject(Object.assign(new Error('Request body too large'), { code: 'PAYLOAD_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await collectBody(req);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw Object.assign(new Error('body 必须是对象'), { code: 'INVALID_FIELD' });
    }
    return v;
  } catch (e) {
    if (e.code) throw e;
    throw Object.assign(new Error('Invalid JSON'), { code: 'INVALID_JSON' });
  }
}

/** store 抛出的业务错误 → HTTP 状态码。 */
function statusOf(e) {
  switch (e && e.code) {
    case 'NOT_FOUND':
      return 404;
    case 'DUPLICATE':
      return 409;
    case 'INVALID_URL':
    case 'INVALID_FIELD':
    case 'INVALID_JSON':
    case 'INVALID_STATE':
      return 400;
    case 'PAYLOAD_TOO_LARGE':
      return 413;
    default:
      return 500;
  }
}

function fail(res, e) {
  const code = statusOf(e);
  const payload = { error: (e && e.code) || 'InternalError', reason: (e && (e.reason || e.message)) || '未知错误' };
  if (e && e.code === 'DUPLICATE' && e.extra && e.extra.existing) {
    payload.existing = e.extra.existing;
  }
  if (code === 500) {
    console.error(JSON.stringify({ level: 'error', msg: 'bookmark api error', error: String((e && e.stack) || e) }));
  }
  sendJson(res, code, payload);
}

function parseQuery(req) {
  const u = new URL(req.url, 'http://localhost');
  const q = {};
  for (const [k, v] of u.searchParams.entries()) {
    if (k === 'tag') {
      q.tag = q.tag === undefined ? v : [...(Array.isArray(q.tag) ? q.tag : [q.tag]), v];
    } else if (q[k] === undefined) {
      q[k] = v;
    }
  }
  // tag 支持逗号分隔：?tag=a,b
  if (typeof q.tag === 'string' && q.tag.includes(',')) q.tag = q.tag.split(',').map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(q.tag)) {
    q.tag = q.tag.flatMap((t) => String(t).split(',')).map((s) => s.trim()).filter(Boolean);
  }
  return q;
}

/** 路由表：兼容 网页/lib/route-table.js 的 {method, pattern, handler(req,res,params,helpers)}。 */
function buildRoutes(store) {
  const ok = (res, code, obj) => sendJson(res, code, obj);
  return [
    {
      method: 'POST', pattern: '/api/bookmarks', name: 'POST /api/bookmarks',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          const { bookmark, suggestedTags } = await store.create(body);
          return ok(res, 201, { ok: true, bookmark, suggestedTags });
        } catch (e) { return fail(res, e); }
      },
    },
    {
      method: 'GET', pattern: '/api/bookmarks', name: 'GET /api/bookmarks',
      handler: async (req, res) => {
        try {
          return ok(res, 200, { ok: true, ...store.list(parseQuery(req)) });
        } catch (e) { return fail(res, e); }
      },
    },
    {
      method: 'POST', pattern: '/api/bookmarks/import', name: 'POST /api/bookmarks/import',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          const html = typeof body.html === 'string' ? body.html : typeof body === 'string' ? body : '';
          const result = await store.importHtml(html);
          return ok(res, 200, { ok: true, ...result });
        } catch (e) { return fail(res, e); }
      },
    },
    {
      method: 'GET', pattern: '/api/bookmarks-stats', name: 'GET /api/bookmarks-stats',
      handler: async (req, res) => ok(res, 200, { ok: true, ...store.stats() }),
    },
    {
      method: 'GET', pattern: '/api/tags/suggest', name: 'GET /api/tags/suggest',
      handler: async (req, res) => {
        const { url = '' } = parseQuery(req);
        return ok(res, 200, { ok: true, url, suggestedTags: store.suggestTags(url) });
      },
    },
    {
      method: 'GET', pattern: '/api/bookmarks/:id', name: 'GET /api/bookmarks/:id',
      handler: async (req, res, params) => {
        try {
          return ok(res, 200, { ok: true, bookmark: store.get(params.id) });
        } catch (e) { return fail(res, e); }
      },
    },
    {
      method: 'PATCH', pattern: '/api/bookmarks/:id', name: 'PATCH /api/bookmarks/:id',
      handler: async (req, res, params) => {
        try {
          const body = await readJsonBody(req);
          return ok(res, 200, { ok: true, bookmark: store.update(params.id, body) });
        } catch (e) { return fail(res, e); }
      },
    },
    {
      method: 'DELETE', pattern: '/api/bookmarks/:id', name: 'DELETE /api/bookmarks/:id',
      handler: async (req, res, params) => {
        try {
          const { hard } = parseQuery(req);
          return ok(res, 200, store.remove(params.id, { hard: hard === 'true' || hard === '1' }));
        } catch (e) { return fail(res, e); }
      },
    },
    {
      method: 'POST', pattern: '/api/bookmarks/:id/share', name: 'POST /api/bookmarks/:id/share',
      handler: async (req, res, params) => {
        try {
          return ok(res, 201, { ok: true, ...store.share(params.id) });
        } catch (e) { return fail(res, e); }
      },
    },
    {
      method: 'DELETE', pattern: '/api/bookmarks/:id/share', name: 'DELETE /api/bookmarks/:id/share',
      handler: async (req, res, params) => {
        try {
          return ok(res, 200, { ok: true, ...store.unshare(params.id) });
        } catch (e) { return fail(res, e); }
      },
    },
    {
      method: 'GET', pattern: '/api/share/:token', name: 'GET /api/share/:token',
      handler: async (req, res, params) => {
        try {
          return ok(res, 200, { ok: true, bookmark: store.openShared(params.token) });
        } catch (e) { return fail(res, e); }
      },
    },
    {
      method: 'POST', pattern: '/api/bookmarks/:id/check', name: 'POST /api/bookmarks/:id/check',
      handler: async (req, res, params) => {
        try {
          return ok(res, 200, { ok: true, bookmark: await store.check(params.id) });
        } catch (e) { return fail(res, e); }
      },
    },
    {
      method: 'GET', pattern: '/api/bookmarks/:id/snapshot', name: 'GET /api/bookmarks/:id/snapshot',
      handler: async (req, res, params) => {
        try {
          return ok(res, 200, { ok: true, snapshot: store.getSnapshot(params.id) });
        } catch (e) { return fail(res, e); }
      },
    },
    {
      method: 'POST', pattern: '/api/bookmarks/:id/snapshot', name: 'POST /api/bookmarks/:id/snapshot',
      handler: async (req, res, params) => {
        try {
          return ok(res, 200, { ok: true, snapshot: await store.retrySnapshot(params.id) });
        } catch (e) { return fail(res, e); }
      },
    },
  ];
}

/** 独立进程（单测/联调用，不依赖 网页/server.js）。 */
function createServer(store, port = 0) {
  const routes = buildRoutes(store);
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end();
      return;
    }
    const urlPath = (req.url || '/').split('?')[0];
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const names = [];
      const pattern = r.pattern.split('/').map((seg) => {
        if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('/');
      const m = urlPath.match(new RegExp('^' + pattern + '$'));
      if (!m) continue;
      const params = {};
      names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
      try {
        await r.handler(req, res, params, {});
      } catch (e) { fail(res, e); }
      return;
    }
    sendJson(res, 404, { error: 'NOT_FOUND', reason: '未知接口' });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { buildRoutes, createServer, STATUS };
