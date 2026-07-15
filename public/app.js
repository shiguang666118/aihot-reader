/**
 * AI HOT 朗读器前端
 * 默认：Microsoft Edge 神经网络 TTS（服务器合成 MP3）
 * 兜底：浏览器 Web Speech API
 */
(() => {
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
    engine: "edge", // edge | browser
    voices: [],
    audio: null,
    audioUrl: null,
    abort: null,
    fullCache: new Map(), // id -> fullText
    chunkQueue: [], // remaining speech chunks for current item
    stopRequested: false,
  };

  const synth = window.speechSynthesis || null;

  // ---------- UI helpers ----------
  function setStatus(t) {
    $("status").textContent = t;
  }
  function setProgress() {
    const total = state.filtered.length;
    const cur = total ? state.index + 1 : 0;
    $("progress").textContent = `${cur} / ${total}`;
  }
  function formatTime(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return d.toLocaleString("zh-CN", {
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
        tip: "技巧/观点",
      }[c] || c || "其他"
    );
  }
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  function buildSpeakTextBase(item) {
    const mode = $("speakMode").value;
    const title = item.title || "";
    const summary = item.summary || "";
    const head = item.source ? `来源：${item.source}。` : "";
    if (mode === "title") return `${head}${title}`;
    if (mode === "summary") return summary ? `${head}${summary}` : `${head}${title}`;
    // full / title_summary 共用开头
    if (summary) return `${head}${title}。摘要：${summary}`;
    return `${head}${title}`;
  }

  async function loadFullText(item) {
    if (!item?.id) return "";
    if (state.fullCache.has(item.id)) return state.fullCache.get(item.id);
    setStatus("拉取全文中…");
    const r = await fetch(`/api/fulltext?id=${encodeURIComponent(item.id)}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `全文 HTTP ${r.status}`);
    const text = data.fullText || "";
    state.fullCache.set(item.id, text);
    return text;
  }

  async function buildSpeakText(item) {
    const mode = $("speakMode").value;
    const base = buildSpeakTextBase(item);
    if (mode !== "full") return base;
    try {
      const full = await loadFullText(item);
      if (!full) return `${base}。暂无全文。`;
      // 全文接口通常已含摘要+正文；这里只加来源和标题作开场，避免摘要念两遍
      const head = item.source ? `来源：${item.source}。` : "";
      const title = item.title || "";
      return `${head}${title}。${full}`;
    } catch (err) {
      console.warn(err);
      setStatus(`全文获取失败，改读摘要：${err.message}`);
      return `${base}。全文暂不可用。`;
    }
  }

  /** 长文按句号分段，单段不超过 maxLen，供 Edge TTS 多次合成 */
  function splitForTts(text, maxLen = 2200) {
    const s = String(text || "").trim();
    if (!s) return [];
    if (s.length <= maxLen) return [s];
    const parts = [];
    let rest = s;
    while (rest.length > maxLen) {
      let cut = -1;
      const window = rest.slice(0, maxLen);
      for (const sep of ["。", "！", "？", "；", "\n", ".", "!", "?", " "]) {
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

  // ---------- voices ----------
  async function loadEdgeVoices() {
    try {
      const r = await fetch("/api/voices");
      const data = await r.json();
      state.voices = data.voices || [];
      const sel = $("voice");
      sel.innerHTML = "";
      for (const v of state.voices) {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = `${v.name} · ${v.gender} · ${v.note}`;
        sel.appendChild(opt);
      }
      sel.value = data.default || "zh-CN-XiaoxiaoNeural";
    } catch (e) {
      console.warn("load voices failed", e);
    }
  }

  function fillBrowserVoices() {
    if (!synth) return;
    const voices = synth.getVoices() || [];
    const sel = $("voice");
    const prev = sel.value;
    const zh = voices.filter((v) => /zh|chinese|中文/i.test(v.lang + v.name));
    const list = zh.length ? zh : voices;
    sel.innerHTML = "";
    for (const v of list) {
      const opt = document.createElement("option");
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.lang})`;
      sel.appendChild(opt);
    }
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }

  function onEngineChange() {
    state.engine = $("engine").value;
    stopSpeaking();
    if (state.engine === "edge") {
      loadEdgeVoices();
      setStatus("引擎：Edge 神经网络（质量高，需联网）");
    } else {
      fillBrowserVoices();
      if (synth) synth.onvoiceschanged = fillBrowserVoices;
      setStatus("引擎：浏览器自带（免联网，音质一般）");
    }
  }

  // ---------- fetch items ----------
  async function fetchItems({ append = false } = {}) {
    const mode = $("mode").value;
    const category = $("category").value;
    const take = $("take").value;
    const params = new URLSearchParams({ mode, take, fields: "default" });
    if (category) params.set("category", category);
    if (append && state.cursor) params.set("cursor", state.cursor);

    setStatus(append ? "加载更多…" : "拉取中…");
    $("btnLoad").disabled = true;
    $("btnMore").disabled = true;

    try {
      const r = await fetch(`/api/items?${params}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

      const minScore = Number($("minScore").value) || 0;
      let items = data.items || [];
      if (minScore > 0) items = items.filter((it) => (it.score ?? 0) >= minScore);

      if (append) {
        const seen = new Set(state.items.map((x) => x.id));
        state.items = state.items.concat(items.filter((x) => !seen.has(x.id)));
      } else {
        state.items = items;
        state.index = 0;
        stopSpeaking(false);
      }

      state.cursor = data.nextCursor;
      state.hasNext = !!data.hasNext;
      applyFilter();
      setStatus(`已加载 ${state.items.length} 条` + (state.hasNext ? " · 可加载更多" : ""));
    } catch (err) {
      setStatus(`加载失败：${err.message}`);
      console.error(err);
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
    if (state.index >= state.filtered.length) state.index = Math.max(0, state.filtered.length - 1);
    renderList();
    setProgress();
    updateNowPlaying();
  }

  // ---------- render ----------
  function renderList() {
    const list = $("list");
    const empty = $("empty");
    list.innerHTML = "";
    if (!state.filtered.length) {
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    state.filtered.forEach((item, i) => {
      const card = document.createElement("article");
      card.className = "card" + (i === state.index ? " active" : "");
      card.dataset.index = String(i);
      card.innerHTML = `
        <div class="card-top">
          <span>${formatTime(item.publishedAt)}</span>
          <span class="badge">${escapeHtml(item.source || "未知来源")}</span>
          <span class="badge">${categoryLabel(item.category)}</span>
          ${item.score != null ? `<span class="badge ${item.score >= 60 ? "score-high" : ""}">分 ${item.score}</span>` : ""}
          ${item.selected ? `<span class="badge selected">精选</span>` : ""}
        </div>
        <h3 class="card-title">${escapeHtml(item.title)}</h3>
        <p class="card-summary">${escapeHtml(item.summary || "（无摘要）")}</p>
        <div class="card-actions">
          <button type="button" data-act="play">朗读这条</button>
          <a href="${escapeAttr(item.permalink)}" target="_blank" rel="noopener">站内详情</a>
          ${item.url ? `<a href="${escapeAttr(item.url)}" target="_blank" rel="noopener">原文</a>` : ""}
        </div>
      `;
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
    updateNowPlaying();
    const el = document.querySelector(`.card[data-index="${i}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (autoPlay) {
      state.queueMode = false;
      speakCurrent();
    }
  }

  function updateNowPlaying() {
    const item = state.filtered[state.index];
    if (!item) {
      $("nowPlaying").textContent = "尚未开始 · 点「从当前播」或「播全部」";
      return;
    }
    $("nowPlaying").textContent = `第 ${state.index + 1} 条 · ${item.title}`;
  }

  // ---------- TTS core ----------
  function cleanupAudio() {
    if (state.abort) {
      try { state.abort.abort(); } catch {}
      state.abort = null;
    }
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
    if (synth) synth.cancel();
  }

  function stopSpeaking(resetBtn = true) {
    state.speaking = false;
    state.paused = false;
    state.queueMode = false;
    state.stopRequested = true;
    state.chunkQueue = [];
    cleanupAudio();
    if (resetBtn) $("btnPlay").textContent = "▶ 播放";
  }

  async function speakCurrent() {
    const item = state.filtered[state.index];
    if (!item) {
      setStatus("没有可朗读的条目");
      return;
    }

    state.stopRequested = false;
    cleanupAudio();
    updateNowPlaying();
    document.querySelectorAll(".card").forEach((c) => c.classList.remove("playing-pulse"));
    const el = document.querySelector(`.card[data-index="${state.index}"]`);
    if (el) {
      el.classList.add("active", "playing-pulse");
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    const text = await buildSpeakText(item);
    if (state.stopRequested) return;
    if (!text.trim()) {
      setStatus("本条无正文可念");
      if (state.queueMode) return advanceAndPlay();
      return;
    }

    const chunks = splitForTts(text, 2200);
    state.chunkQueue = chunks.slice(1);
    const totalChunks = chunks.length;
    if (state.engine === "edge") {
      await speakEdgeChunk(chunks[0], 1, totalChunks);
    } else {
      speakBrowserChunks(chunks);
    }
  }

  async function speakEdgeChunk(text, part, totalParts) {
    if (state.stopRequested) return;
    const label =
      totalParts > 1
        ? `合成中 ${part}/${totalParts}…`
        : "合成语音中（Edge 神经网络）…";
    setStatus(label);
    $("btnPlay").textContent = "…";
    const controller = new AbortController();
    state.abort = controller;

    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voice: $("voice").value || "zh-CN-XiaoxiaoNeural",
          rate: Number($("rate").value) || 1,
          volume: Number($("volume").value) || 1,
        }),
        signal: controller.signal,
      });

      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try {
          const j = await r.json();
          msg = j.error || msg;
        } catch {}
        throw new Error(msg);
      }

      const blob = await r.blob();
      if (controller.signal.aborted || state.stopRequested) return;

      // 清理上一段 blob
      if (state.audioUrl) {
        URL.revokeObjectURL(state.audioUrl);
        state.audioUrl = null;
      }
      const url = URL.createObjectURL(blob);
      state.audioUrl = url;
      const audio = new Audio(url);
      state.audio = audio;
      audio.volume = Math.min(1, Math.max(0, Number($("volume").value) || 1));

      audio.onplay = () => {
        state.speaking = true;
        state.paused = false;
        $("btnPlay").textContent = "⏸ 暂停";
        setStatus(
          totalParts > 1
            ? `朗读中 ${part}/${totalParts}（Edge 神经网络）…`
            : "朗读中（Edge 神经网络）…"
        );
      };
      audio.onended = async () => {
        if (state.stopRequested) return;
        if (state.chunkQueue.length) {
          const next = state.chunkQueue.shift();
          await speakEdgeChunk(next, part + 1, totalParts);
          return;
        }
        state.speaking = false;
        state.paused = false;
        $("btnPlay").textContent = "▶ 播放";
        if (state.queueMode) advanceAndPlay();
        else setStatus("本条读完");
      };
      audio.onerror = () => {
        state.speaking = false;
        $("btnPlay").textContent = "▶ 播放";
        setStatus("音频播放失败");
      };

      await audio.play();
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error(err);
      setStatus(`Edge TTS 失败：${err.message}，可切到浏览器引擎`);
      $("btnPlay").textContent = "▶ 播放";
      state.speaking = false;
    } finally {
      state.abort = null;
    }
  }

  function speakBrowserChunks(chunks) {
    if (!synth) {
      setStatus("浏览器不支持 Web Speech API");
      return;
    }
    synth.cancel();
    let i = 0;
    const speakOne = () => {
      if (state.stopRequested) return;
      if (i >= chunks.length) {
        state.speaking = false;
        state.paused = false;
        $("btnPlay").textContent = "▶ 播放";
        if (state.queueMode) advanceAndPlay();
        else setStatus("本条读完");
        return;
      }
      const u = new SpeechSynthesisUtterance(chunks[i]);
      u.lang = "zh-CN";
      u.rate = Number($("rate").value) || 1;
      u.volume = Number($("volume").value) || 1;
      const name = $("voice").value;
      const voices = synth.getVoices() || [];
      const voice = voices.find((v) => v.name === name);
      if (voice) u.voice = voice;
      u.onstart = () => {
        state.speaking = true;
        state.paused = false;
        $("btnPlay").textContent = "⏸ 暂停";
        setStatus(
          chunks.length > 1
            ? `朗读中 ${i + 1}/${chunks.length}（浏览器引擎）…`
            : "朗读中（浏览器引擎）…"
        );
      };
      u.onend = () => {
        i += 1;
        speakOne();
      };
      u.onerror = (e) => {
        if (e.error === "interrupted" || e.error === "canceled") return;
        state.speaking = false;
        $("btnPlay").textContent = "▶ 播放";
        setStatus(`朗读出错：${e.error || "unknown"}`);
      };
      synth.speak(u);
    };
    speakOne();
  }

  function advanceAndPlay() {
    if (state.index + 1 >= state.filtered.length) {
      state.queueMode = false;
      setStatus("全部读完");
      $("btnPlay").textContent = "▶ 播放";
      return;
    }
    state.index += 1;
    renderList();
    setProgress();
    setTimeout(() => speakCurrent(), 280);
  }

  function togglePlayPause() {
    if (state.engine === "edge" && state.audio) {
      if (state.speaking && !state.paused) {
        state.audio.pause();
        state.paused = true;
        $("btnPlay").textContent = "▶ 继续";
        setStatus("已暂停");
        return;
      }
      if (state.paused) {
        state.audio.play();
        state.paused = false;
        $("btnPlay").textContent = "⏸ 暂停";
        setStatus("朗读中（Edge 神经网络）…");
        return;
      }
    }
    if (state.engine === "browser" && synth) {
      if (state.speaking && !state.paused) {
        synth.pause();
        state.paused = true;
        $("btnPlay").textContent = "▶ 继续";
        setStatus("已暂停");
        return;
      }
      if (state.paused) {
        synth.resume();
        state.paused = false;
        $("btnPlay").textContent = "⏸ 暂停";
        setStatus("朗读中（浏览器引擎）…");
        return;
      }
    }
    state.queueMode = false;
    speakCurrent();
  }

  // ---------- events ----------
  $("btnLoad").addEventListener("click", () => fetchItems({ append: false }));
  $("btnMore").addEventListener("click", () => fetchItems({ append: true }));
  $("filter").addEventListener("input", applyFilter);
  $("minScore").addEventListener("change", () => fetchItems({ append: false }));
  $("engine").addEventListener("change", onEngineChange);

  $("btnPlay").addEventListener("click", togglePlayPause);
  $("btnStop").addEventListener("click", () => {
    stopSpeaking();
    setStatus("已停止");
  });
  $("btnPrev").addEventListener("click", () => {
    if (state.index <= 0) return;
    const wasQueue = state.queueMode;
    const auto = state.speaking || state.paused;
    selectIndex(state.index - 1, auto);
    if (wasQueue && auto) state.queueMode = true;
  });
  $("btnNext").addEventListener("click", () => {
    if (state.index >= state.filtered.length - 1) return;
    const wasQueue = state.queueMode;
    const auto = state.speaking || state.paused;
    selectIndex(state.index + 1, auto);
    if (wasQueue && auto) state.queueMode = true;
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

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (e.code === "Space") {
      e.preventDefault();
      togglePlayPause();
    } else if (e.code === "ArrowRight") {
      $("btnNext").click();
    } else if (e.code === "ArrowLeft") {
      $("btnPrev").click();
    }
  });

  // init
  loadEdgeVoices().then(() => {
    setStatus("引擎：Edge 神经网络（默认晓晓）· 点刷新列表开始");
  });
  fetchItems({ append: false });
})();
