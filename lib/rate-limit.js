/**
 * rate-limit.js — 进程内固定窗口限流（Batch A 同期，与 server.js 解耦）
 * 注意：是固定窗口（windowStart 整窗重置）而非滑动窗口——窗口边界处理论可 2× 突发，
 * 本机部署可接受；如需严格平滑再改分桶计数。
 *
 * 设计沿用 t0 报告确认的限流桶策略：
 *  - default bucket：GET 120/min，POST 30/min
 *  - auth bucket    ：GET 10/min， POST 10/min（更严）
 *
 * 内存 Map<ip, { windowStart, getCount, postCount, authCount }>，
 * 60s 窗口，超阈值返回 true（表示触发限流）。
 *
 * 回滚：直接 require 替换；函数签名保持一致。
 */
'use strict';

const RATE_WINDOW_MS = 60 * 1000;
// 红队 R2-F3：默认 GET 上限 120→300。前端每秒轮询 /api/notes（60/min/标签页），
// 120 意味着两个标签页就贴线、三个必 429 误报"离线"；300 给正常多标签留余量。
const RATE_MAX_GET = 300;
const RATE_MAX_POST = 30;
const RATE_MAX_AUTH = 10;

const rateStore = new Map();

// 红队 R2-F3：所有非只读方法（POST/PATCH/DELETE/PUT…）都计入 WRITE 桶，
// 旧实现只限 GET/POST，PATCH/DELETE 直通（恰是收藏 API 的全部写操作）。
const limits = {
  default: { GET: RATE_MAX_GET, WRITE: RATE_MAX_POST },
  auth: { GET: RATE_MAX_AUTH, WRITE: RATE_MAX_AUTH },
};

function isRateLimited(req, bucket = 'default') {
  const ip = req.socket && req.socket.remoteAddress
    || (req.headers && req.headers['x-forwarded-for']) || 'unknown';
  const now = Date.now();
  let entry = rateStore.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    entry = {
      windowStart: now,
      // 每桶独立计数（旧实现 GET 计数 default/auth 共用，auth 桶会被普通浏览污染）
      counts: {
        default: { GET: 0, WRITE: 0 },
        auth: { GET: 0, WRITE: 0 },
      },
    };
    rateStore.set(ip, entry);
  }
  if (req.method === 'OPTIONS') return false; // CORS 预检不计
  const lim = limits[bucket] || limits.default;
  const key = (req.method === 'GET' || req.method === 'HEAD') ? 'GET' : 'WRITE';
  const c = entry.counts[bucket] || entry.counts.default;
  c[key] += 1;
  return c[key] > lim[key];
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateStore) {
    if (now - v.windowStart > RATE_WINDOW_MS * 2) rateStore.delete(k);
  }
}, RATE_WINDOW_MS * 5).unref();

module.exports = { isRateLimited, RATE_WINDOW_MS, RATE_MAX_GET, RATE_MAX_POST, RATE_MAX_AUTH };
