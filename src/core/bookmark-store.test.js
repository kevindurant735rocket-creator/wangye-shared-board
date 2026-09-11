/**
 * bookmark-store.test.js — 数据层单测（t4 自检）
 * 运行：node --test src/core/bookmark-store.test.js src/core/bookmark-api.test.js
 *   （项目根 Documents/ai项目 下执行；注：`node --test src/core/` 在 Node 24 下
 *   不做目录发现，须显式列出测试文件）
 * 约束：零网络（autoSnapshot:false，prober 注入），覆盖 FR-01~FR-08 行为。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStore, normalizeUrl } = require('./bookmark-store');

function memStore(over = {}) {
  return createStore({ persistPath: null, autoSnapshot: false, ...over });
}

test('FR-01 创建：非法 URL 400 类错误', async () => {
  const s = memStore();
  await assert.rejects(() => s.create({ url: 'not-a-url' }), (e) => e.code === 'INVALID_URL');
  await assert.rejects(() => s.create({ url: 'ftp://x.com/a' }), (e) => e.code === 'INVALID_URL');
  await assert.rejects(() => s.create({}), (e) => e.code === 'INVALID_URL');
});

test('FR-01 去重：同一 URL（大小写/尾斜杠/Hash 归一）判重复', async () => {
  const s = memStore();
  const a = await s.create({ url: 'https://Example.com/price?a=1', title: '报价页' });
  assert.equal(a.bookmark.title, '报价页');
  await assert.rejects(() => s.create({ url: 'https://example.com/price?a=1/' }), (e) => e.code === 'DUPLICATE');
  await assert.rejects(() => s.create({ url: 'https://example.com/price?a=1#sec2' }), (e) => e.code === 'DUPLICATE');
  // DUPLICATE 携带已收藏卡片（PRD：提示"已收藏"并跳转）
  await assert.rejects(() => s.create({ url: 'https://example.com/price?a=1' }), (e) => {
    assert.ok(e.extra.existing.id === a.bookmark.id);
    return true;
  });
});

test('normalizeUrl：默认端口/Host 小写归一', () => {
  assert.equal(normalizeUrl('https://EXAMPLE.com:443/x/'), 'https://example.com/x');
  assert.equal(normalizeUrl('http://example.com:80/x'), 'http://example.com/x');
});

test('FR-04 检索：关键词/标签交集/客户/状态', async () => {
  const s = memStore();
  await s.create({ url: 'https://a.com/quote1', title: 'A 客户报价单', note: 'Q3 改价', tags: ['报价', 'A客户'], customer: 'A集团' });
  await s.create({ url: 'https://b.com/bid', title: 'B 招标公告', tags: ['招标'], customer: 'B公司' });
  await s.create({ url: 'https://c.com/quote2', title: 'C 报价', tags: ['报价'], customer: 'C公司' });

  assert.equal(s.list({ q: '报价' }).total, 2);
  assert.equal(s.list({ q: 'Q3 改价' }).total, 1);
  assert.equal(s.list({ tag: '报价' }).total, 2);
  assert.equal(s.list({ tag: ['报价', 'A客户'] }).total, 1); // 交集
  assert.equal(s.list({ customer: 'B公司' }).total, 1);
  assert.equal(s.list({ customer: 'b公司' }).total, 1); // 大小写不敏感
});

test('FR-04 非法 status 抛错', async () => {
  const s = memStore();
  assert.throws(() => s.list({ status: 'zzz' }), (e) => e.code === 'INVALID_FIELD');
});

test('FR-05 编辑/软删/恢复/彻底删除', async () => {
  const s = memStore();
  const { bookmark } = await s.create({ url: 'https://a.com/1', title: '旧标题', tags: ['x'] });
  const edited = s.update(bookmark.id, { title: '新标题', note: '为什么存：会前报价依据', tags: ['报价', 'A客户'], customer: 'A集团' });
  assert.equal(edited.title, '新标题');
  assert.deepEqual(edited.tags, ['报价', 'a客户']); // 标签小写归一
  assert.throws(() => s.update(bookmark.id, { url: 'https://x.com' }), (e) => e.code === 'INVALID_FIELD'); // url 不可改
  assert.throws(() => s.update('nope', { title: 't' }), (e) => e.code === 'NOT_FOUND');

  const del = s.remove(bookmark.id);
  assert.equal(del.status, 'archived');
  assert.ok(del.deletedAt);
  assert.equal(s.list({}).total, 0); // 默认列表隐藏回收站
  assert.equal(s.list({ status: 'archived' }).total, 1);
  const restored = s.update(bookmark.id, { status: 'normal' }); // 恢复
  assert.equal(restored.status, 'normal');
  assert.equal(s.list({}).total, 1);
  const hard = s.remove(bookmark.id, { hard: true });
  assert.equal(hard.hard, true);
  assert.throws(() => s.get(bookmark.id), (e) => e.code === 'NOT_FOUND');
});

test('FR-06 分享：token 不可猜解 + 访问计数 + 关闭', async () => {
  const s = memStore();
  const { bookmark } = await s.create({ url: 'https://a.com/shared', title: '分享页' });
  const sh1 = s.share(bookmark.id);
  const sh2 = s.share(bookmark.id);
  assert.equal(sh1.token, sh2.token); // 幂等
  assert.match(sh1.token, /^[0-9a-f]{32}$/);
  assert.equal(sh1.shareUrl, `/api/share/${sh1.token}`);
  const v1 = s.openShared(sh1.token);
  const v2 = s.openShared(sh1.token);
  assert.equal(v2.visitCount, v1.visitCount + 1);
  assert.equal(s.get(bookmark.id).visitCount, 2);
  s.unshare(bookmark.id);
  assert.throws(() => s.openShared(sh1.token), (e) => e.code === 'NOT_FOUND');
  // 回收站条目不可分享
  s.remove(bookmark.id);
  assert.throws(() => s.share(bookmark.id), (e) => e.code === 'INVALID_STATE');
});

test('FR-07 坏链探测：首次失败 suspect，连续两次 dead，恢复后 normal', async () => {
  let alive = false;
  const s = memStore({ prober: async () => (alive ? { alive: true, httpStatus: 200, reason: '' } : { alive: false, httpStatus: 500, reason: 'HTTP 500' }) });
  const { bookmark } = await s.create({ url: 'https://a.com/flaky' });
  const c1 = await s.check(bookmark.id);
  assert.equal(c1.status, 'suspect');
  assert.equal(c1.checkFailCount, 1);
  const c2 = await s.check(bookmark.id);
  assert.equal(c2.status, 'dead');
  alive = true;
  const c3 = await s.check(bookmark.id);
  assert.equal(c3.status, 'normal');
  assert.equal(c3.checkFailCount, 0);
});

test('FR-03 规则推荐：同域名历史标签优先', async () => {
  const s = memStore();
  await s.create({ url: 'https://shop.com/a', tags: ['报价', '竞品'] });
  await s.create({ url: 'https://shop.com/b', tags: ['报价'] });
  await s.create({ url: 'https://other.com/c', tags: ['话术'] });
  assert.deepEqual(s.suggestTags('https://shop.com/d'), ['报价', '竞品']);
  assert.deepEqual(s.suggestTags('https://unknown.com/x'), []);
  assert.deepEqual(s.suggestTags('not-url'), []);
});

test('FR-08 导入：H3 文件夹→分类，去重，失败行可查', async () => {
  const s = memStore();
  await s.create({ url: 'https://dup.com/old', title: '已存在' });
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
<DT><H3>客户资料</H3>
<DL><p>
<DT><A HREF="https://a.com/1">报价页 A</A>
<DT><A HREF="https://dup.com/old">重复旧链</A>
<DT><A HREF="notaurl">坏行</A>
</DL><p>
<DT><H3>竞品</H3>
<DL><p>
<DT><A HREF="https://b.com/2">竞品 B</A>
</DL><p>
</DL><p>`;
  const r = await s.importHtml(html);
  assert.equal(r.imported, 2);
  assert.equal(r.duplicates, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.errors.length, 1);
  assert.equal(s.list({ category: '客户资料' }).total, 1);
  assert.equal(s.list({}).total, 3);
  await assert.rejects(() => s.importHtml(''), (e) => e.code === 'INVALID_FIELD');
});

test('分页与排序：latest 倒序，limit 上限 200', async () => {
  const s = memStore();
  for (let i = 0; i < 5; i++) {
    await s.create({ url: `https://p.com/${i}`, title: `t${i}` });
  }
  const page = s.list({ limit: 2, offset: 1 });
  assert.equal(page.items.length, 2);
  assert.equal(page.total, 5);
  const all = s.list({}).items;
  assert.ok(all[0].createdAt >= all[all.length - 1].createdAt);
  assert.equal(s.list({ limit: 999 }).limit, 200);
});

test('stats：状态分布计数', async () => {
  const s = memStore({ prober: async () => ({ alive: false, httpStatus: 404, reason: 'HTTP 404' }) });
  const a = await s.create({ url: 'https://s.com/1' });
  await s.create({ url: 'https://s.com/2' });
  await s.check(a.bookmark.id);
  s.remove((await s.create({ url: 'https://s.com/3' })).bookmark.id);
  const st = s.stats();
  assert.equal(st.total, 3);
  assert.equal(st.byStatus.suspect, 1);
  assert.equal(st.byStatus.archived, 1);
  assert.equal(st.byStatus.normal, 1);
});
