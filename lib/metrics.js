/**
 * metrics.js — 极简进程内指标（Batch C: 可观测性）
 *
 * 目标：在不引入 prom-client / OpenTelemetry 的前提下，给后端路由打点，
 * 用于量化"瓶颈（响应时间/QPS）"指标，验证重构效果。
 *
 * 字段：
 *  - requests: 总请求数
 *  - errors: 4xx/5xx 计数
 *  - slowMs: 慢请求累计耗时（用于均值）
 *  - slowCount: 慢请求计数
 *  - perRoute: Map<routeKey, { count, errs, msSum, maxMs }>
 *
 * 线程安全：Node 单线程，无锁。
 *
 * 导出：snapshot() 拿当前快照；record(route, status, durMs) 记录一次。
 */
'use strict';

const metrics = {
  startAt: Date.now(),
  requests: 0,
  errors: 0,
  perRoute: new Map(),
};

function routeKeyOf(method, urlPath) {
  // 不解析 query，仅取 pathname
  const p = urlPath.split('?')[0];
  // 简化分类：/api/tasks/:id 归并到 /api/tasks/{id}
  return method.toUpperCase() + ' ' +
    p.replace(/\/api\/tasks\/[\w-]+/g, '/api/tasks/{id}')
     .replace(/\/api\/tasks\/[\w-]+\/actions/g, '/api/tasks/{id}/actions')
     .replace(/\/api\/notes\/\d{4}-\d{2}-\d{2}/g, '/api/notes/{date}')
     .replace(/\/(assets|fonts)\/[^/]+/g, '/$1/{file}');
}

function record(method, urlPath, status, durMs) {
  metrics.requests++;
  if (status >= 400) metrics.errors++;
  const key = routeKeyOf(method, urlPath);
  let entry = metrics.perRoute.get(key);
  if (!entry) {
    entry = { count: 0, errs: 0, msSum: 0, maxMs: 0 };
    metrics.perRoute.set(key, entry);
  }
  entry.count++;
  if (status >= 400) entry.errs++;
  entry.msSum += durMs;
  if (durMs > entry.maxMs) entry.maxMs = durMs;
}

function snapshot() {
  const routes = {};
  let p50Sum = 0, p95Count = 0, p99Count = 0;
  for (const [k, v] of metrics.perRoute) {
    routes[k] = {
      count: v.count,
      errs: v.errs,
      avgMs: v.count ? +(v.msSum / v.count).toFixed(2) : 0,
      maxMs: v.maxMs,
      errRate: v.count ? +(v.errs / v.count).toFixed(4) : 0,
    };
  }
  const elapsed = (Date.now() - metrics.startAt) / 1000;
  return {
    ok: true,
    uptimeSec: Math.floor(elapsed),
    qps: elapsed > 0 ? +(metrics.requests / elapsed).toFixed(2) : 0,
    totalRequests: metrics.requests,
    totalErrors: metrics.errors,
    routes,
    generatedAt: new Date().toISOString(),
  };
}

function reset() {
  metrics.startAt = Date.now();
  metrics.requests = 0;
  metrics.errors = 0;
  metrics.perRoute.clear();
}

module.exports = { record, snapshot, reset, routeKeyOf };
