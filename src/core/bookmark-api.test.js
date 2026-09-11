/**
 * bookmark-api.test.js — HTTP 层集成测试（t4 自检）
 * 运行：node --test src/core/bookmark-store.test.js src/core/bookmark-api.test.js
 * （项目根 Documents/ai项目 下执行；注：`node --test src/core/` 在 Node 24 下
 * 不做目录发现，须显式列出测试文件）
 * 起独立进程（127.0.0.1 随机端口），全链路走真实 HTTP：创建→检索→编辑→
 * 分享→只读打开计数→坏链探测→导入→软删→恢复→彻底删除。零外网依赖。
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('./bookmark-store');
const { createServer } = require('./bookmark-api');

let base = '';
let server = null;
let store = null;

before(async () => {
  store = createStore({
    persistPath: null,
    fetcher: async () => { throw new Error('offline fixture'); },
    prober: async (url) => (url.includes('dead-site')
      ? { alive: false, httpStatus: 404, reason: 'HTTP 404' }
      : { alive: true, httpStatus: 200, reason: '' }),
  });
  server = await createServer(store, 0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

async function api(method, path, body) {
  const resp = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await resp.json();
  return { status: resp.status, json };
}

test('全链路：收藏→检索→编辑→分享→计数→探测→删除→恢复', async () => {
  // FR-01 创建
  const c = await api('POST', '/api/bookmarks', {
    url: 'https://acme.com/quote-q3', title: 'Acme Q3 报价', note: '会前依据',
    tags: ['报价'], customer: 'Acme', categoryL1: '客户资料', source: 'manual',
  });
  assert.equal(c.status, 201);
  assert.equal(c.json.bookmark.title, 'Acme Q3 报价');
  const id = c.json.bookmark.id;

  // 重复 → 409 + existing
  const dup = await api('POST', '/api/bookmarks', { url: 'https://acme.com/quote-q3' });
  assert.equal(dup.status, 409);
  assert.ok(dup.json.existing.id === id);

  // 非法 URL → 400 + reason 直显
  const bad = await api('POST', '/api/bookmarks', { url: '::bad::' });
  assert.equal(bad.status, 400);
  assert.ok(typeof bad.json.reason === 'string' && bad.json.reason.length > 0);

  // FR-04 检索
  const q = await api('GET', '/api/bookmarks?q=acme');
  assert.equal(q.json.total, 1);
  const qt = await api('GET', '/api/bookmarks?tag=' + encodeURIComponent('报价'));
  assert.equal(qt.json.total, 1);
  const qc = await api('GET', '/api/bookmarks?customer=acme');
  assert.equal(qc.json.total, 1);

  // FR-05 编辑
  const p = await api('PATCH', `/api/bookmarks/${id}`, { note: '改价后以此为准', tags: ['报价', '重点客户'] });
  assert.equal(p.status, 200);
  assert.deepEqual(p.json.bookmark.tags, ['报价', '重点客户']);

  // FR-06 分享 + 只读打开计数（免登录）
  const sh = await api('POST', `/api/bookmarks/${id}/share`);
  assert.equal(sh.status, 201);
  assert.match(sh.json.token, /^[0-9a-f]{32}$/);
  const o1 = await api('GET', sh.json.shareUrl);
  assert.equal(o1.json.bookmark.visitCount, 1);
  const o2 = await api('GET', sh.json.shareUrl);
  assert.equal(o2.json.bookmark.visitCount, 2);

  // 快照视图（抓取失败 → failed 可感知 + 可重试，卡片保留）
  const snap = await api('GET', `/api/bookmarks/${id}/snapshot`);
  assert.equal(snap.json.snapshot.status, 'failed');

  // 删除 → 默认列表隐藏 → 恢复
  const del = await api('DELETE', `/api/bookmarks/${id}`);
  assert.equal(del.json.status, 'archived');
  assert.equal((await api('GET', '/api/bookmarks')).json.total, 0);
  const rst = await api('PATCH', `/api/bookmarks/${id}`, { status: 'normal' });
  assert.equal(rst.json.bookmark.status, 'normal');

  // 彻底删除
  const hard = await api('DELETE', `/api/bookmarks/${id}?hard=true`);
  assert.equal(hard.json.hard, true);
  assert.equal((await api('GET', `/api/bookmarks/${id}`)).status, 404);
});

test('FR-07 坏链：dead 样本两次探测判 dead；正常样本 normal', async () => {
  const d = await api('POST', '/api/bookmarks', { url: 'https://dead-site.example/gone', title: '下线页' });
  const did = d.json.bookmark.id;
  const k1 = await api('POST', `/api/bookmarks/${did}/check`);
  assert.equal(k1.json.bookmark.status, 'suspect');
  const k2 = await api('POST', `/api/bookmarks/${did}/check`);
  assert.equal(k2.json.bookmark.status, 'dead');

  const g = await api('POST', '/api/bookmarks', { url: 'https://alive.example/ok', title: '正常页' });
  const k3 = await api('POST', `/api/bookmarks/${g.json.bookmark.id}/check`);
  assert.equal(k3.json.bookmark.status, 'normal');
});

test('FR-08 导入 + 标签推荐 + stats', async () => {
  const html = '<DL><p><DT><H3>招标</H3><DL><p><DT><A HREF="https://bid.example/2026-01">招标 01</A></DL><p></DL><p>';
  const im = await api('POST', '/api/bookmarks/import', { html });
  assert.equal(im.status, 200);
  assert.equal(im.json.imported, 1);
  const sg = await api('GET', '/api/tags/suggest?url=' + encodeURIComponent('https://bid.example/x'));
  assert.equal(sg.status, 200);
  const st = await api('GET', '/api/bookmarks-stats');
  assert.ok(st.json.total >= 3);
  assert.ok(typeof st.json.byStatus.normal === 'number');
});

test('错误契约：404 / 非法 status / 关闭分享后只读失效', async () => {
  assert.equal((await api('GET', '/api/bookmarks/no-such-id')).status, 404);
  const c = await api('POST', '/api/bookmarks', { url: 'https://unshare.example/a', title: '待关' });
  const id = c.json.bookmark.id;
  const bad = await api('PATCH', `/api/bookmarks/${id}`, { status: 'zzz' });
  assert.equal(bad.status, 400);
  const sh = await api('POST', `/api/bookmarks/${id}/share`);
  assert.equal((await api('DELETE', `/api/bookmarks/${id}/share`)).status, 200);
  assert.equal((await api('GET', sh.json.shareUrl)).status, 404);
  assert.equal((await api('GET', '/api/nope')).status, 404);
});
