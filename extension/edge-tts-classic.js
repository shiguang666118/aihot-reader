/**
 * Edge 神经网络 TTS（classic script）
 * 挂到 globalThis.AihotEdgeTTS
 *
 * 注意：浏览器 WebSocket 无法自定义 Origin，扩展需配合 declarativeNetRequest
 * 把 Origin 改成微软 Read Aloud 扩展 ID，否则会握手失败。
 */
(function (g) {
  const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  const WSS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
  const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
  // 与近期 Edge / msedge-tts 对齐
  const CHROMIUM_FULL_VERSION = "143.0.3650.96";
  const SEC_MS_GEC_VERSION = "1-" + CHROMIUM_FULL_VERSION;

  function randomHex(bytes) {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function secMsGec() {
    // Windows FILETIME ticks, rounded down to 5 minutes (300s)
    const ticks = Math.floor(Date.now() / 1000) + 11644473600;
    const rounded = ticks - (ticks % 300);
    const windowsTicks = rounded * 10000000;
    const data = new TextEncoder().encode(`${windowsTicks}${TRUSTED_CLIENT_TOKEN}`);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  }

  function escapeXml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function findBinaryHeaderEnd(u8, markerStr) {
    const marker = new TextEncoder().encode(markerStr);
    outer: for (let i = 0; i <= u8.length - marker.length; i++) {
      for (let j = 0; j < marker.length; j++) {
        if (u8[i + j] !== marker[j]) continue outer;
      }
      return i + marker.length;
    }
    return -1;
  }

  /**
   * @returns {Promise<ArrayBuffer>}
   */
  async function synthesize(text, opts = {}) {
    const voice = opts.voice || "zh-CN-XiaoxiaoNeural";
    let rate = Number(opts.rate);
    if (!Number.isFinite(rate)) rate = 1;
    rate = Math.min(1.8, Math.max(0.5, rate));

    let volume = Number(opts.volume);
    if (!Number.isFinite(volume)) volume = 100;
    if (volume <= 1) volume = Math.round(volume * 100);
    volume = Math.min(100, Math.max(0, volume));

    const clean = String(text || "").trim();
    if (!clean) throw new Error("empty text");
    const input = clean.length > 2800 ? clean.slice(0, 2800) : clean;

    const requestId = randomHex(16);
    const sec = await secMsGec();
    const connId = randomHex(16);
    const url =
      `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&Sec-MS-GEC=${sec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connId}`;

    const langMatch = voice.match(/[a-z]{2}-[A-Z]{2}/);
    const lang = langMatch ? langMatch[0] : "zh-CN";
    const chunks = [];

    await new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(new Error("WebSocket create failed: " + (e.message || e)));
        return;
      }
      ws.binaryType = "arraybuffer";
      let settled = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {}
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const done = () => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {}
        resolve();
      };
      const timer = setTimeout(() => fail(new Error("TTS timeout (15s)")), 15000);

      ws.onopen = () => {
        const configMsg =
          `X-Timestamp:${new Date().toString()}\r\n` +
          `Content-Type:application/json; charset=utf-8\r\n` +
          `Path:speech.config\r\n\r\n` +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: {
                    sentenceBoundaryEnabled: "false",
                    wordBoundaryEnabled: "false",
                  },
                  outputFormat: OUTPUT_FORMAT,
                },
              },
            },
          });
        ws.send(configMsg);

        const ssml =
          `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
          `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}">` +
          `<voice name="${voice}">` +
          `<prosody pitch="+0Hz" rate="${rate}" volume="${volume}">${escapeXml(input)}</prosody>` +
          `</voice></speak>`;

        // 与 msedge-tts 一致：不带多余 X-Timestamp 在 Path 前
        const ssmlMsg =
          `X-RequestId:${requestId}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `Path:ssml\r\n\r\n` +
          ssml;
        ws.send(ssmlMsg);
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          if (ev.data.includes("Path:turn.end")) {
            clearTimeout(timer);
            done();
          }
          return;
        }
        const buf = new Uint8Array(ev.data);
        // 二进制帧里可能混有 UTF-8 头
        const headLen = Math.min(buf.length, 500);
        let head = "";
        try {
          head = new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, headLen));
        } catch {}
        if (head.includes("Path:audio")) {
          // 兼容 Path:audio\r\n 与前面可能有的 2 字节长度前缀
          let idx = findBinaryHeaderEnd(buf, "Path:audio\r\n");
          if (idx < 0) idx = findBinaryHeaderEnd(buf, "Path:audio\n");
          if (idx >= 0) chunks.push(buf.subarray(idx));
        } else if (head.includes("Path:turn.end")) {
          clearTimeout(timer);
          done();
        }
      };

      ws.onerror = () => {
        clearTimeout(timer);
        fail(
          new Error(
            "Edge TTS WebSocket error（握手失败）。将尝试系统语音。若持续失败，可启动本地朗读服务 http://127.0.0.1:8765"
          )
        );
      };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        if (!settled) {
          if (chunks.length) done();
          else
            fail(
              new Error(
                `WebSocket closed code=${ev.code || "?"} reason=${ev.reason || "none"}`
              )
            );
        }
      };
    });

    if (!chunks.length) throw new Error("no audio data");
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out.buffer;
  }

  /** 本地 node 服务（可选） */
  async function synthesizeLocal(text, opts = {}) {
    const r = await fetch("http://127.0.0.1:8765/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice: opts.voice || "zh-CN-XiaoxiaoNeural",
        rate: opts.rate ?? 1,
        volume: opts.volume ?? 1,
      }),
    });
    if (!r.ok) throw new Error("local tts " + r.status);
    return await r.arrayBuffer();
  }

  /**
   * 优先 Edge 直连 → 本地 8765 → 抛错由上层用 Web Speech
   */
  async function synthesizeSmart(text, opts = {}) {
    try {
      return await synthesize(text, opts);
    } catch (e1) {
      try {
        return await synthesizeLocal(text, opts);
      } catch (e2) {
        const err = new Error(e1.message || "edge tts failed");
        err.localError = e2.message;
        err.edgeError = e1.message;
        throw err;
      }
    }
  }

  const ZH_VOICES = [
    { id: "zh-CN-XiaoxiaoNeural", name: "晓晓" },
    { id: "zh-CN-YunxiNeural", name: "云希" },
    { id: "zh-CN-YunyangNeural", name: "云扬" },
    { id: "zh-CN-XiaoyiNeural", name: "晓伊" },
    { id: "zh-CN-YunjianNeural", name: "云健" },
    { id: "zh-CN-XiaomoNeural", name: "晓墨" },
    { id: "zh-CN-YunfengNeural", name: "云枫" },
    { id: "zh-CN-YunzeNeural", name: "云泽" },
  ];

  g.AihotEdgeTTS = { synthesize, synthesizeLocal, synthesizeSmart, ZH_VOICES };
})(typeof globalThis !== "undefined" ? globalThis : self);
