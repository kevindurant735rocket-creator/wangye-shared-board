/**
 * route-table.js — 路由注册表（Batch B: 路由集中管理）
 *
 * 把分散在 server.js createServer 内的 if/else if 链路替换为声明式路由表，
 * 便于：1) 一次性打点；2) 灰度/分流；3) 兼容层切换。
 *
 * 设计要点：
 *  - 每条路由 = { method, pattern, handler }
 *  - handler 接收 (req, res, params, helpers) 四个参数，helpers 暴露 sendJson 等
 *  - pattern 用 :param 占位，编译为正则
 *  - 兼容层：通过 env `LEGACY_ROUTES=1` 跳过注册表（保证回滚秒级生效）
 *
 * 数据/接口兼容：本表不引入新 URL，旧 URL 全部存在。
 */
'use strict';

function compilePattern(pattern) {
  const paramNames = [];
  const regexStr = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        paramNames.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp('^' + regexStr + '$'), paramNames };
}

function buildRouter(routes) {
  const compiled = routes.map((r) => ({
    method: r.method.toUpperCase(),
    ...compilePattern(r.pattern),
    handler: r.handler,
    name: r.name || `${r.method} ${r.pattern}`,
  }));
  return {
    async handle(req, res, pathname, helpers) {
      for (const r of compiled) {
        if (r.method !== req.method.toUpperCase()) continue;
        const m = pathname.match(r.regex);
        if (!m) continue;
        const params = {};
        r.paramNames.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
        await r.handler(req, res, params, helpers);
        return true; // 已匹配并执行，由 handler 自行负责写响应
      }
      return false; // no match
    },
    list() {
      return compiled.map((r) => r.name);
    },
  };
}

module.exports = { buildRouter, compilePattern };
