import { fetchItems, fetchFulltext } from "./aihot-api.js";
import { synthesize, ZH_VOICES } from "./edge-tts.js";

const $ = (id) => document.getElementById(id);

const state = {
  items: [],
  filtered: [],
  cursor: null,
  hasNext: false,
  index: 0,
  queueMode: false,
  speaking: false,
  paused: false,
  audio: null,
  audioUrl: null,
  fullCache: new Map(),
  chunkQueue: [],
  stopRequested: false,
};

function setStatus(t) {
  $("status").textContent = t;
}
function setProgress() {
  const total = state.filtered.length;
  $("progress").textContent = `${total ? state.index + 1 : 0} / ${total}`;
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function formatTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}
function categoryLabel(c) {
  return (
    {
      "ai-models": "模型",
      "ai-products": "产品",
      industry: "行业",
      paper: "论文",
      tip: "技巧",
    }[c] || c || ""
  );
}

function initVoices() {
  const sel = $("voice");
  sel.innerHTML = "";
  for (const v of ZH_VOICES) {
    const o = document.createElement("option");
    o.value = v.id;
    o.textContent = `${v.name} · ${v.gender} · ${v.note}`;
    sel.appendChild(o);
  }
  sel.value = "zh-CN-XiaoxiaoNeural";
}

function buildBase(item) {
  const mode = $("speakMode").value;
  const head = item.source ? `来源：${item.source}。` : "";
  const title = item.title || "";
  const summary = item.summary || "";
  if (mode === "title") return `${head}${title}`;
  if (mode === "summary") return summary ? `${head}${summary}` : `${head}${title}`;
  if (summary) return `${head}${title}。摘要：${summary}`;
  return `${head}${title}`;
}

async function buildSpeakText(item) {
  const mode = $("speakMode").value;
  if (mode !== "full") return buildBase(item);
  try {
    let full = state.fullCache.get(item.id);
    if (!full) {
      setStatus("拉取全文…");
      const data = await fetchFulltext(item.id);
      full = data.fullText;
      state.fullCache.set(item.id, full);
    }
    const head = item.source ? `来源：${item.source}。` : "";
    return `${head}${item.title || ""}。${full || "暂无全文"}`;
  } catch (e) {
    setStatus(`全文失败，改读摘要：${e.message}`);
    return `${buildBase(item)}。全文暂不可用。`;
  }
}

function splitForTts(text, maxLen = 2200) {
  const s = String(text || "").trim();
  if (!s) return [];
  if (s.length <= maxLen) return [s];
  const parts = [];
  let rest = s;
  while (rest.length > maxLen) {
    let cut = -1;
    const window = rest.slice(0, maxLen);
    for (const sep of ["。", "！", "？", "；", ".", "!", "?", " "]) {
      const i = window.lastIndexOf(sep);
      if (i > maxLen * 0.4) {
        cut = i + sep.length;
        break;
      }
    }
    if (cut < 0) cut = maxLen;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

function cleanupAudio() {
  if (state.audio) {
    try {
      state.audio.onended = null;
      state.audio.onerror = null;
      state.audio.pause();
      state.audio.src = "";
    } catch {}
    state.audio = null;
  }
  if (state.audioUrl) {
    URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = null;
  }
}

function stopSpeaking() {
  state.speaking = false;
  state.paused = false;
  state.queueMode = false;
  state.stopRequested = true;
  state.chunkQueue = [];
  cleanupAudio();
  $("btnPlay").textContent = "▶ 播放";
}

async function loadList({ append = false } = {}) {
  $("btnLoad").disabled = true;
  $("btnMore").disabled = true;
  setStatus(append ? "加载更多…" : "拉取中…");
  try {
    const data = await fetchItems({
      mode: $("mode").value,
      category: $("category").value,
      take: Number($("take").value) || 40,
      cursor: append ? state.cursor || "" : "",
    });
    const minScore = Number($("minScore").value) || 0;
    let items = data.items;
    if (minScore > 0) items = items.filter((x) => (x.score ?? 0) >= minScore);

    if (append) {
      const seen = new Set(state.items.map((x) => x.id));
      state.items = state.items.concat(items.filter((x) => !seen.has(x.id)));
    } else {
      state.items = items;
      state.index = 0;
      stopSpeaking();
      state.stopRequested = false;
    }
    state.cursor = data.nextCursor;
    state.hasNext = data.hasNext;
    applyFilter();
    setStatus(`已加载 ${state.items.length} 条`);
  } catch (e) {
    setStatus(`加载失败：${e.message}`);
  } finally {
    $("btnLoad").disabled = false;
    $("btnMore").disabled = !state.hasNext;
  }
}

function applyFilter() {
  const q = ($("filter").value || "").trim().toLowerCase();
  state.filtered = !q
    ? state.items.slice()
    : state.items.filter(
        (it) =>
          (it.title || "").toLowerCase().includes(q) ||
          (it.summary || "").toLowerCase().includes(q) ||
          (it.source || "").toLowerCase().includes(q)
      );
  if (state.index >= state.filtered.length) {
    state.index = Math.max(0, state.filtered.length - 1);
  }
  renderList();
  setProgress();
  updateNow();
}

function renderList() {
  const list = $("list");
  const empty = $("empty");
  list.innerHTML = "";
  if (!state.filtered.length) {
    empty.classList.remove("hidden");
    empty.textContent = "没有条目";
    return;
  }
  empty.classList.add("hidden");
  state.filtered.forEach((item, i) => {
    const card = document.createElement("article");
    card.className = "card" + (i === state.index ? " active" : "");
    card.innerHTML = `
      <div class="card-top">
        <span>${formatTime(item.publishedAt)}</span>
        <span class="badge">${escapeHtml(item.source || "")}</span>
        <span class="badge">${categoryLabel(item.category)}</span>
        ${item.score != null ? `<span class="badge ${item.score >= 60 ? "high" : ""}">分 ${item.score}</span>` : ""}
      </div>
      <h3 class="card-title">${escapeHtml(item.title)}</h3>
      <p class="card-summary">${escapeHtml(item.summary || "（无摘要）")}</p>
      <div class="card-actions">
        <button type="button" data-act="play">朗读</button>
        <a href="${escapeHtml(item.permalink)}" target="_blank" rel="noopener">详情</a>
      </div>`;
    card.addEventListener("click", (e) => {
      if (e.target.closest("a") || e.target.closest("button")) return;
      selectIndex(i, false);
    });
    card.querySelector('[data-act="play"]').addEventListener("click", (e) => {
      e.stopPropagation();
      selectIndex(i, true);
    });
    list.appendChild(card);
  });
}

function selectIndex(i, autoPlay) {
  if (i < 0 || i >= state.filtered.length) return;
  state.index = i;
  renderList();
  setProgress();
  updateNow();
  if (autoPlay) {
    state.queueMode = false;
    speakCurrent();
  }
}

function updateNow() {
  const item = state.filtered[state.index];
  $("nowPlaying").textContent = item
    ? `第 ${state.index + 1} 条 · ${item.title}`
    : "尚未开始";
}

async function speakCurrent() {
  const item = state.filtered[state.index];
  if (!item) {
    setStatus("没有可朗读的条目");
    return;
  }
  state.stopRequested = false;
  cleanupAudio();
  updateNow();
  renderList();

  const text = await buildSpeakText(item);
  if (state.stopRequested) return;
  if (!text.trim()) {
    setStatus("本条无正文");
    if (state.queueMode) return advance();
    return;
  }

  const chunks = splitForTts(text, 2200);
  state.chunkQueue = chunks.slice(1);
  await playChunk(chunks[0], 1, chunks.length);
}

async function playChunk(text, part, total) {
  if (state.stopRequested) return;
  setStatus(total > 1 ? `合成 ${part}/${total}…` : "合成语音…");
  $("btnPlay").textContent = "…";
  try {
    const blob = await synthesize(text, {
      voice: $("voice").value,
      rate: Number($("rate").value) || 1,
      volume: Number($("volume").value) || 1,
    });
    if (state.stopRequested) return;
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    const url = URL.createObjectURL(blob);
    state.audioUrl = url;
    const audio = new Audio(url);
    state.audio = audio;
    audio.volume = Math.min(1, Math.max(0, Number($("volume").value) || 1));

    audio.onplay = () => {
      state.speaking = true;
      state.paused = false;
      $("btnPlay").textContent = "⏸ 暂停";
      setStatus(total > 1 ? `朗读中 ${part}/${total}` : "朗读中…");
    };
    audio.onended = async () => {
      if (state.stopRequested) return;
      if (state.chunkQueue.length) {
        const next = state.chunkQueue.shift();
        await playChunk(next, part + 1, total);
        return;
      }
      state.speaking = false;
      $("btnPlay").textContent = "▶ 播放";
      if (state.queueMode) advance();
      else setStatus("本条读完");
    };
    audio.onerror = () => {
      state.speaking = false;
      $("btnPlay").textContent = "▶ 播放";
      setStatus("播放失败");
    };
    await audio.play();
  } catch (e) {
    console.error(e);
    state.speaking = false;
    $("btnPlay").textContent = "▶ 播放";
    setStatus(`TTS 失败：${e.message}`);
  }
}

function advance() {
  if (state.index + 1 >= state.filtered.length) {
    state.queueMode = false;
    setStatus("全部读完");
    $("btnPlay").textContent = "▶ 播放";
    return;
  }
  state.index += 1;
  renderList();
  setProgress();
  setTimeout(() => speakCurrent(), 250);
}

function togglePlay() {
  if (state.audio && state.speaking && !state.paused) {
    state.audio.pause();
    state.paused = true;
    $("btnPlay").textContent = "▶ 继续";
    setStatus("已暂停");
    return;
  }
  if (state.audio && state.paused) {
    state.audio.play();
    state.paused = false;
    $("btnPlay").textContent = "⏸ 暂停";
    setStatus("朗读中…");
    return;
  }
  state.queueMode = false;
  speakCurrent();
}

// events
$("btnLoad").addEventListener("click", () => loadList({ append: false }));
$("btnMore").addEventListener("click", () => loadList({ append: true }));
$("filter").addEventListener("input", applyFilter);
$("btnPlay").addEventListener("click", togglePlay);
$("btnStop").addEventListener("click", () => {
  stopSpeaking();
  setStatus("已停止");
});
$("btnPrev").addEventListener("click", () => {
  if (state.index <= 0) return;
  const auto = state.speaking || state.paused;
  const q = state.queueMode;
  selectIndex(state.index - 1, auto);
  if (q && auto) state.queueMode = true;
});
$("btnNext").addEventListener("click", () => {
  if (state.index >= state.filtered.length - 1) return;
  const auto = state.speaking || state.paused;
  const q = state.queueMode;
  selectIndex(state.index + 1, auto);
  if (q && auto) state.queueMode = true;
});
$("btnPlayAll").addEventListener("click", () => {
  if (!state.filtered.length) return;
  state.index = 0;
  state.queueMode = true;
  renderList();
  setProgress();
  speakCurrent();
});
$("btnPlayFrom").addEventListener("click", () => {
  if (!state.filtered.length) return;
  state.queueMode = true;
  speakCurrent();
});
$("rate").addEventListener("input", () => {
  $("rateVal").textContent = `${Number($("rate").value).toFixed(2)}×`;
});
$("volume").addEventListener("input", () => {
  $("volVal").textContent = `${Math.round(Number($("volume").value) * 100)}%`;
  if (state.audio) state.audio.volume = Number($("volume").value) || 1;
});

// persist simple prefs
async function loadPrefs() {
  try {
    const p = await chrome.storage.local.get(["mode", "speakMode", "voice", "rate"]);
    if (p.mode) $("mode").value = p.mode;
    if (p.speakMode) $("speakMode").value = p.speakMode;
    if (p.voice) $("voice").value = p.voice;
    if (p.rate) {
      $("rate").value = p.rate;
      $("rateVal").textContent = `${Number(p.rate).toFixed(2)}×`;
    }
  } catch {}
}
function savePrefs() {
  chrome.storage.local
    .set({
      mode: $("mode").value,
      speakMode: $("speakMode").value,
      voice: $("voice").value,
      rate: $("rate").value,
    })
    .catch(() => {});
}
["mode", "speakMode", "voice", "rate"].forEach((id) => {
  $(id).addEventListener("change", savePrefs);
});

initVoices();
loadPrefs().then(() => loadList({ append: false }));
