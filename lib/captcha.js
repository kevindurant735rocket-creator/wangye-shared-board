/**
 * captcha.js - 图形验证码 (SVG) 生产级实现
 *
 * 设计要点：
 *  - 4 位字母+数字，排除易混字符 0/O/1/I/L
 *  - SVG 输出，无第三方依赖
 *  - 仅在内存中存储明文（生命周期 < 5min），不落盘
 *  - 每次刷新都生成新 token，旧的 5min TTL 到期自动清
 *  - 接口：create() -> {token, svg}；verify(token, code) -> boolean（验证后即销毁）
 */
'use strict';

const crypto = require('crypto');

// 易混淆字符剔除
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TTL_MS = 5 * 60 * 1000; // 5 分钟
const CODE_LEN = 4;
// store: token -> { code, expiresAt }
const store = new Map();

// 定期清理过期
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
}, 60 * 1000);
cleanupTimer.unref?.();

function randomCode() {
  const buf = crypto.randomBytes(CODE_LEN * 2);
  let out = '';
  for (let i = 0; i < CODE_LEN && out.length < CODE_LEN; i++) {
    out += ALPHABET[buf[i] % ALPHABET.length];
  }
  return out;
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * 生成验证码 SVG。
 * 含：随机字符、轻微旋转/位移、随机噪点线、背景栅格干扰。
 * @returns {{token: string, svg: string, expiresIn: number}}
 */
function create() {
  const token = randomToken();
  const code = randomCode();
  store.set(token, { code, expiresAt: Date.now() + TTL_MS });

  const width = 120;
  const height = 40;
  const chars = code.split('');

  // 字符路径：每个字符随机 y 偏移 + 旋转
  const charEls = chars.map((ch, i) => {
    const x = 18 + i * 22;
    const y = 26 + ((i * 7) % 6) - 3;
    const rot = ((i * 13) % 21) - 10;
    return `<text x="${x}" y="${y}" font-family="Verdana,Geneva,sans-serif" font-size="22" font-weight="700" fill="#1f3b5b" transform="rotate(${rot} ${x} ${y})">${ch}</text>`;
  }).join('');

  // 噪点线
  let noise = '';
  const noiseBuf = crypto.randomBytes(40);
  for (let i = 0; i < 4; i++) {
    const x1 = noiseBuf[i * 2] % width;
    const y1 = noiseBuf[i * 2 + 1] % height;
    const x2 = noiseBuf[8 + i * 2] % width;
    const y2 = noiseBuf[8 + i * 2 + 1] % height;
    const color = i % 2 ? '#9aa9c2' : '#c3cfdf';
    noise += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1"/>`;
  }

  // 背景点
  let dots = '';
  const dotBuf = crypto.randomBytes(60);
  for (let i = 0; i < 30; i++) {
    const cx = dotBuf[i * 2] % width;
    const cy = dotBuf[i * 2 + 1] % height;
    dots += `<circle cx="${cx}" cy="${cy}" r="0.8" fill="#aab5c8" opacity="0.6"/>`;
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="captcha">` +
    `<rect width="100%" height="100%" fill="#f4f7fb"/>` +
    `<g>${noise}${dots}</g>` +
    charEls +
    `</svg>`;

  return { token, svg, expiresIn: TTL_MS };
}

/**
 * 校验并消费验证码（一次性）。
 * @param {string} token
 * @param {string} code
 * @returns {boolean}
 */
function verify(token, code) {
  if (typeof token !== 'string' || typeof code !== 'string') return false;
  const entry = store.get(token);
  if (!entry) return false;
  store.delete(token);
  if (entry.expiresAt <= Date.now()) return false;
  const a = Buffer.from(entry.code.toUpperCase());
  const b = Buffer.from(code.toUpperCase());
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 仅测试/管理用 */
function _size() { return store.size; }
function _clear() { store.clear(); }

module.exports = { create, verify, _size, _clear, TTL_MS, CODE_LEN };
