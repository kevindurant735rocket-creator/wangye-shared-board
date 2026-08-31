const board = document.querySelector("#board");
const statusEl = document.querySelector("#status");
const savedTimeEl = document.querySelector("#savedTime");
const countEl = document.querySelector("#count");

let lastUpdatedAt = null;
let saveTimer = null;
let isTyping = false;
let typingTimer = null;

function setStatus(text, offline = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("offline", offline);
}

function updateCount() {
  countEl.textContent = `${board.value.length} 字`;
}

function formatSavedTime(value) {
  if (!value) return "尚未保存";
  const date = new Date(value);
  return `已保存 ${date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  })}`;
}

async function loadNotes() {
  try {
    const response = await fetch("/api/notes");
    const data = await response.json();
    setStatus("已连接");

    if (!isTyping && data.updatedAt !== lastUpdatedAt) {
      board.value = data.text || "";
      lastUpdatedAt = data.updatedAt;
      savedTimeEl.textContent = formatSavedTime(lastUpdatedAt);
      updateCount();
    }
  } catch {
    setStatus("离线", true);
  }
}

async function saveNotes() {
  try {
    setStatus("保存中");
    const response = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: board.value })
    });
    const data = await response.json();
    lastUpdatedAt = data.updatedAt;
    savedTimeEl.textContent = formatSavedTime(lastUpdatedAt);
    setStatus("已保存");
  } catch {
    setStatus("离线", true);
  }
}

board.addEventListener("input", () => {
  isTyping = true;
  updateCount();
  setStatus("编辑中");

  clearTimeout(saveTimer);
  clearTimeout(typingTimer);
  saveTimer = setTimeout(saveNotes, 450);
  typingTimer = setTimeout(() => {
    isTyping = false;
  }, 1200);
});

loadNotes();
setInterval(loadNotes, 1000);
