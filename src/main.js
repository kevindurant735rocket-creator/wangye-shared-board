/**
 * 共享写字板 - 现代前端入口
 * - ES Module, 无框架，Vite 构建
 * - 健壮性：请求超时、重试、输入校验、可见性感知
 * - 可观测性：控制台结构化日志
 * - 可访问性：aria-live 状态播报
 */
const board = document.querySelector("#board");
const statusEl = document.querySelector("#status");
const savedTimeEl = document.querySelector("#savedTime");
const countEl = document.querySelector("#count");

let lastUpdatedAt = null;
let saveTimer = null;
let typingTimer = null;
let isTyping = false;
let saveInFlight = false;
let pendingSave = false;
let consecutiveFailures = 0;

const SAVE_DEBOUNCE_MS = 450;
const TYPING_COOLDOWN_MS = 1200;
const POLL_INTERVAL_MS = 1000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_TEXT_LENGTH = 20000;

function log(level, msg, extra = {}) {
  const payload = { ts: new Date().toISOString(), level, msg, ...extra };
  if (level === "error") console.error("[board]", payload);
  else if (level === "warn") console.warn("[board]", payload);
  else console.log("[board]", payload);
}

function setStatus(text, offline = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("offline", offline);
  statusEl.dataset.state = offline ? "offline" : "online";
}

function updateCount() {
  const len = board.value.length;
  countEl.textContent = `${len} 字`;
  if (len >= MAX_TEXT_LENGTH) {
    countEl.classList.add("limit");
  } else {
    countEl.classList.remove("limit");
  }
}

function formatSavedTime(value) {
  if (!value) return "尚未保存";
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "尚未保存";
    return `已保存 ${date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    })}`;
  } catch {
    return "尚未保存";
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function loadNotes() {
  // 输入中则降低轮询频率，避免覆盖用户正在编辑的内容
  if (isTyping) return;
  // 页面不可见时跳过轮询，节省资源
  if (document.visibilityState !== "visible") return;
  try {
    const response = await fetchWithTimeout("/api/notes", { method: "GET" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    // 参数校验：仅接受合法结构
    if (typeof data !== "object" || data === null) throw new Error("invalid payload");
    if (data.updatedAt && typeof data.updatedAt !== "string") throw new Error("invalid updatedAt");

    // 仅当远端更新且用户未在输入时同步，避免闪烁
    if (!isTyping && data.updatedAt !== lastUpdatedAt) {
      const nextText = typeof data.text === "string" ? data.text.slice(0, MAX_TEXT_LENGTH) : "";
      // 若本地有未保存的 pending，则不覆盖，等待保存完成后再合并
      if (!pendingSave && !saveInFlight) {
        board.value = nextText;
        lastUpdatedAt = data.updatedAt;
        savedTimeEl.textContent = formatSavedTime(lastUpdatedAt);
        updateCount();
      }
    }
    setStatus("已连接");
    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures += 1;
    log("warn", "loadNotes failed", { error: String(err), consecutiveFailures });
    // 连续失败才显示离线，避免偶发抖动
    if (consecutiveFailures >= 2) setStatus("离线", true);
  }
}

async function saveNotes() {
  const text = board.value.slice(0, MAX_TEXT_LENGTH);
  if (saveInFlight) {
    pendingSave = true;
    return;
  }
  saveInFlight = true;
  pendingSave = false;
  try {
    setStatus("保存中");
    const response = await fetchWithTimeout("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`save failed ${response.status} ${body.slice(0, 200)}`);
    }
    const data = await response.json();
    if (data && typeof data.updatedAt === "string") {
      lastUpdatedAt = data.updatedAt;
      savedTimeEl.textContent = formatSavedTime(lastUpdatedAt);
    }
    setStatus("已保存");
    consecutiveFailures = 0;
    log("info", "saved", { len: text.length, updatedAt: lastUpdatedAt });
  } catch (err) {
    log("error", "save failed", { error: String(err) });
    setStatus("离线", true);
    // 保存失败时保留 pending，下次防抖会重试
    pendingSave = true;
  } finally {
    saveInFlight = false;
    if (pendingSave) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNotes, SAVE_DEBOUNCE_MS);
    }
  }
}

function onInput() {
  isTyping = true;
  updateCount();
  setStatus("编辑中");

  // 输入长度校验与提示
  if (board.value.length >= MAX_TEXT_LENGTH) {
    setStatus(`已达上限 ${MAX_TEXT_LENGTH} 字`);
  }

  clearTimeout(saveTimer);
  clearTimeout(typingTimer);
  saveTimer = setTimeout(saveNotes, SAVE_DEBOUNCE_MS);
  typingTimer = setTimeout(() => {
    isTyping = false;
  }, TYPING_COOLDOWN_MS);
}

board.addEventListener("input", onInput);
board.addEventListener("paste", () => {
  // 粘贴后异步校验长度
  setTimeout(updateCount, 0);
});

// 失去焦点立即尝试保存一次
board.addEventListener("blur", () => {
  if (board.value.length > 0) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNotes, 150);
  }
});

// 网络恢复时立即同步
window.addEventListener("online", () => {
  log("info", "online, reloading");
  loadNotes();
});
window.addEventListener("offline", () => setStatus("离线", true));

// 页面可见性变化时触发同步
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadNotes();
});

// 初始化
updateCount();
loadNotes();
let pollTimer = setInterval(loadNotes, POLL_INTERVAL_MS);

// 页面卸载时尝试同步（best-effort）
window.addEventListener("beforeunload", () => {
  if (pendingSave || saveInFlight) {
    // navigator.sendBeacon 更可靠，但保持兼容用同步逻辑
    try {
      const blob = new Blob([JSON.stringify({ text: board.value.slice(0, MAX_TEXT_LENGTH) })], {
        type: "application/json"
      });
      navigator.sendBeacon("/api/notes", blob);
    } catch {}
  }
});

// 暴露给调试
window.__BOARD__ = { loadNotes, saveNotes };
