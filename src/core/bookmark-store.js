/**
 * bookmark-store.js — 网页收藏数据层（t4 后端实现）
 *
 * 上游契约：dispatch-B PRD t1 §5.2 数据模型（冻结字段）+ §5.3 端点 + FR-01~FR-08。
 * 冻结 13 字段（API 原样输出，不得改名/删减）：
 *   id, url, title, snapshotUrl, note, tags[], customer,
 *   categoryL1, categoryL2, source, status, createdAt, updatedAt, visitCount
 *   其中 status ∈ normal / suspect / dead / archived。
 * 运维扩展字段（实现必需，output.md §契约 drift 声明）：
 *   urlNorm（去重键）, deletedAt（回收站 30 天依据）,
 *   snapshotStatus（pending/ready/failed，快照可感知）,
 *   snapshotText（文本快照存档，PRD 三选一之一定"文本"）,
 *   shareToken（分享链接随机 token）, lastCheckedAt / checkFailCount（坏链探测）。
 *
 * 零依赖，纯 CommonJS；可在 网页/server.js 与单测中共同 require。
 * 持久化：JSON 文件原子写（tmp + rename），persistPath 为空则纯内存（单测用）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATUS = ['normal', 'suspect', 'dead', 'archived'];
const MAX_TAGS = 20;
const MAX_NOTE = 2000;
const MAX_TITLE = 300;
const TRASH_KEEP_MS = 30 * 24 * 3600 * 1000;
const SNAPSHOT_TEXT_LIMIT = 4000;

function nowIso(d) {
  return (d || new Date()).toISOString();
}

function genId() {
  return 'bm_' + crypto.randomBytes(9).toString('hex');
}

function genToken() {
  return crypto.randomBytes(16).toString('hex'); // 128bit，不可猜解
}

/** URL 归一化（去重/合并依据）。非法则抛 INVALID_URL。 */
function normalizeUrl(raw) {
  if (typeof raw !== 'string') throw err('INVALID_URL', 'url 必须是字符串');
  const s = raw.trim();
  if (!s) throw err('INVALID_URL', 'url 不能为空');
  let u;
  try {
    u = new URL(s);
  } catch {
    throw err('INVALID_URL', '非法 URL（需 http/https 开头）');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw err('INVALID_URL', '仅支持 http/https 链接');
  }
  u.hash = '';
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }
  u.hostname = u.hostname.toLowerCase();
  let out = u.toString();
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

function err(code, reason, extra) {
  const e = new Error(reason);
  e.code = code;
  e.reason = reason;
  if (extra) e.extra = extra;
  return e;
}

function cleanStr(v, max, field) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw err('INVALID_FIELD', `${field} 必须是字符串`);
  const s = v.trim();
  if (s.length > max) throw err('INVALID_FIELD', `${field} 超长（上限 ${max}）`);
  return s;
}

function cleanTags(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw err('INVALID_FIELD', 'tags 必须是数组');
  const out = [];
  for (const t of v) {
    if (typeof t !== 'string') throw err('INVALID_FIELD', 'tag 必须是字符串');
    const s = t.trim().toLowerCase();
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** 从 HTML 标题/正文抓快照文本（文本快照版）。fetcher 可注入（单测/离线用）。 */
async function captureSnapshot(urlNorm, fetcher) {
  const fetchFn = fetcher || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const resp = await fetchFn(urlNorm, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'BookmarkCollector/1.0 (+snapshot)', Accept: 'text/html,*/*' },
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!resp.ok) {
      return { ok: false, reason: `HTTP ${resp.status}`, title: '', text: '' };
    }
    const html = buf.slice(0, 512 * 1024).toString('utf8');
    const title = (html.match(/<title[^>]*>([\s\S]{1,300})<\/title>/i) || [])[1] || '';
    const desc = (html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']{1,500})/i) || [])[1] || '';
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, SNAPSHOT_TEXT_LIMIT);
    return {
      ok: true,
      title: title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE),
      text: (desc ? desc + '\n' : '') + text,
    };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? '抓取超时（8s）' : `抓取失败：${e.message || e}`, title: '', text: '' };
  } finally {
    clearTimeout(timer);
  }
}

/** 默认坏链探测：HEAD 优先，失败回退 GET。返回 {alive, httpStatus, reason}。probe 可注入。 */
async function defaultProbe(urlNorm) {
  const fetchFn = globalThis.fetch;
  const run = async (method) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const resp = await fetchFn(urlNorm, { method, signal: ctrl.signal, redirect: 'follow' });
      return { status: resp.status };
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    let r;
    try {
      r = await run('HEAD');
    } catch {
      r = await run('GET');
    }
    const s = r.status;
    if (s >= 200 && s < 400) return { alive: true, httpStatus: s, reason: '' };
    return { alive: false, httpStatus: s, reason: `HTTP ${s}` };
  } catch (e) {
    return {
      alive: false,
      httpStatus: 0,
      reason: e && e.name === 'AbortError' ? '探测超时（8s）' : `网络不可达：${e.message || e}`,
    };
  }
}

function createStore(opts = {}) {
  const persistPath = opts.persistPath || null;
  const autoSnapshot = opts.autoSnapshot !== false; // 单测可关
  const fetcher = opts.fetcher || null; // 快照抓取注入
  const prober = opts.prober || defaultProbe; // 坏链探测注入
  const nowFn = opts.now || (() => new Date());

  const byId = new Map(); // id -> record
  const byUrl = new Map(); // urlNorm -> id
  const byToken = new Map(); // shareToken -> id

  function persist() {
    if (!persistPath) return;
    try {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      const tmp = persistPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: [...byId.values()] }, null, 1));
      fs.renameSync(tmp, persistPath);
    } catch (e) {
      // 持久化失败不阻断内存写入，但打日志便于排查
      console.error(JSON.stringify({ ts: nowIso(), level: 'error', msg: 'bookmark persist failed', error: String(e) }));
    }
  }

  function load() {
    if (!persistPath || !fs.existsSync(persistPath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
      for (const r of data.items || []) {
        if (!r.id || !r.urlNorm) continue;
        byId.set(r.id, r);
        byUrl.set(r.urlNorm, r.id);
        if (r.shareToken) byToken.set(r.shareToken, r.id);
      }
    } catch (e) {
      console.error(JSON.stringify({ ts: nowIso(), level: 'error', msg: 'bookmark load failed', error: String(e) }));
    }
  }

  /** 对外输出：冻结 13 字段 + 运维字段（显式分组，避免契约漂移误读）。 */
  function publicView(r) {
    return {
      id: r.id,
      url: r.url,
      title: r.title,
      snapshotUrl: r.snapshotUrl,
      note: r.note,
      tags: [...r.tags],
      customer: r.customer,
      categoryL1: r.categoryL1,
      categoryL2: r.categoryL2,
      source: r.source,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      visitCount: r.visitCount,
      // 运维扩展（t4 新增提案，见 output.md §契约）：
      snapshotStatus: r.snapshotStatus,
      deletedAt: r.deletedAt || null,
      lastCheckedAt: r.lastCheckedAt || null,
      checkFailCount: r.checkFailCount || 0,
      hasShareLink: !!r.shareToken,
    };
  }

  function touch(r) {
    r.updatedAt = nowIso(nowFn());
  }

  function makeRecord(input) {
    const urlNorm = normalizeUrl(input.url);
    const t = nowIso(nowFn());
    return {
      id: genId(),
      url: input.url.trim(),
      urlNorm,
      title: cleanStr(input.title || '', MAX_TITLE, 'title'),
      snapshotUrl: null,
      snapshotStatus: 'pending',
      snapshotText: '',
      note: cleanStr(input.note || '', MAX_NOTE, 'note'),
      tags: cleanTags(input.tags),
      customer: cleanStr(input.customer || '', 120, 'customer'),
      categoryL1: cleanStr(input.categoryL1 || '', 60, 'categoryL1'),
      categoryL2: cleanStr(input.categoryL2 || '', 60, 'categoryL2'),
      source: cleanStr(input.source || 'manual', 60, 'source'),
      status: 'normal',
      createdAt: t,
      updatedAt: t,
      visitCount: 0,
      shareToken: null,
      deletedAt: null,
      lastCheckedAt: null,
      checkFailCount: 0,
    };
  }

  async function fillSnapshot(r) {
    if (!autoSnapshot) return r;
    try {
      const snap = await captureSnapshot(r.urlNorm, fetcher);
      if (snap.ok) {
        if (!r.title && snap.title) r.title = snap.title;
        r.snapshotText = snap.text;
        r.snapshotStatus = 'ready';
        r.snapshotUrl = `/api/bookmarks/${r.id}/snapshot`;
      } else {
        r.snapshotStatus = 'failed';
        r.snapshotFailReason = snap.reason;
      }
    } catch (e) {
      r.snapshotStatus = 'failed';
      r.snapshotFailReason = String((e && e.message) || e);
    }
    touch(r);
    return r;
  }

  const store = {
    STATUS: [...STATUS],

    /** FR-01 一键收藏。重复 URL 抛 DUPLICATE（extra.existing 为已收藏卡片）。 */
    async create(input = {}) {
      const urlNorm = normalizeUrl(input.url);
      const dupId = byUrl.get(urlNorm);
      if (dupId && byId.has(dupId)) {
        const existing = byId.get(dupId);
        throw err('DUPLICATE', '该链接已收藏', { existing: publicView(existing) });
      }
      const r = makeRecord(input);
      byId.set(r.id, r);
      byUrl.set(urlNorm, r.id);
      await fillSnapshot(r);
      persist();
      return { bookmark: publicView(r), suggestedTags: store.suggestTags(r.url) };
    },

    /** FR-04 检索：关键词（标题/备注/URL）+ 标签交集 + 客户 + 状态 + 分类。 */
    list(query = {}) {
      const q = (query.q || '').trim().toLowerCase();
      const tags = cleanTags(query.tag !== undefined ? (Array.isArray(query.tag) ? query.tag : [query.tag]) : (query.tags || []));
      const customer = (query.customer || '').trim().toLowerCase();
      const status = (query.status || '').trim();
      const category = (query.category || '').trim().toLowerCase();
      const sort = query.sort === 'visited' ? 'visited' : 'latest';
      const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(query.offset, 10) || 0, 0);

      let items = [...byId.values()];
      if (status) {
        if (!STATUS.includes(status)) throw err('INVALID_FIELD', `status 非法（${STATUS.join('/')}）`);
        items = items.filter((r) => r.status === status);
      } else {
        items = items.filter((r) => r.status !== 'archived' || r.deletedAt); // 默认隐藏回收站？不：默认列出非 archived
        items = items.filter((r) => r.status !== 'archived');
      }
      if (q) {
        items = items.filter(
          (r) =>
            r.title.toLowerCase().includes(q) ||
            r.note.toLowerCase().includes(q) ||
            r.url.toLowerCase().includes(q) ||
            r.snapshotText.toLowerCase().includes(q) // P1 全文检索的最小形态：快照文本参与匹配
        );
      }
      if (tags.length) items = items.filter((r) => tags.every((t) => r.tags.includes(t)));
      if (customer) items = items.filter((r) => r.customer.toLowerCase().includes(customer));
      if (category) {
        items = items.filter(
          (r) => r.categoryL1.toLowerCase() === category || r.categoryL2.toLowerCase() === category
        );
      }
      items.sort((a, b) =>
        sort === 'visited'
          ? (b.lastVisitedAt || b.createdAt).localeCompare(a.lastVisitedAt || a.createdAt)
          : b.createdAt.localeCompare(a.createdAt)
      );
      const total = items.length;
      return { items: items.slice(offset, offset + limit).map(publicView), total, limit, offset };
    },

    get(id) {
      const r = byId.get(id);
      if (!r) throw err('NOT_FOUND', '收藏不存在');
      return publicView(r);
    },

    /** FR-05 编辑（含恢复：PATCH {status:'normal'} 可把回收站条目恢复）。 */
    update(id, patch = {}) {
      const r = byId.get(id);
      if (!r) throw err('NOT_FOUND', '收藏不存在');
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        throw err('INVALID_FIELD', 'body 必须是对象');
      }
      const allow = ['title', 'note', 'tags', 'customer', 'categoryL1', 'categoryL2', 'status'];
      for (const k of Object.keys(patch)) {
        if (!allow.includes(k)) throw err('INVALID_FIELD', `不允许修改字段：${k}`);
      }
      if (patch.title !== undefined) r.title = cleanStr(patch.title, MAX_TITLE, 'title');
      if (patch.note !== undefined) r.note = cleanStr(patch.note, MAX_NOTE, 'note');
      if (patch.tags !== undefined) r.tags = cleanTags(patch.tags);
      if (patch.customer !== undefined) r.customer = cleanStr(patch.customer, 120, 'customer');
      if (patch.categoryL1 !== undefined) r.categoryL1 = cleanStr(patch.categoryL1, 60, 'categoryL1');
      if (patch.categoryL2 !== undefined) r.categoryL2 = cleanStr(patch.categoryL2, 60, 'categoryL2');
      if (patch.status !== undefined) {
        if (!STATUS.includes(patch.status)) throw err('INVALID_FIELD', `status 非法（${STATUS.join('/')}）`);
        r.status = patch.status;
        r.deletedAt = patch.status === 'archived' ? r.deletedAt || nowIso(nowFn()) : null;
      }
      touch(r);
      persist();
      return publicView(r);
    },

    /** FR-05 删除：默认软删进回收站（status=archived + deletedAt）；hard=true 彻底删除。 */
    remove(id, { hard = false } = {}) {
      const r = byId.get(id);
      if (!r) throw err('NOT_FOUND', '收藏不存在');
      if (hard) {
        byId.delete(id);
        byUrl.delete(r.urlNorm);
        if (r.shareToken) byToken.delete(r.shareToken);
        persist();
        return { ok: true, hard: true, id };
      }
      r.status = 'archived';
      r.deletedAt = nowIso(nowFn());
      touch(r);
      persist();
      return { ok: true, hard: false, ...publicView(r) };
    },

    /** FR-06 生成只读分享链接（token 不可猜解）。 */
    share(id) {
      const r = byId.get(id);
      if (!r) throw err('NOT_FOUND', '收藏不存在');
      if (r.status === 'archived') throw err('INVALID_STATE', '回收站条目不可分享（请先恢复）');
      if (!r.shareToken) {
        r.shareToken = genToken();
        byToken.set(r.shareToken, r.id);
      }
      touch(r);
      persist();
      return { token: r.shareToken, shareUrl: `/api/share/${r.shareToken}`, id: r.id };
    },

    unshare(id) {
      const r = byId.get(id);
      if (!r) throw err('NOT_FOUND', '收藏不存在');
      if (r.shareToken) byToken.delete(r.shareToken);
      r.shareToken = null;
      touch(r);
      persist();
      return { ok: true, id };
    },

    /** FR-06 只读打开（免登录）+ 访问计数 PV。 */
    openShared(token) {
      const id = byToken.get(token);
      const r = id && byId.get(id);
      if (!r || r.status === 'archived') throw err('NOT_FOUND', '分享链接无效或已关闭');
      r.visitCount += 1;
      r.lastVisitedAt = nowIso(nowFn());
      persist();
      const v = publicView(r);
      v.snapshotText = r.snapshotText; // 分享 reception 含快照正文（外部免登录可看）
      return v;
    },

    getSnapshot(id) {
      const r = byId.get(id);
      if (!r) throw err('NOT_FOUND', '收藏不存在');
      return {
        id: r.id,
        url: r.url,
        title: r.title,
        status: r.snapshotStatus,
        failReason: r.snapshotStatus === 'failed' ? r.snapshotFailReason || '未知原因' : null,
        capturedAt: r.updatedAt,
        text: r.snapshotText || '',
      };
    },

    /** 快照重试（失败可重试 + 可感知）。 */
    async retrySnapshot(id) {
      const r = byId.get(id);
      if (!r) throw err('NOT_FOUND', '收藏不存在');
      r.snapshotStatus = 'pending';
      await fillSnapshot(r);
      persist();
      return store.getSnapshot(id);
    },

    /** FR-07 坏链探测：连续两次失败判 dead，首次失败/超时判 suspect。 */
    async check(id) {
      const r = byId.get(id);
      if (!r) throw err('NOT_FOUND', '收藏不存在');
      const res = await prober(r.urlNorm);
      r.lastCheckedAt = nowIso(nowFn());
      if (res.alive) {
        r.status = 'normal';
        r.checkFailCount = 0;
        r.lastProbe = { httpStatus: res.httpStatus, at: r.lastCheckedAt };
      } else {
        r.checkFailCount = (r.checkFailCount || 0) + 1;
        r.lastProbe = { httpStatus: res.httpStatus, reason: res.reason, at: r.lastCheckedAt };
        r.status = r.checkFailCount >= 2 ? 'dead' : 'suspect';
      }
      touch(r);
      persist();
      return { ...publicView(r), lastProbe: r.lastProbe };
    },

    /** FR-03 规则推荐标签（非 AI）：同域名历史高频标签优先。 */
    suggestTags(url, limit = 5) {
      let host = '';
      try {
        host = new URL(url.trim()).hostname.toLowerCase();
      } catch {
        return [];
      }
      const freq = new Map();
      for (const r of byId.values()) {
        try {
          if (new URL(r.url).hostname.toLowerCase() === host) {
            for (const t of r.tags) freq.set(t, (freq.get(t) || 0) + 1);
          }
        } catch { /* 忽略脏数据 */ }
      }
      return [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([t]) => t);
    },

    /** FR-08 Chrome 书签 HTML 导入：H3 文件夹→categoryL1，URL 去重，失败行可跳过可查。 */
    async importHtml(html) {
      if (typeof html !== 'string' || !html) throw err('INVALID_FIELD', 'html 不能为空');
      if (html.length > 5 * 1024 * 1024) throw err('PAYLOAD_TOO_LARGE', '导入文件超限（5MB）');
      const folderOf = [];
      const result = { imported: 0, duplicates: 0, failed: 0, errors: [] };
      // 扁平解析：按出现顺序跟踪最近的 H3 作为分类，逐个提取 <A HREF>
      const re = /<(h3)[^>]*>([^<]{1,60})<\/h3>|<a\s[^>]*?href=["']([^"']+)["'][^>]*>([^<]{0,300})<\/a>/gi;
      let m;
      let currentFolder = '';
      const jobs = [];
      while ((m = re.exec(html)) !== null) {
        if (m[1]) {
          currentFolder = m[2].trim().slice(0, 60);
        } else {
          const href = m[3];
          const title = (m[4] || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
          jobs.push({ href, title, folder: currentFolder });
        }
      }
      void folderOf;
      for (const j of jobs) {
        try {
          const urlNorm = normalizeUrl(j.href);
          if (byUrl.has(urlNorm) && byId.has(byUrl.get(urlNorm))) {
            result.duplicates += 1;
            continue;
          }
          const r = makeRecord({
            url: j.href.trim(),
            title: titleOf(j.title),
            categoryL1: j.folder,
            source: 'import',
          });
          r.snapshotStatus = autoSnapshot ? 'pending' : 'failed';
          if (autoSnapshot) {
            // 导入只记卡片，快照异步补（避免 200 条串行抓取拖死请求）
            fillSnapshot(r).then(() => persist()).catch(() => {});
          } else {
            r.snapshotFailReason = '导入时未启用快照抓取';
          }
          byId.set(r.id, r);
          byUrl.set(urlNorm, r.id);
          result.imported += 1;
        } catch (e) {
          result.failed += 1;
          if (result.errors.length < 20) {
            result.errors.push({ href: String(j.href).slice(0, 120), reason: (e && e.reason) || String((e && e.message) || e) });
          }
        }
      }
      persist();
      return result;
    },

    stats() {
      const byStatus = { normal: 0, suspect: 0, dead: 0, archived: 0 };
      for (const r of byId.values()) {
        if (byStatus[r.status] !== undefined) byStatus[r.status] += 1;
      }
      return { total: byId.size, byStatus };
    },

    // 单测/联调辅助
    _size: () => byId.size,
  };

  function titleOf(t) {
    return (t || '').slice(0, MAX_TITLE);
  }

  load();
  return store;
}

module.exports = { createStore, normalizeUrl, STATUS };
