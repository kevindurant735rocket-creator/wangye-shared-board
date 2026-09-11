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
const RATE_MAX_GET = 120;
const RATE_MAX_POST = 30;
const RATE_MAX_AUTH = 10;

const rateStore = new Map();

const limits = {
  default: { GET: RATE_MAX_GET, POST: RATE_MAX_POST },
  auth: { GET: RATE_MAX_AUTH, POST: RATE_MAX_AUTH },
};

function isRateLimited(req, bucket = 'default') {
  const ip = req.socket && req.socket.remoteAddress
    || (req.headers && req.headers['x-forwarded-for']) || 'unknown';
  const now = Date.now();
  let entry = rateStore.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    entry = { windowStart: now, getCount: 0, postCount: 0, authCount: 0 };
    rateStore.set(ip, entry);
  }
  const lim = limits[bucket] || limits.default;
  if (req.method === 'GET') {
    entry.getCount += 1;
    return entry.getCount > lim.GET;
  }
  if (req.method === 'POST') {
    if (bucket === 'auth') entry.authCount += 1;
    else entry.postCount += 1;
    const used = bucket === 'auth' ? entry.authCount : entry.postCount;
    return used > lim.POST;
  }
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateStore) {
    if (now - v.windowStart > RATE_WINDOW_MS * 2) rateStore.delete(k);
  }
}, RATE_WINDOW_MS * 5).unref();

module.exports = { isRateLimited, RATE_WINDOW_MS, RATE_MAX_GET, RATE_MAX_POST, RATE_MAX_AUTH };
