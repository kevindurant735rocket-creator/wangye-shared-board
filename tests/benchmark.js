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

function req(urlPath, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const reqObj = http.get({ hostname: HOST, port: PORT, path: urlPath, headers: { 'Connection': 'keep-alive', ...extraHeaders } }, (resp) => {
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => resolve({ status: resp.statusCode, ms: Date.now() - t0, body, headers: resp.headers }));
    });
    reqObj.on('error', reject);
    reqObj.setTimeout(5000, () => { reqObj.destroy(); reject(new Error('timeout')); });
  });
}

// /api/metrics 已鉴权（红队 R2-F4）：先走真实 captcha→login 换会话 cookie
async function loginAndGetCookie() {
  const cap = await req('/api/auth/captcha');
  const token = cap.headers['x-token'] || cap.headers['x-captcha-token'];
  const codeMatch = cap.body.match(/<text[^>]*>([^<]+)<\/text>/g) || [];
  const code = codeMatch.map(s => s.match(/>([^<]+)</)[1]).join('');
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ username: 'demo', password: 'demo1234', captchaToken: token, captchaCode: code });
    const r = http.request({
      hostname: HOST, port: PORT, path: '/api/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (resp) => {
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => {
        if (resp.statusCode !== 200) return reject(new Error('bench 登录失败 rc=' + resp.statusCode + ' ' + body.slice(0, 120)));
        const setCookie = resp.headers['set-cookie'] || [];
        const sid = setCookie.find(c => c.startsWith('sid='));
        resolve(sid ? sid.split(';')[0] : null);
      });
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
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

const { spawn } = require('child_process');

// 自起自停：无外部 server 时自起一个（BENCHMARK_MODE=1 跳过限流，否则 captcha 压测段全 429 无意义）
async function ensureServer() {
  const alive = await req('/health').then(() => true).catch(() => false);
  if (alive) return null; // 外部已起，按旧用法直连
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), AUTH_USERS: 'demo:demo1234', BENCHMARK_MODE: '1' },
    stdio: 'ignore',
    cwd: path.join(__dirname, '..'),
  });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const ok = await req('/health').then(() => true).catch(() => false);
    if (ok) return child;
  }
  child.kill();
  throw new Error(`自起 server 失败（:PORT ${PORT}）`);
}

async function main() {
  const child = await ensureServer();
  try {
    console.log(`Benchmark: target http://${HOST}:${PORT}, N=${N}, C=${CONCURRENCY}` + (child ? '（自起 server）' : '（外部 server）'));
    console.log('--- A. GET /health (静态最便宜) ---');
    const a = await concurrent(['/health'], N, CONCURRENCY);
    console.log(JSON.stringify(a, null, 2));
    console.log('\n--- B. GET /api/auth/captcha (含 SVG + crypto) ---');
    const b = await concurrent(['/api/auth/captcha'], Math.floor(N / 2), CONCURRENCY);
    console.log(JSON.stringify(b, null, 2));

    // 服务端聚合（需会话 cookie）
    console.log('\n--- C. 服务端聚合 /api/metrics ---');
    const cookie = await loginAndGetCookie();
    const c = await req('/api/metrics', cookie ? { Cookie: cookie } : {});
    if (c.status !== 200) {
      throw new Error('/api/metrics 读取失败 rc=' + c.status + '（鉴权门生效但 bench 未带上会话）');
    }
    let server = null;
    try { server = JSON.parse(c.body); } catch {}
    if (server) console.log(JSON.stringify(server, null, 2));

    const out = { health: a, captcha: b, serverMetrics: server, ts: new Date().toISOString() };
    const outPath = path.join(__dirname, 'benchmark-result.json');
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log('\n报告已落盘: ' + outPath);
    // 诚实退出码：A 段全军覆没=测不到任何东西
    if (a.okCount === 0) { console.error('基准失败：A 段 0 成功'); process.exitCode = 1; }
  } finally {
    if (child) child.kill();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
