/**
 * notes-store.js — 笔记数据访问层（Batch A: 数据访问层抽取）
 *
 * 把 server.js 内联的 ensureDataFile / readNotes / writeNotes 提到一个模块，
 * 同时暴露 lastUpdatedAt 让 etag 和缓存层可以引用。
 *
 * 接口（与原 server.js 行为完全等价）：
 *  - read(): { text, updatedAt }
 *  - write(text): { text, updatedAt }  // 原子写：tmp + rename
 *  - lastWriteAt(): ISO string | null
 *
 * 兼容性：
 *  - 数据 schema 不变（{ text: string, updatedAt: ISO }）
 *  - 上限 20000 字符保持不变
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_LEN = 20000;
const DATA_DIR_ENV = process.env.NOTES_DATA_DIR;

function getDataDir(rootDir) {
  if (DATA_DIR_ENV) return DATA_DIR_ENV;
  return path.join(rootDir, 'data');
}

function getDataFile(rootDir) {
  return path.join(getDataDir(rootDir), 'notes.json');
}

function ensureDataFile(rootDir) {
  const dir = getDataDir(rootDir);
  const file = getDataFile(rootDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({ text: '', updatedAt: null }, null, 2));
  }
  return file;
}

function read(rootDir) {
  const file = ensureDataFile(rootDir);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null)
      throw new Error('invalid json structure');
    return {
      text: typeof parsed.text === 'string' ? parsed.text.slice(0, MAX_LEN) : '',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    };
  } catch {
    return { text: '', updatedAt: null };
  }
}

function write(rootDir, text) {
  const file = ensureDataFile(rootDir);
  const payload = {
    text: String(text || '').slice(0, MAX_LEN),
    updatedAt: new Date().toISOString(),
  };
  const tmp = file + '.tmp.' + crypto.randomBytes(4).toString('hex');
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return payload;
}

module.exports = { read, write, ensureDataFile, getDataFile, getDataDir, MAX_LEN };
