/**
 * tests/benchmark.js — 瓶颈量化基准（响应时间/QPS）
 *
 * 用法：PORT=3456 node server.js &
 *       node tests/benchmark.js
 *
 * 通过 100 并发 GET /health + GET /api/auth/captcha 验证：
 *   - 平均响应时间 (ms)
 *   - P95 响应时间 (ms)
 *   - QPS（req/sec）
 *
 * 输出：JSON 格式指标报告，落盘到 tests/benchmark-result.json。
 *
 * 关键：衡量的是后端重构前后的对比基线；本脚本运行后会调用 /api/metrics
 * 获取服务端聚合数据，便于与客户端侧测量交叉验证。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3456;
const N = Number(process.env.N) || 200;       // 总请求数
const CONCURRENCY = Number(process.env.C) || 20;

function req(urlPath) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const reqObj = http.get({ hostname: HOST, port: PORT, path: urlPath, headers: { 'Connection': 'keep-alive' } }, (resp) => {
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => resolve({ status: resp.statusCode, ms: Date.now() - t0, body }));
    });
    reqObj.on('error', reject);
    reqObj.setTimeout(5000, () => { reqObj.destroy(); reject(new Error('timeout')); });
  });
}

function percentile(arr, p) {
  const sorted = arr.slice().sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function concurrent(paths, n, c) {
  const durations = [];
  const statuses = [];
  let cursor = 0;
  async function worker() {
    while (cursor < n) {
      const myIdx = cursor++;
      const urlPath = paths[myIdx % paths.length];
      try {
        const r = await req(urlPath);
        durations.push(r.ms);
        statuses.push(r.status);
      } catch {
        statuses.push(0);
      }
    }
  }
  const start = Date.now();
  await Promise.all(Array.from({ length: c }, worker));
  const elapsed = (Date.now() - start) / 1000;
  return {
    total: n,
    concurrency: c,
    elapsedSec: +elapsed.toFixed(3),
    qps: +(n / elapsed).toFixed(2),
    avgMs: +(durations.reduce((s, x) => s + x, 0) / Math.max(durations.length, 1)).toFixed(2),
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    maxMs: Math.max(0, ...durations),
    okCount: statuses.filter(s => s >= 200 && s < 400).length,
    errCount: statuses.filter(s => s >= 400 || s === 0).length,
    rateLimitedCount: statuses.filter(s => s === 429).length,
  };
}

async function main() {
  console.log(`Benchmark: target http://${HOST}:${PORT}, N=${N}, C=${CONCURRENCY}`);
  console.log('--- A. GET /health (静态最便宜) ---');
  const a = await concurrent(['/health'], N, CONCURRENCY);
  console.log(JSON.stringify(a, null, 2));
  console.log('\n--- B. GET /api/auth/captcha (含 SVG + crypto) ---');
  const b = await concurrent(['/api/auth/captcha'], Math.floor(N / 2), CONCURRENCY);
  console.log(JSON.stringify(b, null, 2));

  // 服务端聚合
  console.log('\n--- C. 服务端聚合 /api/metrics ---');
  const c = await req('/api/metrics');
  let server = null;
  try { server = JSON.parse(c.body); } catch {}
  if (server) console.log(JSON.stringify(server, null, 2));

  const out = { health: a, captcha: b, serverMetrics: server, ts: new Date().toISOString() };
  const outPath = path.join(__dirname, 'benchmark-result.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log('\n报告已落盘: ' + outPath);
}

main().catch(e => { console.error(e); process.exit(1); });
