/**
 * tests/session-persistence.test.js - 会话持久化自检
 *
 * 用法：
 *   node tests/session-persistence.test.js
 *
 * 覆盖：
 *  - startSession 后 sessions.json 落盘（原子写）
 *  - 重启模拟：清除 require 缓存后新实例 verifySession 仍通过
 *  - logout 落盘同步：新实例读不到已注销 token
 *  - 加载时丢弃已过期条目
 *  - 损坏文件不致命（视为无历史会话）
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e.stack || e.message)); }
}

// 每个用例独立 tmp 文件；SESSIONS_FILE 必须在 require 之前设置
function freshAuth(sessionFile) {
  process.env.SESSIONS_FILE = sessionFile;
  delete require.cache[require.resolve('../lib/auth')];
  return require('../lib/auth');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-sess-'));
const sessFile = path.join(dir, 'sessions.json');

test('startSession 落盘（原子写，无 .tmp 残留）', () => {
  const auth = freshAuth(sessFile);
  auth._clear();
  auth._forgetSessionsFile();
  const token = auth.startSession('u-persist-1');
  assert.ok(fs.existsSync(sessFile), 'sessions.json 应存在');
  assert.ok(!fs.existsSync(sessFile + '.tmp'), '不应残留 tmp 文件');
  const bag = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
  assert.ok(bag.sessions[token], 'token 应在盘上');
});

test('重启模拟：新实例读回会话并验证通过', () => {
  const auth1 = freshAuth(sessFile);
  const token = auth1.startSession('u-restart');
  const auth2 = freshAuth(sessFile); // 清缓存 = 模拟进程重启
  assert.strictEqual(auth2.verifySession(token), 'u-restart');
});

test('logout 同步出盘：新实例验证失败', () => {
  const auth1 = freshAuth(sessFile);
  const token = auth1.startSession('u-logout');
  assert.strictEqual(auth1.logout(token), true);
  const auth2 = freshAuth(sessFile);
  assert.strictEqual(auth2.verifySession(token), null);
});

test('加载时丢弃已过期条目', () => {
  const f = path.join(dir, 'expired.json');
  fs.writeFileSync(f, JSON.stringify({
    version: 1,
    sessions: {
      dead: { userId: 'u-dead', expiresAt: Date.now() - 1000 },
      alive: { userId: 'u-alive', expiresAt: Date.now() + 60000 },
    },
  }));
  const auth = freshAuth(f);
  assert.strictEqual(auth.verifySession('dead'), null);
  assert.strictEqual(auth.verifySession('alive'), 'u-alive');
});

test('损坏文件不致命（视为无历史会话）', () => {
  const f = path.join(dir, 'corrupt.json');
  fs.writeFileSync(f, '{not-json');
  const auth = freshAuth(f);
  const token = auth.startSession('u-after-corrupt');
  assert.strictEqual(auth.verifySession(token), 'u-after-corrupt');
});

console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
