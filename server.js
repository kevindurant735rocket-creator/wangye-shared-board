const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DIST_DIR = path.join(ROOT, "dist");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "notes.json");

// 选择静态资源根：优先 dist（Vite 构建产物），回退到 public
function getStaticRoot() {
  if (fs.existsSync(path.join(DIST_DIR, "index.html"))) return DIST_DIR;
  return PUBLIC_DIR;
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "text/xml; charset=utf-8",
};

// ---------- 可观测性：结构化日志 ----------
function log(level, msg, extra = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...extra,
  });
  if (level === "error") console.error(line);
  else console.log(line);
}

// ---------- 安全与健壮性：限流 ----------
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_GET = 120;
const RATE_MAX_POST = 30;
const rateStore = new Map(); // ip -> { windowStart, getCount, postCount }

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function isRateLimited(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  let entry = rateStore.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    entry = { windowStart: now, getCount: 0, postCount: 0 };
    rateStore.set(ip, entry);
  }
  if (req.method === "GET") {
    entry.getCount += 1;
    return entry.getCount > RATE_MAX_GET;
  }
  if (req.method === "POST") {
    entry.postCount += 1;
    return entry.postCount > RATE_MAX_POST;
  }
  return false;
}

// 定期清理过期条目
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateStore) {
    if (now - v.windowStart > RATE_WINDOW_MS * 2) rateStore.delete(k);
  }
}, RATE_WINDOW_MS * 5).unref?.();

// ---------- 数据层：带校验与原子写入 ----------
function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ text: "", updatedAt: null }, null, 2));
  }
}

function readNotes() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("invalid json structure");
    return {
      text: typeof parsed.text === "string" ? parsed.text.slice(0, 20000) : "",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch (e) {
    log("warn", "readNotes fallback", { error: String(e) });
    return { text: "", updatedAt: null };
  }
}

function writeNotes(text) {
  ensureDataFile();
  const payload = {
    text: String(text || "").slice(0, 20000),
    updatedAt: new Date().toISOString(),
  };
  // 原子写入：先写临时文件再重命名
  const tmp = DATA_FILE + ".tmp." + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, DATA_FILE);
  return payload;
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let total = 0;
    const limit = 1024 * 128; // 128KB
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function setSecurityHeaders(res) {
  // 基础安全头（ helmet 轻量实现 ）
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // HSTS 仅在非本地时有意义，仍可设置
  res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  // 合理的 CSP：允许自托管脚本与样式，Vite 产物的 inline 仅需少量
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
}

function setCorsHeaders(req, res) {
  // 兼容现有 API：允许同源，开放受控跨域（可通过环境变量限制）
  const allowedOrigin = process.env.CORS_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Requested-With");
  res.setHeader("Vary", "Origin");
}

function serveStatic(req, res) {
  const staticRoot = getStaticRoot();
  const urlPath = decodeURIComponent(req.url.split("?")[0]);

  // 健康检查（不走静态）
  if (urlPath === "/health" || urlPath === "/api/health") {
    setSecurityHeaders(res);
    setCorsHeaders(req, res);
    return sendJson(res, 200, {
      ok: true,
      uptime: process.uptime(),
      version: "1.1.0",
      staticRoot: path.basename(staticRoot),
    });
  }

  // 规范化路径并防目录穿越
  let safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  // 去掉开头的 /
  if (safePath.startsWith(path.sep)) safePath = safePath.slice(1);
  let filePath = path.join(staticRoot, safePath === "" ? "index.html" : safePath);

  // 若请求为目录或无扩展名且对应文件不存在，返回 index.html（SPA 回退）
  const hasExt = path.extname(filePath) !== "";
  const exists = fs.existsSync(filePath) && fs.statSync(filePath).isFile();

  if (!hasExt && !exists) {
    // 尝试 index.html 回退（仅对非 /api）
    if (!urlPath.startsWith("/api/")) {
      filePath = path.join(staticRoot, "index.html");
    }
  }

  if (!filePath.startsWith(staticRoot)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      // 未找到则回退到 index.html（前端路由）或 404
      if (!urlPath.startsWith("/api/")) {
        const fallback = path.join(staticRoot, "index.html");
        if (fs.existsSync(fallback) && filePath !== fallback) {
          fs.readFile(fallback, (err2, content2) => {
            if (err2) {
              res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
              res.end("Not found");
              return;
            }
            setSecurityHeaders(res);
            setCorsHeaders(req, res);
            res.setHeader("Cache-Control", "no-cache");
            res.writeHead(200, { "Content-Type": mimeTypes[".html"] });
            res.end(content2);
          });
          return;
        }
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = mimeTypes[ext] || "application/octet-stream";
    // 静态资源缓存策略
    const isImmutable = filePath.includes("/assets/") || ext === ".js" || ext === ".css";
    const cacheControl = isImmutable ? "public, max-age=31536000, immutable" : "public, max-age=600";
    const etag = `"${crypto.createHash("sha1").update(content).digest("hex").slice(0, 16)}"`;
    if (req.headers["if-none-match"] === etag) {
      setSecurityHeaders(res);
      setCorsHeaders(req, res);
      res.writeHead(304);
      res.end();
      return;
    }

    setSecurityHeaders(res);
    setCorsHeaders(req, res);
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": cacheControl,
      ETag: etag,
      "Content-Length": content.length,
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const start = Date.now();
  const url = req.url || "/";

  // 通用 CORS 预检
  if (req.method === "OPTIONS") {
    setSecurityHeaders(res);
    setCorsHeaders(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  // 限流
  if (isRateLimited(req)) {
    setSecurityHeaders(res);
    setCorsHeaders(req, res);
    log("warn", "rate limited", { ip: getClientIp(req), url, method: req.method });
    return sendJson(res, 429, { error: "Too Many Requests", retryAfter: 60 });
  }

  // API: 读取
  if (url.startsWith("/api/notes") && req.method === "GET") {
    setSecurityHeaders(res);
    setCorsHeaders(req, res);
    // 防止缓存旧数据
    res.setHeader("Cache-Control", "no-store");
    const data = readNotes();
    log("info", "GET /api/notes", { ip: getClientIp(req), ms: Date.now() - start });
    return sendJson(res, 200, data);
  }

  // API: 写入（带参数校验）
  if (url.startsWith("/api/notes") && req.method === "POST") {
    setSecurityHeaders(res);
    setCorsHeaders(req, res);
    try {
      const body = await collectBody(req);
      let payload;
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        return sendJson(res, 400, { error: "Invalid JSON" });
      }
      // 参数校验：必须为对象，且 text 若存在需为字符串
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return sendJson(res, 400, { error: "Invalid payload: expected object" });
      }
      if (payload.text !== undefined && typeof payload.text !== "string") {
        return sendJson(res, 400, { error: "Invalid field: text must be string" });
      }
      if (typeof payload.text === "string" && payload.text.length > 20000) {
        return sendJson(res, 400, { error: "Text too long: max 20000" });
      }
      const result = writeNotes(payload.text || "");
      log("info", "POST /api/notes", { ip: getClientIp(req), len: result.text.length, ms: Date.now() - start });
      return sendJson(res, 200, result);
    } catch (e) {
      log("error", "POST /api/notes error", { error: String(e) });
      const msg = e.message === "Request body too large" ? "Payload Too Large" : "Invalid note content";
      const code = e.message === "Request body too large" ? 413 : 400;
      return sendJson(res, code, { error: msg });
    }
  }

  // 其他一律走静态托管
  serveStatic(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  log("info", `Shared board running`, { port: PORT, staticRoot: path.basename(getStaticRoot()) });
  console.log(`Shared board running at http://localhost:${PORT} (static: ${getStaticRoot()})`);
});

// 优雅退出
function shutdown(signal) {
  log("info", `shutdown ${signal}`);
  server.close(() => {
    log("info", "server closed");
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
