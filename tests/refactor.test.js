/**
 * tests/refactor.test.js — 新模块最小自检
 *
 * 用法：node tests/refactor.test.js
 *
 * 覆盖：
 *   - http-utils：setSecurityHeaders / sendJson / collectBody / readSessionCookie / shortEtag
 *   - rate-limit：isRateLimited 桶隔离（auth 桶 vs default 桶）
 *   - notes-store：原子写 + 读回（tmp + rename）
 *   - metrics：record + snapshot 计数 / 路由聚合
 *   - route-table：精确匹配 + 路由参数 + 命中后不再继续
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const httpUtils = require('../lib/http-utils');
const rateLimit = require('../lib/rate-limit');
const notesStore = require('../lib/notes-store');
const metrics = require('../lib/metrics');
const { buildRouter } = require('../lib/route-table');

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✗ ' + name + '\n    ' + (e.stack || e.message));
  }
}

async function run() {
  console.log('\n[http-utils]');
  await test('shortEtag 相同内容相同', () => {
    const e1 = httpUtils.shortEtag('hello');
    const e2 = httpUtils.shortEtag('hello');
    assert.strictEqual(e1, e2);
  });
  await test('readSessionCookie 解析', () => {
    const fakeReq = { headers: { cookie: 'sid=abc123; theme=dark' } };
    assert.strictEqual(httpUtils.readSessionCookie(fakeReq), 'abc123');
  });
  await test('readSessionCookie 缺失', () => {
    assert.strictEqual(httpUtils.readSessionCookie({ headers: {} }), null);
  });
  await test('CSP 包含 default-src', () => {
    assert.ok(httpUtils.CSP_VALUE.includes("default-src 'self'"));
  });
  await test('sendJson 写入合法 JSON 头', () => {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        httpUtils.sendJson(res, 201, { ok: true });
      });
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        http.get({ hostname: '127.0.0.1', port, path: '/' }, (resp) => {
          let body = '';
          resp.on('data', c => body += c);
          resp.on('end', () => {
            try {
              assert.strictEqual(resp.statusCode, 201);
              assert.ok(resp.headers['content-type'].includes('application/json'));
              assert.strictEqual(JSON.parse(body).ok, true);
              server.close(resolve);
            } catch (e) { server.close(); reject(e); }
          });
        });
      });
    });
  });
  await test('collectBody 限制字节', () => {
    return new Promise((resolve, reject) => {
      const { Readable } = require('stream');
      const fakeReq = new Readable({
        read() {
          this.push(Buffer.alloc(200, 'x'));
          this.push(null);
        }
      });
      httpUtils.collectBody(fakeReq, 100).then(
        () => reject(new Error('should have thrown')),
        (e) => {
          try {
            assert.strictEqual(e.message, 'Request body too large');
            resolve();
          } catch (er) { reject(er); }
        }
      );
    });
  });

  console.log('\n[rate-limit]');
  await test('default 桶 GET 不触发', () => {
    const fakeReq = { method: 'GET', socket: { remoteAddress: '1.1.1.1' }, headers: {} };
    assert.strictEqual(rateLimit.isRateLimited(fakeReq, 'default'), false);
  });
  await test('RATE_MAX_GET 常量保持 120', () => {
    assert.strictEqual(rateLimit.RATE_MAX_GET, 120);
  });

  console.log('\n[notes-store]');
  await test('write + read 原子回写', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-test-'));
    process.env.NOTES_DATA_DIR = tmpDir;
    const w1 = notesStore.write(tmpDir, 'hello world');
    assert.strictEqual(w1.text, 'hello world');
    assert.ok(w1.updatedAt);
    const r = notesStore.read(tmpDir);
    assert.strictEqual(r.text, 'hello world');
    delete process.env.NOTES_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  await test('write 截断到 20000', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-test-'));
    process.env.NOTES_DATA_DIR = tmpDir;
    const big = 'x'.repeat(25000);
    const w = notesStore.write(tmpDir, big);
    assert.strictEqual(w.text.length, 20000);
    delete process.env.NOTES_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  console.log('\n[metrics]');
  await test('record + snapshot 计数', () => {
    metrics.reset();
    metrics.record('GET', '/api/notes', 200, 5);
    metrics.record('GET', '/api/notes', 200, 7);
    metrics.record('POST', '/api/notes', 401, 12);
    const snap = metrics.snapshot();
    assert.strictEqual(snap.totalRequests, 3);
    assert.strictEqual(snap.totalErrors, 1);
    const notesRoute = snap.routes['GET /api/notes'];
    assert.ok(notesRoute);
    assert.strictEqual(notesRoute.count, 2);
    assert.strictEqual(notesRoute.maxMs, 7);
  });
  await test('routeKeyOf 把 id 归并', () => {
    assert.strictEqual(
      metrics.routeKeyOf('GET', '/api/tasks/abc-123'),
      'GET /api/tasks/{id}'
    );
    assert.strictEqual(
      metrics.routeKeyOf('GET', '/api/notes/2024-09-03'),
      'GET /api/notes/{date}'
    );
  });

  console.log('\n[route-table]');
  await test('命中 handler 即视为已处理', async () => {
    const calls = [];
    const router = buildRouter([
      { method: 'GET', pattern: '/api/x', handler: () => { calls.push('x'); } },
      { method: 'GET', pattern: '/api/y', handler: () => { calls.push('y'); } },
    ]);
    const handled = await router.handle({ method: 'GET' }, {}, '/api/x', {});
    assert.strictEqual(handled, true);
    assert.deepStrictEqual(calls, ['x']);
  });
  await test('不匹配返回 false', async () => {
    const router = buildRouter([
      { method: 'GET', pattern: '/api/x', handler: () => {} },
    ]);
    const handled = await router.handle({ method: 'GET' }, {}, '/api/z', {});
    assert.strictEqual(handled, false);
  });
  await test('路由参数提取', async () => {
    let got = null;
    const router = buildRouter([
      { method: 'GET', pattern: '/api/x/:id', handler: (req, res, params) => { got = params; } },
    ]);
    await router.handle({ method: 'GET' }, {}, '/api/x/abc%20123', {});
    assert.strictEqual(got.id, 'abc 123');
  });
  await test('方法不匹配', async () => {
    let called = false;
    const router = buildRouter([
      { method: 'POST', pattern: '/api/x', handler: () => { called = true; } },
    ]);
    const handled = await router.handle({ method: 'GET' }, {}, '/api/x', {});
    assert.strictEqual(handled, false);
    assert.strictEqual(called, false);
  });

  console.log('\n=== 结果: ' + passed + ' passed, ' + failed + ' failed ===');
  process.exit(failed === 0 ? 0 : 1);
}

run();
