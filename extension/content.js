/**
 * 在 AI HOT 页面注入悬浮播放条
 * 列表仍看网页；这里只抽当前页 DOM 来朗读
 */
(function () {
  if (window.__aihotReaderInjected) return;
  window.__aihotReaderInjected = true;

  const state = {
    items: [],
    index: 0,
    queueMode: false,
    speaking: false,
    paused: false,
    audio: null,
    audioUrl: null,
    chunkQueue: [],
    stopRequested: false,
    collapsed: false,
    /** 每次新开播 / 停止 +1；过期回调一律丢弃，防止重叠朗读 */
    sessionId: 0,
    engine: null, // 'audio' | 'webspeech' | null
    prefs: {
      speakMode: "title_summary", // title | summary | title_summary | full
      voice: "zh-CN-XiaoxiaoNeural",
      rate: 1,
      volume: 1,
    },
  };

  function isSession(sid) {
    return sid === state.sessionId && !state.stopRequested;
  }

  // ---------- DOM 抽取 ----------
  function clean(s) {
    return String(s || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function extractListItems() {
    const out = [];
    const seen = new Set();

    // 桌面时间线卡片
    document.querySelectorAll(".timeline-card, article.timeline-card").forEach((card, i) => {
      const titleEl =
        card.querySelector("a.timeline-title") ||
        card.querySelector(".timeline-title") ||
        card.querySelector("a[href*='/items/']");
      const summaryEl = card.querySelector(".timeline-summary, p.timeline-summary");
      const sourceEl = card.querySelector(".timeline-source");
      const href = titleEl?.getAttribute("href") || "";
      const idMatch = href.match(/\/items\/([a-z0-9]+)/i);
      const id = idMatch ? idMatch[1] : `dom-${i}-${(titleEl?.textContent || "").slice(0, 12)}`;
      if (seen.has(id)) return;
      seen.add(id);
      const title = clean(titleEl?.textContent);
      if (!title) return;
      const itemEl = card.closest(".timeline-item") || card;
      out.push({
        id,
        title,
        summary: clean(summaryEl?.textContent),
        source: clean(sourceEl?.textContent),
        permalink: href.startsWith("http") ? href : href ? `https://aihot.virxact.com${href}` : "",
        el: itemEl,
        cardEl: card,
      });
    });

    // 移动端行
    if (!out.length) {
      document.querySelectorAll(".m-row, a.m-row").forEach((row, i) => {
        const title = clean(row.querySelector(".m-title, .title")?.textContent || row.textContent);
        if (!title || title.length < 4) return;
        const href = row.getAttribute("href") || row.querySelector("a")?.getAttribute("href") || "";
        const idMatch = href.match(/\/items\/([a-z0-9]+)/i);
        const id = idMatch ? idMatch[1] : `m-${i}`;
        if (seen.has(id)) return;
        seen.add(id);
        out.push({
          id,
          title,
          summary: "",
          source: clean(row.querySelector(".m-source")?.textContent),
          permalink: href,
          el: row,
          cardEl: row,
        });
      });
    }

    return out;
  }

  function extractDetailPage() {
    if (!/\/items\/[a-z0-9]+/i.test(location.pathname)) return null;
    const idMatch = location.pathname.match(/\/items\/([a-z0-9]+)/i);
    const id = idMatch ? idMatch[1] : "detail";
    const title =
      clean(document.querySelector("h1")?.textContent) ||
      clean(document.title.replace(/\s*[·|].*$/, ""));
    // 摘要
    let summary = "";
    const all = Array.from(document.querySelectorAll("p, div, section"));
    for (const el of all) {
      if (/AI\s*摘要/.test(el.textContent || "") && (el.textContent || "").length < 40) {
        const next = el.nextElementSibling;
        if (next) summary = clean(next.textContent);
        break;
      }
    }
    // 正文：#article-body 或「原文」后
    let full = "";
    const body = document.querySelector("#article-body, [id='article-body']");
    if (body) full = clean(body.innerText || body.textContent);
    if (!full || full.length < 40) {
      const main = document.querySelector("main, article, .app-main");
      if (main) {
        let t = clean(main.innerText || "");
        const i = t.indexOf("原文");
        if (i >= 0) t = t.slice(i + 2);
        for (const cut of ["同一事件", "推荐理由", "阅读原文", "导出 Markdown"]) {
          const c = t.indexOf(cut);
          if (c > 80) t = t.slice(0, c);
        }
        full = clean(t);
      }
    }
    const source = clean(
      document.querySelector(".timeline-source, .uc-handle")?.textContent || ""
    );
    return {
      id,
      title,
      summary,
      source,
      fullText: full,
      permalink: location.href,
      el: body || document.querySelector("main"),
      cardEl: body || document.querySelector("main"),
      isDetail: true,
    };
  }

  function isDailyPage() {
    return /^\/daily(\/|$)/i.test(location.pathname || "");
  }

  /** 在页面上按条目链接反查 DOM，用于高亮 */
  function findDomForPermalink(permalink) {
    if (!permalink) return null;
    const idMatch = String(permalink).match(/\/items\/([a-z0-9]+)/i);
    if (!idMatch) return null;
    const id = idMatch[1];
    const a = document.querySelector(`a[href*="/items/${id}"]`);
    if (!a) return null;
    const card =
      a.closest("article") ||
      a.closest("[class*='card']") ||
      a.closest("[class*='item']") ||
      a.closest("li") ||
      a.closest("section") ||
      a.parentElement;
    return { el: card || a, cardEl: card || a };
  }

  /**
   * AI 日报：结构与 /all 不同，优先走官方 /api/public/daily
   * 再尝试页面 DOM 兜底
   */
  async function extractDailyItems() {
    if (!isDailyPage()) return null;

    const dateMatch = location.pathname.match(/\/daily\/(\d{4}-\d{2}-\d{2})/i);
    const apiUrl = dateMatch
      ? `https://aihot.virxact.com/api/public/daily/${dateMatch[1]}`
      : "https://aihot.virxact.com/api/public/daily";

    // 1) 官方 API（扩展有 host_permissions，可跨过 CORS）
    try {
      const r = await fetch(apiUrl, {
        headers: { Accept: "application/json" },
        credentials: "omit",
      });
      if (r.ok) {
        const data = await r.json();
        const out = [];
        const dateLabel = data.date || dateMatch?.[1] || "";
        // 开场一条：方便「从本页播」先报日期
        if (dateLabel || data.lead) {
          out.push({
            id: `daily-open-${dateLabel || "latest"}`,
            title: `AI 日报 ${dateLabel}`.trim(),
            summary: clean(data.lead || `共 ${(data.sections || []).reduce((n, s) => n + (s.items || []).length, 0)} 条精选。`),
            source: "AI HOT 日报",
            section: "开场",
            permalink: data.attribution?.canonical || location.href,
            el: document.querySelector("h1, .page-header, main"),
            cardEl: document.querySelector("h1, .page-header, main"),
            isDaily: true,
          });
        }
        for (const sec of data.sections || []) {
          const label = clean(sec.label || sec.name || "栏目");
          for (const it of sec.items || []) {
            const permalink = it.permalink || it.attribution?.canonical || "";
            const idMatch = String(permalink).match(/\/items\/([a-z0-9]+)/i);
            const id = idMatch ? idMatch[1] : `daily-${out.length}`;
            const dom = findDomForPermalink(permalink);
            out.push({
              id,
              title: clean(it.title),
              summary: clean(it.summary),
              source: clean(it.sourceName || it.source || ""),
              section: label,
              permalink,
              el: dom?.el || null,
              cardEl: dom?.cardEl || null,
              isDaily: true,
            });
          }
        }
        if (out.length) return out;
      }
    } catch (e) {
      console.warn("daily api failed", e);
    }

    // 2) DOM 兜底：日报页常见块
    const out = [];
    const seen = new Set();

    // 按 section 标题拆：h2/h3 后跟链接列表
    const main = document.querySelector("main, .app-main, .page") || document.body;
    const heads = main.querySelectorAll("h2, h3, .section-title, [class*='section'] > h2, [class*='section'] > h3");
    if (heads.length) {
      heads.forEach((h) => {
        const section = clean(h.textContent);
        if (!section || /关于|反馈|登录|主题/.test(section)) return;
        let node = h.nextElementSibling;
        let guard = 0;
        while (node && guard++ < 40) {
          if (/^H[23]$/i.test(node.tagName)) break;
          node.querySelectorAll?.("a[href*='/items/']").forEach((a) => {
            const href = a.getAttribute("href") || "";
            const idMatch = href.match(/\/items\/([a-z0-9]+)/i);
            const id = idMatch ? idMatch[1] : href;
            if (seen.has(id)) return;
            const title = clean(a.textContent);
            if (!title || title.length < 4) return;
            seen.add(id);
            const block =
              a.closest("article") ||
              a.closest("li") ||
              a.closest("[class*='card']") ||
              a.closest("[class*='item']") ||
              a.parentElement;
            let summary = "";
            const p = block?.querySelector("p");
            if (p) summary = clean(p.textContent);
            if (!summary && block) {
              const t = clean(block.innerText || "");
              if (t.length > title.length + 8) summary = clean(t.replace(title, "").slice(0, 400));
            }
            out.push({
              id,
              title,
              summary,
              source: "",
              section,
              permalink: href.startsWith("http") ? href : `https://aihot.virxact.com${href}`,
              el: block,
              cardEl: block,
              isDaily: true,
            });
          });
          node = node.nextElementSibling;
        }
      });
    }

    // 再兜底：页内所有日报条目链接
    if (!out.length) {
      document.querySelectorAll("a[href*='/items/']").forEach((a, i) => {
        const href = a.getAttribute("href") || "";
        const idMatch = href.match(/\/items\/([a-z0-9]+)/i);
        const id = idMatch ? idMatch[1] : `d-${i}`;
        if (seen.has(id)) return;
        const title = clean(a.textContent);
        if (!title || title.length < 6) return;
        // 侧栏/导航短链跳过
        if (title.length < 8 && !a.closest("main, .app-main, article")) return;
        seen.add(id);
        const block =
          a.closest("article") ||
          a.closest("li") ||
          a.closest("[class*='card']") ||
          a.parentElement;
        let summary = "";
        const p = block?.querySelector("p");
        if (p && p !== a) summary = clean(p.textContent);
        out.push({
          id,
          title,
          summary,
          source: "",
          section: "",
          permalink: href.startsWith("http") ? href : `https://aihot.virxact.com${href}`,
          el: block,
          cardEl: block,
          isDaily: true,
        });
      });
    }

    return out.length ? out : [];
  }

  async function refreshItems() {
    // 详情
    const detail = extractDetailPage();
    if (detail && (detail.fullText || detail.summary || detail.title)) {
      state.items = [detail];
      state.index = 0;
      return state.items;
    }

    // AI 日报
    if (isDailyPage()) {
      const daily = await extractDailyItems();
      state.items = daily || [];
      if (state.index >= state.items.length) state.index = Math.max(0, state.items.length - 1);
      return state.items;
    }

    // 全部 / 精选时间线
    state.items = extractListItems();
    if (state.index >= state.items.length) state.index = Math.max(0, state.items.length - 1);
    return state.items;
  }

  function buildSpeakText(item) {
    const mode = state.prefs.speakMode;
    const section = item.section && item.section !== "开场" ? `栏目：${item.section}。` : "";
    const head = [
      section,
      item.source ? `来源：${item.source}。` : "",
    ].join("");
    if (mode === "title") return `${head}${item.title || ""}`;
    if (mode === "summary") {
      return item.summary ? `${head}${item.summary}` : `${head}${item.title || ""}`;
    }
    if (mode === "full") {
      if (item.fullText) {
        return `${head}${item.title || ""}。${item.fullText}`;
      }
      // 日报没有站内长文，用摘要当「全文」够用
      if (item.isDaily && item.summary) {
        return `${head}${item.title || ""}。${item.summary}`;
      }
      if (item.summary) {
        return `${head}${item.title || ""}。摘要：${item.summary}。正文请打开详情页后选全文朗读。`;
      }
      return `${head}${item.title || ""}`;
    }
    // title_summary
    if (item.summary) return `${head}${item.title || ""}。${item.isDaily ? "" : "摘要："}${item.summary}`;
    return `${head}${item.title || ""}`;
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

  // ---------- 高亮 ----------
  function clearHighlight() {
    document.querySelectorAll(".aihot-reading, .aihot-reading-item").forEach((el) => {
      el.classList.remove("aihot-reading", "aihot-reading-item");
    });
  }

  function highlightCurrent() {
    clearHighlight();
    const item = state.items[state.index];
    if (!item) return;
    if (item.cardEl) item.cardEl.classList.add("aihot-reading");
    if (item.el) {
      item.el.classList.add("aihot-reading-item");
      try {
        item.el.scrollIntoView({ block: "center", behavior: "smooth" });
      } catch {}
    }
    updateNow();
  }

  // ---------- TTS（单会话，禁止重叠） ----------
  function killSpeechSynth() {
    try {
      const s = window.speechSynthesis;
      if (!s) return;
      s.cancel();
      // Chrome 偶发 cancel 不干净，连点两次更稳
      s.cancel();
    } catch {}
  }

  function cleanupAudio() {
    if (state.audio) {
      try {
        state.audio.onended = null;
        state.audio.onerror = null;
        state.audio.onplay = null;
        state.audio.pause();
        state.audio.removeAttribute("src");
        state.audio.load?.();
      } catch {}
      state.audio = null;
    }
    if (state.audioUrl) {
      try {
        URL.revokeObjectURL(state.audioUrl);
      } catch {}
      state.audioUrl = null;
    }
  }

  /** 硬停所有声源；bumpSession=true 时作废所有进行中的合成回调 */
  function hardStopPlayback({ bumpSession = true, clearQueueMode = false } = {}) {
    if (bumpSession) state.sessionId += 1;
    state.stopRequested = true;
    state.speaking = false;
    state.paused = false;
    state.chunkQueue = [];
    state.engine = null;
    if (clearQueueMode) state.queueMode = false;
    cleanupAudio();
    killSpeechSynth();
  }

  function stopAll() {
    hardStopPlayback({ bumpSession: true, clearQueueMode: true });
    setStatus("已停止");
    setPlayLabel("▶");
  }

  function ttsRequest(text, sid) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "aihot-tts",
          text,
          voice: state.prefs.voice,
          rate: state.prefs.rate,
          volume: state.prefs.volume,
        },
        (res) => {
          // 会话已切换：当成功，不报错也不播放
          if (!isSession(sid)) {
            resolve(null);
            return;
          }
          if (chrome.runtime.lastError) {
            reject(
              Object.assign(new Error(chrome.runtime.lastError.message), {
                useWebSpeech: true,
              })
            );
            return;
          }
          if (!res?.ok) {
            const err = new Error(res?.error || "tts failed");
            err.useWebSpeech = !!res?.useWebSpeech;
            reject(err);
            return;
          }
          resolve(new Uint8Array(res.audio).buffer);
        }
      );
    });
  }

  /** 系统语音；全程绑定 sessionId */
  function speakWebSpeechChunks(chunks, sid) {
    const synth = window.speechSynthesis;
    if (!synth) return Promise.reject(new Error("无 Web Speech API"));
    killSpeechSynth();
    state.engine = "webspeech";

    return new Promise((resolve, reject) => {
      let i = 0;
      let settled = false;
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const next = () => {
        if (!isSession(sid)) {
          killSpeechSynth();
          finish(() => resolve());
          return;
        }
        if (i >= chunks.length) {
          if (!isSession(sid)) {
            finish(() => resolve());
            return;
          }
          state.speaking = false;
          state.engine = null;
          setPlayLabel("▶");
          if (state.queueMode) advance();
          else setStatus("本条读完（系统语音）");
          finish(() => resolve());
          return;
        }

        const u = new SpeechSynthesisUtterance(chunks[i]);
        u.lang = "zh-CN";
        u.rate = state.prefs.rate || 1;
        u.volume = state.prefs.volume ?? 1;
        const voices = synth.getVoices() || [];
        const zh = voices.find((v) => /zh-CN|Chinese|中文/i.test(v.lang + v.name));
        if (zh) u.voice = zh;

        u.onstart = () => {
          if (!isSession(sid)) {
            killSpeechSynth();
            return;
          }
          state.speaking = true;
          state.paused = false;
          state.engine = "webspeech";
          setPlayLabel("⏸");
          setStatus(
            chunks.length > 1
              ? `系统语音 ${i + 1}/${chunks.length}`
              : "朗读中（系统语音·音质一般）"
          );
        };
        u.onend = () => {
          if (!isSession(sid)) {
            finish(() => resolve());
            return;
          }
          i += 1;
          next();
        };
        u.onerror = (ev) => {
          if (ev.error === "interrupted" || ev.error === "canceled") {
            finish(() => resolve());
            return;
          }
          if (!isSession(sid)) {
            finish(() => resolve());
            return;
          }
          finish(() => reject(new Error(ev.error || "webspeech error")));
        };
        try {
          synth.speak(u);
        } catch (e) {
          finish(() => reject(e));
        }
      };

      if (!(synth.getVoices() || []).length) {
        const onV = () => {
          synth.onvoiceschanged = null;
          if (isSession(sid)) next();
        };
        synth.onvoiceschanged = onV;
        setTimeout(() => {
          if (isSession(sid) && i === 0 && !settled) next();
        }, 350);
      } else {
        next();
      }
    });
  }

  async function speakCurrent() {
    // 开新会话：立刻作废上一轮（含后台还在合成的）
    hardStopPlayback({ bumpSession: true, clearQueueMode: false });
    const sid = state.sessionId;
    state.stopRequested = false;

    setStatus(isDailyPage() ? "加载日报…" : "识别本页…");
    await refreshItems();
    if (!isSession(sid)) return;

    const item = state.items[state.index];
    if (!item) {
      setStatus(
        isDailyPage()
          ? "日报未识别到条目，请刷新页面后再试"
          : "本页没找到可朗读条目"
      );
      return;
    }
    highlightCurrent();

    const text = buildSpeakText(item);
    if (!text.trim()) {
      setStatus("本条无文本");
      if (state.queueMode && isSession(sid)) return advance();
      return;
    }
    const chunks = splitForTts(text, 2200);
    state.chunkQueue = chunks.slice(1);
    // 短等一拍，让 cancel 的 speechSynthesis 落稳
    await new Promise((r) => setTimeout(r, 40));
    if (!isSession(sid)) return;
    await playChunk(chunks[0], 1, chunks.length, chunks, sid);
  }

  async function playChunk(text, part, total, allChunks, sid) {
    if (!isSession(sid)) return;
    setStatus(total > 1 ? `合成 ${part}/${total}…` : "合成中…");
    setPlayLabel("…");

    try {
      // 神经网络合成前确保系统语音静音
      killSpeechSynth();
      const ab = await ttsRequest(text, sid);
      if (!isSession(sid)) return;
      if (!ab) return; // 被取消

      cleanupAudio();
      const blob = new Blob([ab], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      if (!isSession(sid)) {
        URL.revokeObjectURL(url);
        return;
      }
      state.audioUrl = url;
      const audio = new Audio(url);
      state.audio = audio;
      state.engine = "audio";
      audio.volume = Math.min(1, Math.max(0, state.prefs.volume));

      audio.onplay = () => {
        if (!isSession(sid)) {
          try {
            audio.pause();
          } catch {}
          return;
        }
        state.speaking = true;
        state.paused = false;
        setPlayLabel("⏸");
        setStatus(total > 1 ? `朗读 ${part}/${total}` : "朗读中（神经网络）");
      };
      audio.onended = async () => {
        if (!isSession(sid)) return;
        if (state.chunkQueue.length) {
          const next = state.chunkQueue.shift();
          await playChunk(next, part + 1, total, allChunks, sid);
          return;
        }
        state.speaking = false;
        state.engine = null;
        setPlayLabel("▶");
        if (state.queueMode) advance();
        else setStatus("本条读完");
      };
      audio.onerror = () => {
        if (!isSession(sid)) return;
        state.speaking = false;
        state.engine = null;
        setPlayLabel("▶");
        setStatus("播放失败，可再点一次");
      };

      await audio.play();
    } catch (e) {
      if (!isSession(sid)) return;
      console.warn("neural tts failed, webspeech fallback", e);
      // 失败重试时先清干净，避免和后到的 audio 重叠
      cleanupAudio();
      killSpeechSynth();
      setStatus("神经网络失败，改用系统语音…");
      try {
        const rest =
          allChunks && part === 1 ? allChunks : [text, ...state.chunkQueue];
        state.chunkQueue = [];
        await new Promise((r) => setTimeout(r, 50));
        if (!isSession(sid)) return;
        await speakWebSpeechChunks(rest, sid);
      } catch (e2) {
        if (!isSession(sid)) return;
        state.speaking = false;
        state.engine = null;
        setPlayLabel("▶");
        setStatus(`失败：${e.message || e2.message}（再点一次可重试）`);
      }
    }
  }

  function pauseAll() {
    let did = false;
    if (state.audio && !state.audio.paused) {
      try {
        state.audio.pause();
        did = true;
      } catch {}
    }
    try {
      const s = window.speechSynthesis;
      if (s && (s.speaking || s.pending || s.paused)) {
        // 系统语音 pause 在部分浏览器不可靠；暂停时直接 cancel，避免幽灵声
        if (state.engine === "webspeech" || s.speaking || s.pending) {
          s.cancel();
          s.cancel();
          did = true;
          // cancel 后无法 resume，标记需重新播
          state.engine = null;
          state.paused = false;
          state.speaking = false;
          setPlayLabel("▶");
          setStatus("已停止系统语音（再点 ▶ 重播）");
          return true;
        }
      }
    } catch {}
    if (did || state.speaking || (state.audio && state.audio.paused)) {
      state.paused = true;
      state.speaking = false;
      setPlayLabel("▶");
      setStatus("已暂停");
      return true;
    }
    return false;
  }

  function resumeAll() {
    let did = false;
    if (state.audio && state.audio.paused && state.audioUrl) {
      try {
        state.audio.play();
        did = true;
        state.engine = "audio";
      } catch {}
    }
    try {
      const s = window.speechSynthesis;
      if (s && s.paused) {
        s.resume();
        did = true;
        state.engine = "webspeech";
      }
    } catch {}
    if (did) {
      state.paused = false;
      state.speaking = true;
      setPlayLabel("⏸");
      setStatus("朗读中");
      return true;
    }
    return false;
  }

  function togglePlay() {
    // 正在播 → 暂停（两种引擎都停）
    if (state.speaking && !state.paused) {
      pauseAll();
      return;
    }
    // 已暂停 → 继续
    if (state.paused) {
      if (resumeAll()) return;
      // 暂停态已丢（无音频对象）→ 当重新播放
    }
    // 未在播：新开播（会 hardStop 旧会话）
    state.queueMode = false;
    speakCurrent();
  }

  function advance() {
    if (state.index + 1 >= state.items.length) {
      state.queueMode = false;
      state.speaking = false;
      state.engine = null;
      setStatus("本页读完");
      setPlayLabel("▶");
      return;
    }
    state.index += 1;
    setTimeout(() => {
      speakCurrent();
    }, 200);
  }

  // ---------- UI ----------
  let root, nowEl, statusEl, playBtn;

  function setStatus(t) {
    if (statusEl) statusEl.textContent = t;
  }
  function setPlayLabel(t) {
    if (playBtn) playBtn.textContent = t;
  }
  function updateNow() {
    const item = state.items[state.index];
    if (!nowEl) return;
    if (!item) {
      nowEl.textContent = "在页面点一条资讯，或点「从当前页播」";
      return;
    }
    nowEl.textContent = `${state.index + 1}/${state.items.length} · ${item.title}`;
  }

  function buildUI() {
    if (document.getElementById("aihot-reader-root")) return;
    root = document.createElement("div");
    root.id = "aihot-reader-root";
    root.innerHTML = `
      <div class="ar-panel" id="ar-panel">
        <div class="ar-head">
          <span class="ar-title">AI HOT 朗读</span>
          <button type="button" class="ar-min" id="ar-collapse" title="收起">—</button>
        </div>
        <div class="ar-now" id="ar-now">列表请看网页，这里只控制播放</div>
        <div class="ar-status" id="ar-status">就绪</div>
        <div class="ar-row">
          <button type="button" class="ar-btn" id="ar-prev">⏮</button>
          <button type="button" class="ar-btn primary" id="ar-play">▶</button>
          <button type="button" class="ar-btn" id="ar-next">⏭</button>
          <button type="button" class="ar-btn" id="ar-stop">⏹</button>
          <button type="button" class="ar-btn accent" id="ar-all">从本页播</button>
        </div>
        <div class="ar-row">
          <label class="ar-lab">内容
            <select id="ar-mode">
              <option value="title_summary" selected>标题+摘要</option>
              <option value="summary">仅摘要</option>
              <option value="title">仅标题</option>
              <option value="full">全文(详情页)</option>
            </select>
          </label>
          <label class="ar-lab">声
            <select id="ar-voice"></select>
          </label>
        </div>
        <div class="ar-row">
          <label class="ar-lab">速 <input id="ar-rate" type="range" min="0.6" max="1.5" step="0.05" value="1" /></label>
          <label class="ar-lab">量 <input id="ar-vol" type="range" min="0" max="1" step="0.05" value="1" /></label>
        </div>
        <div class="ar-hint">换声音/语速/内容模式会立刻用新设置重念当前条 · 音量实时</div>
      </div>
    `;
    document.documentElement.appendChild(root);

    nowEl = root.querySelector("#ar-now");
    statusEl = root.querySelector("#ar-status");
    playBtn = root.querySelector("#ar-play");

    const voiceSel = root.querySelector("#ar-voice");
    const voices = [
      ["zh-CN-XiaoxiaoNeural", "晓晓"],
      ["zh-CN-YunxiNeural", "云希"],
      ["zh-CN-YunyangNeural", "云扬"],
      ["zh-CN-XiaoyiNeural", "晓伊"],
      ["zh-CN-YunjianNeural", "云健"],
      ["zh-CN-XiaomoNeural", "晓墨"],
      ["zh-CN-YunfengNeural", "云枫"],
      ["zh-CN-YunzeNeural", "云泽"],
    ];
    for (const [id, name] of voices) {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = name;
      voiceSel.appendChild(o);
    }

    // prefs
    chrome.storage.local.get(["speakMode", "voice", "rate", "volume", "barCollapsed"], (p) => {
      if (p.speakMode) {
        state.prefs.speakMode = p.speakMode;
        root.querySelector("#ar-mode").value = p.speakMode;
      }
      if (p.voice) {
        state.prefs.voice = p.voice;
        voiceSel.value = p.voice;
      }
      if (p.rate) {
        state.prefs.rate = Number(p.rate);
        root.querySelector("#ar-rate").value = p.rate;
      }
      if (p.volume != null) {
        state.prefs.volume = Number(p.volume);
        root.querySelector("#ar-vol").value = p.volume;
      }
      if (p.barCollapsed) collapse(true);
    });

    root.querySelector("#ar-play").addEventListener("click", togglePlay);
    root.querySelector("#ar-stop").addEventListener("click", stopAll);
    root.querySelector("#ar-prev").addEventListener("click", () => {
      if (state.index <= 0) return;
      const auto = state.speaking || state.paused;
      state.index -= 1;
      highlightCurrent();
      if (auto) {
        state.queueMode = state.queueMode;
        speakCurrent();
      }
    });
    root.querySelector("#ar-next").addEventListener("click", () => {
      if (state.index >= state.items.length - 1) return;
      const auto = state.speaking || state.paused;
      state.index += 1;
      highlightCurrent();
      if (auto) speakCurrent();
    });
    root.querySelector("#ar-all").addEventListener("click", () => {
      (async () => {
        setStatus(isDailyPage() ? "加载日报…" : "识别本页…");
        await refreshItems();
        if (!state.items.length) {
          setStatus(isDailyPage() ? "日报没有条目" : "本页没有条目");
          return;
        }
        state.queueMode = true;
        speakCurrent();
      })();
    });
    root.querySelector("#ar-collapse").addEventListener("click", (e) => {
      e.stopPropagation();
      collapseSimple();
    });
    /** 正在播/暂停时改设置 → 用新设置重念当前条（保留「从本页播」队列） */
    function isActivelyReading() {
      return !!(
        state.speaking ||
        state.paused ||
        state.engine ||
        (state.audio && state.audioUrl) ||
        window.speechSynthesis?.speaking ||
        window.speechSynthesis?.pending
      );
    }
    function restartCurrentWithNewPrefs() {
      if (!isActivelyReading()) return;
      if (!state.items.length) return;
      const keepQueue = state.queueMode;
      setStatus("已应用新设置，重念当前…");
      speakCurrent().then(() => {
        state.queueMode = keepQueue;
      });
      // speakCurrent 开头会 hardStop，queueMode 默认保留 false 路径：
      // speakCurrent 里 clearQueueMode:false，不会清 queueMode；上面再写一次更稳
      state.queueMode = keepQueue;
    }

    let rateRestartTimer = null;

    root.querySelector("#ar-mode").addEventListener("change", (e) => {
      state.prefs.speakMode = e.target.value;
      chrome.storage.local.set({ speakMode: e.target.value });
      restartCurrentWithNewPrefs();
    });
    voiceSel.addEventListener("change", (e) => {
      state.prefs.voice = e.target.value;
      chrome.storage.local.set({ voice: e.target.value });
      restartCurrentWithNewPrefs();
    });
    root.querySelector("#ar-rate").addEventListener("input", (e) => {
      state.prefs.rate = Number(e.target.value);
      chrome.storage.local.set({ rate: e.target.value });
      // 拖动滑条会连续触发，防抖后再重念，避免狂合成
      clearTimeout(rateRestartTimer);
      rateRestartTimer = setTimeout(() => restartCurrentWithNewPrefs(), 450);
    });
    root.querySelector("#ar-vol").addEventListener("input", (e) => {
      state.prefs.volume = Number(e.target.value);
      // 音量可实时作用在当前音频上，不必重念
      if (state.audio) state.audio.volume = state.prefs.volume;
      chrome.storage.local.set({ volume: e.target.value });
    });

    // 点击页面卡片 → 选中对应条目
    document.addEventListener(
      "click",
      (e) => {
        const card =
          e.target.closest?.(".timeline-card") ||
          e.target.closest?.(".timeline-item") ||
          e.target.closest?.(".m-row");
        if (!card) return;
        (async () => {
          await refreshItems();
          const idx = state.items.findIndex(
            (it) =>
              it.cardEl === card ||
              it.el === card ||
              it.el?.contains?.(card) ||
              it.cardEl?.contains?.(card) ||
              (it.permalink && card.querySelector?.(`a[href*="${it.id}"]`))
          );
          if (idx >= 0) {
            state.index = idx;
            highlightCurrent();
            setStatus("已选中 · 点 ▶ 朗读");
          }
        })();
      },
      true
    );

    (async () => {
      await refreshItems();
      updateNow();
      if (isDailyPage()) {
        setStatus(
          state.items.length
            ? `日报 ${state.items.length} 段 · 可「从本页播」`
            : "日报加载中或失败，点「从本页播」重试"
        );
      } else {
        setStatus(
          state.items.length
            ? `本页 ${state.items.length} 条 · 点卡片选中再播`
            : "未识别到条目"
        );
      }
    })();
  }

  function collapseSimple() {
    const panel = document.querySelector("#aihot-reader-root .ar-panel");
    if (!panel || !root) return;
    state.collapsed = true;
    panel.style.display = "none";
    let fab = document.getElementById("aihot-reader-fab");
    if (!fab) {
      fab = document.createElement("div");
      fab.id = "aihot-reader-fab";
      fab.className = "ar-panel ar-collapsed";
      fab.textContent = "🎧 朗读";
      fab.style.cursor = "pointer";
      root.appendChild(fab);
      fab.onclick = () => {
        state.collapsed = false;
        panel.style.display = "";
        fab.remove();
        chrome.storage.local.set({ barCollapsed: false });
      };
    }
    chrome.storage.local.set({ barCollapsed: true });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "aihot-show-bar") {
      buildUI();
      (async () => {
        await refreshItems();
        updateNow();
        setStatus(
          state.items.length
            ? `${isDailyPage() ? "日报" : "本页"} ${state.items.length} 条`
            : isDailyPage()
              ? "日报未加载到条目"
              : "未识别到列表"
        );
      })();
    }
  });

  function boot() {
    buildUI();
    let last = location.href;
    setInterval(() => {
      if (location.href !== last) {
        last = location.href;
        state.index = 0;
        (async () => {
          await refreshItems();
          updateNow();
          setStatus(
            state.items.length
              ? `${isDailyPage() ? "日报" : "本页"} ${state.items.length} 条`
              : "本页无列表"
          );
        })();
      }
    }, 1200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
