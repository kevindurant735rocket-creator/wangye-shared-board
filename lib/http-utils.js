/**
 * http-utils.js — 共享 HTTP 工具（Batch A: 基础设施抽取）
 *
 * 设计目标：
 *  - 把 server.js 里散落的 setSecurityHeaders / sendJson / collectBody /
 *    readSessionCookie / setCorsHeaders 收敛到一个工具模块
 *  - 行为完全等价：调用方替换为 require('./lib/http-utils') 即可
 *  - 单测覆盖：可在不开 server 的前提下逐函数验证
 *
 * 回滚策略：
 *  - 此文件与 server.js 解耦；如出现异常，只需在 server.js 中 require 替换为
 *    内联实现（git revert 即可）
 *
 * 兼容性：
 *  - 保留旧函数签名：(req, res) 或 (res, status, payload)
 *  - 不改变响应 header 顺序 / 字段
 */
'use strict';

const crypto = require('crypto');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const CSP_VALUE = [
  "default-src 'self'",
  // 红队 R2-F10：页面全部外链脚本、无内联脚本/事件处理器（index.html/login.html 已核），
  // 放行 'unsafe-inline' 属 XSS 纵深自废——收紧为仅 'self'。style-src 保留（存在内联样式）。
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );
  res.setHeader(
    'Strict-Transport-Security',
    'max-age=15552000; includeSubDomains'
  );
  res.setHeader('Content-Security-Policy', CSP_VALUE);
}

function setCorsHeaders(req, res) {
  const allowedOrigin = process.env.CORS_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Requested-With'
  );
  res.setHeader('Vary', 'Origin');
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function collectBody(req, limitBytes = 1024 * 128) {
  const cl = req.headers && parseInt(req.headers['content-length'], 10);
  if (cl > limitBytes) {
    return Promise.reject(new Error('Request body too large'));
  }
  return new Promise((resolve, reject) => {
    let body = '';
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function readSessionCookie(req) {
  const raw = req.headers['cookie'];
  if (!raw || typeof raw !== 'string') return null;
  for (const part of raw.split(/;\s*/)) {
    const [k, v] = part.split('=');
    if (k === 'sid' && v) return decodeURIComponent(v);
  }
  return null;
}

function getClientIp(req) {
  // 红队 R2-F8：x-forwarded-for 可被任意客户端伪造，默认不信；
  // 仅在显式 TRUST_PROXY=1（前面确有可信反代）时才采纳，与 rate-limit 的 socket 口径对齐
  if (process.env.TRUST_PROXY === '1') {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function shortEtag(bufferOrString) {
  return `"${crypto
    .createHash('sha1')
    .update(bufferOrString)
    .digest('hex')
    .slice(0, 16)}"`;
}

module.exports = {
  MIME_TYPES,
  CSP_VALUE,
  setSecurityHeaders,
  setCorsHeaders,
  sendJson,
  collectBody,
  readSessionCookie,
  getClientIp,
  shortEtag,
};
