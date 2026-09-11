/**
 * auth.js - 会话与密码校验（生产级）
 *
 *  - 密码哈希：node:crypto pbkdf2 (SHA256, 100k 迭代, 16B salt, 32B key)
 *    出于零依赖考虑；如后续接入 bcrypt/scrypt 替换算法版本即可
 *  - 会话：内存 Map，token -> { userId, expiresAt }
 *    token = crypto.randomBytes(32).toString('hex')
 *  - 会话持久化：data/sessions.json（路径可由 SESSIONS_FILE 覆盖），
 *    原子写（tmp+rename），启动时加载并丢弃已过期条目——重启不丢登录态
 *  - 默认用户：从 AUTH_USERS 环境变量解析，格式 "user1:pass1,user2:pass2"
 *    启动时一次性哈希进内存；不落盘明文
 *  - 提供 start()/login()/verify()/logout() 四个核心函数
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PBKDF2_ITER = 100000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha256';
const SALT_BYTES = 16;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h

const SESSIONS_FILE = process.env.SESSIONS_FILE
  || path.join(__dirname, '..', 'data', 'sessions.json');

// users: Map<username, { id, hash, salt, iter, digest }>
const users = new Map();
// sessions: Map<token, { userId, expiresAt }>
const sessions = new Map();

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

function deriveHash(password, salt, iter = PBKDF2_ITER, digest = PBKDF2_DIGEST, keylen = PBKDF2_KEYLEN) {
  return crypto.pbkdf2Sync(password, salt, iter, keylen, digest).toString('hex');
}

/**
 * 装载默认用户。
 * @param {Array<[string,string]>} pairs
 */
function loadUsers(pairs) {
  users.clear();
  for (const [u, p] of pairs) {
    if (!u || typeof p !== 'string' || p.length < 4) continue;
    const salt = crypto.randomBytes(SALT_BYTES);
    users.set(u, {
      id: uid(),
      hash: deriveHash(p, salt),
      salt,
      iter: PBKDF2_ITER,
      digest: PBKDF2_DIGEST,
    });
  }
}

function loadFromEnv(envValue) {
  if (!envValue) {
    // 提供一个默认演示账号，便于首次启动即可登录
    loadUsers([['demo', 'demo1234']]);
    return;
  }
  const pairs = [];
  for (const seg of String(envValue).split(',')) {
    // 红队 R2-F9：密码可含 ':'——split(':') 解构会把 'bob:pa:ss' 截成 'bob'/'pa'，
    // 静默产出错误凭证；只在第一个冒号处切分用户名与完整密码
    const idx = seg.indexOf(':');
    if (idx <= 0) continue;
    const u = seg.slice(0, idx);
    const p = seg.slice(idx + 1);
    if (u && p) pairs.push([u.trim(), p]);
  }
  loadUsers(pairs);
}

/**
 * 校验用户名/密码。
 * @returns {string|null} userId or null
 */
function login(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  const u = users.get(username);
  if (!u) {
    // 仍消耗一次哈希时间，避免用户名枚举
    crypto.pbkdf2Sync(password, crypto.randomBytes(SALT_BYTES), PBKDF2_ITER, PBKDF2_KEYLEN, PBKDF2_DIGEST);
    return null;
  }
  const test = deriveHash(password, u.salt, u.iter, u.digest, PBKDF2_KEYLEN);
  const a = Buffer.from(test, 'hex');
  const b = Buffer.from(u.hash, 'hex');
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return u.id;
}

function startSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  _persistSessions();
  return token;
}

function verifySession(token) {
  if (typeof token !== 'string') return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) {
    sessions.delete(token);
    _persistSessions();
    return null;
  }
  // 滑动续期：每 30min 才续一次，避免热路径写（续期即落盘，同一去抖频率）
  const HALF = SESSION_TTL_MS / 2;
  if (Date.now() - (s.lastTouch || s.expiresAt - SESSION_TTL_MS) > HALF) {
    s.expiresAt = Date.now() + SESSION_TTL_MS;
    s.lastTouch = Date.now();
    _persistSessions();
  }
  return s.userId;
}

function logout(token) {
  if (typeof token !== 'string') return false;
  const deleted = sessions.delete(token);
  if (deleted) _persistSessions();
  return deleted;
}

// ---------- 会话持久化（重启不丢登录态） ----------
// 格式：{ version: 1, sessions: { <token>: { userId, expiresAt, lastTouch? } } }
// 写入走 tmp+rename 原子替换（与 notes-store 同策略）；失败静默不阻塞请求路径。
function _persistSessions() {
  let tmp = null;
  let fd = null;
  try {
    const dir = path.dirname(SESSIONS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    // 红队 R2-F6：落盘前顺手丢弃过期条目——旧实现把含过期会话的全量 Map 反复重写，
    // 失效 token 凭证无限期滞留磁盘
    const now = Date.now();
    for (const [token, s] of sessions) {
      if (s.expiresAt <= now) sessions.delete(token);
    }
    const obj = { version: 1, sessions: Object.fromEntries(sessions) };
    // 唯一 tmp 名防并发双写竞态（固定 .tmp 会互踩后 rename 半成品）；0o600 因内容是会话 token
    tmp = SESSIONS_FILE + '.tmp.' + crypto.randomBytes(4).toString('hex');
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(obj), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, SESSIONS_FILE);
    tmp = null;
  } catch (_) {
    // 红队 R2-F11：写失败也必须清掉半成品 tmp（ENOSPC/EXDEV 时旧实现残留累积）
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    if (tmp !== null) { try { fs.unlinkSync(tmp); } catch (_) {} }
    /* 磁盘故障时退化为纯内存会话，不影响请求 */
  }
}

// 红队 R2-F6：周期清扫过期会话，内存与磁盘都不再无限增长。
// 20min 一次，远小于 8h 量级 TTL；unref 保证不阻止进程退出。
const SWEEP_INTERVAL_MS = 20 * 60 * 1000;
setInterval(() => { sweepExpired(); }, SWEEP_INTERVAL_MS).unref?.();

function sweepExpired() {
  const now = Date.now();
  let removed = 0;
  for (const [token, s] of sessions) {
    if (s.expiresAt <= now) { sessions.delete(token); removed++; }
  }
  if (removed > 0) _persistSessions();
  return removed;
}

function _loadSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    const bag = raw && raw.sessions ? raw.sessions : raw; // 兼容裸 Map 序列化
    for (const [token, s] of Object.entries(bag)) {
      if (!s || typeof s.userId !== 'string' || typeof s.expiresAt !== 'number') continue;
      if (s.expiresAt <= now) continue; // 加载时丢弃已过期
      sessions.set(token, s);
    }
  } catch (_) { /* 文件损坏即视为无历史会话 */ }
}

function _forgetSessionsFile() {
  try { fs.rmSync(SESSIONS_FILE, { force: true }); } catch (_) {}
}
_loadSessions();

function userCount() { return users.size; }
function sessionCount() { return sessions.size; }
function _clear() { users.clear(); sessions.clear(); }

module.exports = {
  loadUsers, loadFromEnv,
  login, startSession, verifySession, logout,
  SESSION_TTL_MS, sweepExpired,
  _clear, userCount, sessionCount,
  _sessions: sessions,
  _persistSessions, _loadSessions, _forgetSessionsFile,
};
