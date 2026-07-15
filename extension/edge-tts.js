/**
 * 浏览器端 Microsoft Edge 神经网络 TTS（WebSocket）
 * 协议对齐 msedge-tts / Edge Read Aloud
 */
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WSS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

function uuid() {
  return "xxxxxxxx-xxxx-xxxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function secMsGec() {
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
 * @param {string} text
 * @param {{ voice?: string, rate?: number, volume?: number }} [opts]
 * @returns {Promise<Blob>} audio/mpeg
 */
export async function synthesize(text, opts = {}) {
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

  const requestId = uuid().replace(/-/g, "");
  const sec = await secMsGec();
  const connId = uuid().replace(/-/g, "");
  const url =
    `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${sec}&Sec-MS-GEC-Version=1-143.0.3650.96&ConnectionId=${connId}`;

  const langMatch = voice.match(/[a-z]{2}-[A-Z]{2}/);
  const lang = langMatch ? langMatch[0] : "zh-CN";

  const chunks = [];

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
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

    const timer = setTimeout(() => fail(new Error("TTS timeout")), 60000);

    ws.onopen = () => {
      const config =
        `X-Timestamp:${new Date().toString()}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: {
                  sentenceBoundaryEnabled: false,
                  wordBoundaryEnabled: false,
                },
                outputFormat: OUTPUT_FORMAT,
              },
            },
          },
        });
      ws.send(config);

      const ssml =
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
        `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}">` +
        `<voice name="${voice}">` +
        `<prosody rate="${rate}" volume="${volume}">${escapeXml(input)}</prosody>` +
        `</voice></speak>`;

      const ssmlMsg =
        `X-RequestId:${requestId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${new Date().toString()}\r\n` +
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
      // 文本头 + 音频：找 Path:audio
      const asText = new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, Math.min(buf.length, 400)));
      if (asText.includes("Path:audio")) {
        const idx = findBinaryHeaderEnd(buf, "Path:audio\r\n");
        if (idx >= 0) chunks.push(buf.subarray(idx));
      } else if (asText.includes("Path:turn.end")) {
        clearTimeout(timer);
        done();
      }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      fail(new Error("Edge TTS WebSocket error"));
    };

    ws.onclose = () => {
      clearTimeout(timer);
      if (!settled) {
        if (chunks.length) done();
        else fail(new Error("WebSocket closed before audio"));
      }
    };
  });

  if (!chunks.length) throw new Error("no audio data");
  // 合并 Uint8Array
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return new Blob([out], { type: "audio/mpeg" });
}

export const ZH_VOICES = [
  { id: "zh-CN-XiaoxiaoNeural", name: "晓晓", gender: "女", note: "自然、通用（推荐）" },
  { id: "zh-CN-YunxiNeural", name: "云希", gender: "男", note: "沉稳、偏新闻感" },
  { id: "zh-CN-YunyangNeural", name: "云扬", gender: "男", note: "播报风格" },
  { id: "zh-CN-XiaoyiNeural", name: "晓伊", gender: "女", note: "清晰柔和" },
  { id: "zh-CN-YunjianNeural", name: "云健", gender: "男", note: "有力" },
  { id: "zh-CN-XiaochenNeural", name: "晓辰", gender: "女", note: "轻松" },
  { id: "zh-CN-XiaohanNeural", name: "晓涵", gender: "女", note: "温暖" },
  { id: "zh-CN-XiaomoNeural", name: "晓墨", gender: "女", note: "知性" },
  { id: "zh-CN-XiaoqiuNeural", name: "晓秋", gender: "女", note: "成熟" },
  { id: "zh-CN-YunfengNeural", name: "云枫", gender: "男", note: "磁性" },
  { id: "zh-CN-YunhaoNeural", name: "云皓", gender: "男", note: "阳光" },
  { id: "zh-CN-YunzeNeural", name: "云泽", gender: "男", note: "低沉" },
  { id: "zh-TW-HsiaoChenNeural", name: "曉臻（台湾）", gender: "女", note: "台湾腔" },
  { id: "zh-HK-HiuMaanNeural", name: "曉曼（香港）", gender: "女", note: "粤语" },
];
