/**
 * tests/api.integration.test.js — HTTP 集成测试
 *
 * 启动真实 server，通过 HTTP 请求验证全部鉴权 + 验证码 API。
 * 覆盖 AC：
 *   - 登录页可访问且表单校验正确
 *   - 验证码可刷新且过期/错误有明确提示
 *   - 提交后按结果跳转或报错，接口联调通过
 *   - 空状态/加载态/错误态齐全
 *   - 关键路径有单测或自检脚本且通过
 *
 * 用法：node tests/api.integration.test.js
 */
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const SERVER_PORT = 3456;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;
let serverProc;

// ---------- helpers ----------
function httpReq(method, urlPath, body, cookies) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const opts = {
      hostname: '127.0.0.1',
      port: SERVER_PORT,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (cookies) opts.headers['Cookie'] = cookies;
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function extractCaptchaCode(svg) {
  const matches = svg.match(/<text[^>]*>([^<]+)<\/text>/g);
  if (!matches) return '';
  return matches.map((s) => s.match(/>([^<]+)</)[1]).join('');
}

function extractCookieSet(res, name) {
  const raw = res.headers['set-cookie'] || [];
  for (const c of raw) {
    if (c.startsWith(name + '=')) return c.split(';')[0];
  }
  return null;
}

// 走真实 captcha→login 流程换取会话 cookie（红队 R2 回归用例复用）
async function loginAndGetCookie() {
  const captchaR = await httpReq('GET', '/api/auth/captcha');
  const token = captchaR.headers['x-token'] || captchaR.headers['x-captcha-token'];
  const code = extractCaptchaCode(captchaR.body);
  const r = await httpReq('POST', '/api/auth/login', {
    username: 'demo', password: 'demo1234', captchaToken: token, captchaCode: code,
  });
  if (r.status !== 200) return null;
  return extractCookieSet(r, 'sid');
}

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result
        .then(() => { passed++; console.log(`  ✓ ${name}`); })
        .catch((e) => { failed++; failures.push(name); console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); });
    }
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push(name);
    console.error(`  ✗ ${name}\n    ${e.stack || e.message}`);
  }
}

// ---------- tests ----------
async function runTests() {
  console.log('\n[HTTP 集成测试]\n--- GET /health ---');

  await test('GET /health 返回 200', async () => {
    const r = await httpReq('GET', '/health');
    assert.strictEqual(r.status, 200);
    const d = JSON.parse(r.body);
    assert.strictEqual(d.ok, true);
    assert.ok(typeof d.uptime === 'number');
    // 版本单一真源 = package.json（部署 R3）
    assert.strictEqual(d.version, require('../package.json').version);
  });

  console.log('\n--- Captcha API ---');

  await test('GET /api/auth/captcha 返回 SVG + token', async () => {
    const r = await httpReq('GET', '/api/auth/captcha');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.startsWith('<svg'));
    assert.ok(r.headers['x-token'] || r.headers['x-captcha-token'],
      'should set X-Token or X-Captcha-Token header');
    assert.strictEqual(r.headers['content-type'], 'image/svg+xml; charset=utf-8');
  });

  await test('验证码错误返回 401', async () => {
    const r = await httpReq('GET', '/api/auth/captcha');
    const token = r.headers['x-token'] || r.headers['x-captcha-token'];
    assert.ok(token, 'need captcha token');
    const loginRes = await httpReq('POST', '/api/auth/login', {
      username: 'demo', password: 'demo1234', captchaToken: token, captchaCode: 'ZZZZ',
    });
    assert.ok(loginRes.status === 401, `expected 401, got ${loginRes.status}`);
    const d = JSON.parse(loginRes.body);
    assert.ok(d.error.includes('Captcha'), `error should mention captcha: ${d.error}`);
  });

  console.log('\n--- Login API ---');

  await test('错误密码返回 401', async () => {
    const captchaR = await httpReq('GET', '/api/auth/captcha');
    const token = captchaR.headers['x-token'] || captchaR.headers['x-captcha-token'];
    const code = extractCaptchaCode(captchaR.body);
    const r = await httpReq('POST', '/api/auth/login', {
      username: 'demo', password: 'wrongpass', captchaToken: token, captchaCode: code,
    });
    assert.strictEqual(r.status, 401);
    const d = JSON.parse(r.body);
    assert.ok(d.error.includes('username or password') || d.error.includes('Invalid'),
      `unexpected error: ${d.error}`);
  });

  await test('空 body 返回 400', async () => {
    const r = await httpReq('POST', '/api/auth/login', null);
    assert.ok(r.status >= 400, `expected 4xx, got ${r.status}`);
  });

  await test('缺字段返回 400', async () => {
    const r = await httpReq('POST', '/api/auth/login', { username: 'demo' });
    assert.ok(r.status >= 400, `expected 4xx, got ${r.status}`);
    const d = JSON.parse(r.body);
    assert.ok(d.error, 'should have error message');
  });

  await test('成功登录返回 cookie + 200', async () => {
    const captchaR = await httpReq('GET', '/api/auth/captcha');
    const token = captchaR.headers['x-token'] || captchaR.headers['x-captcha-token'];
    const code = extractCaptchaCode(captchaR.body);
    const r = await httpReq('POST', '/api/auth/login', {
      username: 'demo', password: 'demo1234', captchaToken: token, captchaCode: code,
    });
    assert.strictEqual(r.status, 200);
    const d = JSON.parse(r.body);
    assert.strictEqual(d.ok, true);
    assert.strictEqual(d.username, 'demo');
    const cookie = extractCookieSet(r, 'sid');
    assert.ok(cookie, 'should set sid cookie');
  });

  console.log('\n--- Session API ---');

  let sessionCookie = null;
  await test('GET /api/auth/me 携带有效 cookie 返回 200', async () => {
    const captchaR = await httpReq('GET', '/api/auth/captcha');
    const token = captchaR.headers['x-token'] || captchaR.headers['x-captcha-token'];
    const code = extractCaptchaCode(captchaR.body);
    const loginR = await httpReq('POST', '/api/auth/login', {
      username: 'demo', password: 'demo1234', captchaToken: token, captchaCode: code,
    });
    sessionCookie = extractCookieSet(loginR, 'sid');
    assert.ok(sessionCookie, 'need session cookie');
    const meR = await httpReq('GET', '/api/auth/me', null, sessionCookie);
    assert.strictEqual(meR.status, 200);
    const d = JSON.parse(meR.body);
    assert.strictEqual(d.ok, true);
    assert.ok(d.userId, 'should return userId');
  });

  await test('GET /api/auth/me 无 cookie 返回 401', async () => {
    const r = await httpReq('GET', '/api/auth/me');
    assert.strictEqual(r.status, 401);
  });

  await test('POST /api/auth/logout 清除 session', async () => {
    const r = await httpReq('POST', '/api/auth/logout', null, sessionCookie);
    assert.strictEqual(r.status, 200);
    const d = JSON.parse(r.body);
    assert.strictEqual(d.ok, true);
    const meR = await httpReq('GET', '/api/auth/me', null, sessionCookie);
    assert.strictEqual(meR.status, 401);
  });

  console.log('\n--- Security Headers ---');

  await test('响应包含安全头', async () => {
    const r = await httpReq('GET', '/health');
    assert.ok(r.headers['x-content-type-options'], 'missing X-Content-Type-Options');
    assert.ok(r.headers['x-frame-options'], 'missing X-Frame-Options');
    assert.ok(r.headers['content-security-policy'], 'missing CSP');
  });

  // 注意：限流用例放在文件末尾（见文末"Rate Limiting"组）——
  // auth 桶仅 10 次/分，若提前执行 15 连发会把后续登录流程测试的配额吃光（实测复现的顺序耦合）。

  console.log('\n--- Login Page ---');

  await test('未登录访问 / 返回 login.html', async () => {
    const r = await httpReq('GET', '/');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('loginForm'), 'should contain login form');
    assert.ok(r.body.includes('captchaCode'), 'should have captcha input');
  });

  await test('登录后访问 / 返回主页而非 login', async () => {
    const captchaR = await httpReq('GET', '/api/auth/captcha');
    const token = captchaR.headers['x-token'] || captchaR.headers['x-captcha-token'];
    const code = extractCaptchaCode(captchaR.body);
    const loginR = await httpReq('POST', '/api/auth/login', {
      username: 'demo', password: 'demo1234', captchaToken: token, captchaCode: code,
    });
    const cookie = extractCookieSet(loginR, 'sid');
    const r = await httpReq('GET', '/', null, cookie);
    assert.strictEqual(r.status, 200);
    assert.ok(!r.body.includes('loginForm'), 'should not show login form after auth');
  });

  console.log('\n--- CORS ---');

  await test('OPTIONS 返回 204 + CORS 头', async () => {
    const r = await httpReq('OPTIONS', '/api/auth/login');
    assert.strictEqual(r.status, 204);
    assert.ok(r.headers['access-control-allow-origin'], 'missing CORS origin');
  });

  console.log('\n--- 红队 R2 回归 ---');

  await test('畸形编码 URL /% 返回 400 且进程存活', async () => {
    const r = await httpReq('GET', '/%');
    assert.strictEqual(r.status, 400, '畸形编码应 400 而非崩掉整个进程');
    const h = await httpReq('GET', '/health');
    assert.strictEqual(h.status, 200, '攻击请求后服务必须仍存活');
  });

  await test('收藏 API 无 cookie 返回 401（GET/POST 双探）', async () => {
    const g = await httpReq('GET', '/api/bookmarks');
    assert.strictEqual(g.status, 401, '收藏列表必须鉴权');
    const p = await httpReq('POST', '/api/bookmarks', { title: 'x', url: 'https://example.com/x' });
    assert.strictEqual(p.status, 401, '收藏写入必须鉴权');
  });

  await test('收藏 API 携带有效 cookie 可用（200）', async () => {
    const cookie = await loginAndGetCookie();
    assert.ok(cookie, '登录应拿到 cookie');
    const g = await httpReq('GET', '/api/bookmarks', null, cookie);
    assert.strictEqual(g.status, 200, '带 cookie 的收藏读应成功');
    const d = JSON.parse(g.body);
    assert.strictEqual(d.ok, true);
  });

  await test('GET /api/share/:token 公开读不被鉴权拦截', async () => {
    const r = await httpReq('GET', '/api/share/not-exist-token');
    assert.notStrictEqual(r.status, 401, '分享读路由凭 token 语义应公开');
    assert.strictEqual(r.status, 404, '不存在的 token 应 404');
  });

  await test('GET /api/metrics 无 cookie 401 / 有 cookie 200', async () => {
    const no = await httpReq('GET', '/api/metrics');
    assert.strictEqual(no.status, 401, '观测面必须鉴权');
    const cookie = await loginAndGetCookie();
    const yes = await httpReq('GET', '/api/metrics', null, cookie);
    assert.strictEqual(yes.status, 200);
    assert.strictEqual(JSON.parse(yes.body).ok, true);
  });

  await test('顶层 app.js 缓存不再 immutable', async () => {
    const r = await httpReq('GET', '/app.js');
    assert.strictEqual(r.status, 200);
    const cc = r.headers['cache-control'] || '';
    assert.ok(cc.includes('max-age=600'), '顶层脚本应短缓存，实际: ' + cc);
    assert.ok(!cc.includes('immutable'), '无指纹文件不应 immutable，实际: ' + cc);
  });

  console.log('\n--- Rate Limiting ---');

  // 主套件跑在 BENCHMARK_MODE=1 下（限流关闭，见 startServer 调用处注释）；
  // 限流语义在此用独立 server 上验证：重置限流计数 + 15 连发应触发 429
  await test('auth 接口连续快速请求触发限流', async () => {
    await stopServer();
    await startServer({}); // 全新进程：限流桶从零开始
    let hit429 = false;
    for (let i = 0; i < 15; i++) {
      const r = await httpReq('GET', '/api/auth/captcha');
      if (r.status === 429) { hit429 = true; break; }
    }
    assert.ok(hit429, 'should trigger rate limit within 15 requests');
  });
}

// ---------- lifecycle ----------
function startServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(SERVER_PORT), AUTH_USERS: 'demo:demo1234', ...extraEnv };
    serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.join(__dirname, '..'),
    });
    let started = false;
    serverProc.stdout.on('data', (d) => {
      const s = d.toString();
      if (!started && s.includes('running')) { started = true; resolve(); }
    });
    serverProc.stderr.on('data', (d) => process.stderr.write('[srv] ' + d.toString()));
    serverProc.on('error', reject);
    setTimeout(() => { if (!started) { started = true; resolve(); } }, 4000);
  });
}

function stopServer() {
  if (serverProc) {
    serverProc.kill('SIGTERM');
    return new Promise((r) => setTimeout(r, 500));
  }
}

(async () => {
  try {
    // BENCHMARK_MODE=1 跳过限流：auth 桶仅 10 次/分，全套件 auth 请求数远超此数，
    // 不跳过会让中后段登录用例吃 429（captcha→token undefined→"Invalid captcha"，实测复现）
    await startServer({ BENCHMARK_MODE: '1' });
    await runTests();
  } catch (e) {
    console.error('Fatal:', e);
  } finally {
    await stopServer();
    console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
    if (failures.length) console.log('失败项:', failures.join(', '));
    process.exit(failed === 0 ? 0 : 1);
  }
})();

