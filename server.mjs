/**
 * AI HOT 朗读器 — 本地服务
 * 1) 官方公开 API 拉标题/摘要
 * 2) 详情页全文（直连失败时走 Jina 正文提取）
 * 3) Microsoft Edge 神经网络 TTS（msedge-tts）合成音频
 *
 * 用法: node server.mjs
 * 浏览器: http://127.0.0.1:8765
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8765;
const UPSTREAM = "https://aihot.virxact.com";
const UA = "aihot-reader/1.2 (+local; personal TTS reader)";
const FULLTEXT_CACHE = new Map(); // id -> { at, data }
const FULLTEXT_TTL_MS = 30 * 60 * 1000;

/** 精选好听、适合新闻资讯朗读的中文神经网络音色 */
const ZH_VOICES = [
  { id: "zh-CN-XiaoxiaoNeural", name: "晓晓", gender: "女", note: "自然、通用（推荐）" },
  { id: "zh-CN-YunxiNeural", name: "云希", gender: "男", note: "沉稳、偏新闻感" },
  { id: "zh-CN-YunyangNeural", name: "云扬", gender: "男", note: "播报风格" },
  { id: "zh-CN-XiaoyiNeural", name: "晓伊", gender: "女", note: "清晰柔和" },
  { id: "zh-CN-YunjianNeural", name: "云健", gender: "男", note: "有力" },
  { id: "zh-CN-XiaochenNeural", name: "晓辰", gender: "女", note: "轻松" },
  { id: "zh-CN-XiaohanNeural", name: "晓涵", gender: "女", note: "温暖" },
  { id: "zh-CN-XiaomengNeural", name: "晓梦", gender: "女", note: "年轻" },
  { id: "zh-CN-XiaomoNeural", name: "晓墨", gender: "女", note: "知性" },
  { id: "zh-CN-XiaoqiuNeural", name: "晓秋", gender: "女", note: "成熟" },
  { id: "zh-CN-XiaoruiNeural", name: "晓睿", gender: "女", note: "干练" },
  { id: "zh-CN-XiaoshuangNeural", name: "晓双", gender: "女", note: "清亮" },
  { id: "zh-CN-XiaoxuanNeural", name: "晓萱", gender: "女", note: "柔美" },
  { id: "zh-CN-XiaoyanNeural", name: "晓颜", gender: "女", note: "平稳" },
  { id: "zh-CN-YunfengNeural", name: "云枫", gender: "男", note: "磁性" },
  { id: "zh-CN-YunhaoNeural", name: "云皓", gender: "男", note: "阳光" },
  { id: "zh-CN-YunxiaNeural", name: "云夏", gender: "男", note: "少年感" },
  { id: "zh-CN-YunyeNeural", name: "云野", gender: "男", note: "故事感" },
  { id: "zh-CN-YunzeNeural", name: "云泽", gender: "男", note: "低沉" },
  { id: "zh-CN-XiaozhenNeural", name: "晓甄", gender: "女", note: "正式" },
  { id: "zh-CN-liaoning-XiaobeiNeural", name: "晓北（辽宁）", gender: "女", note: "方言趣味" },
  { id: "zh-CN-shaanxi-XiaoniNeural", name: "晓妮（陕西）", gender: "女", note: "方言趣味" },
  { id: "zh-TW-HsiaoChenNeural", name: "曉臻（台湾）", gender: "女", note: "台湾腔" },
  { id: "zh-TW-YunJheNeural", name: "雲哲（台湾）", gender: "男", note: "台湾腔" },
  { id: "zh-HK-HiuMaanNeural", name: "曉曼（香港）", gender: "女", note: "粤语" },
  { id: "zh-HK-WanLungNeural", name: "雲龍（香港）", gender: "男", note: "粤语" },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Cache-Control": "no-store",
    ...headers,
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, "public", safe);
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    return send(res, 403, "Forbidden");
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return send(res, 404, "Not found");
  }
  const ext = path.extname(filePath);
  const data = fs.readFileSync(filePath);
  send(res, 200, data, { "Content-Type": MIME[ext] || "application/octet-stream" });
}

/** 去掉 emoji、多余空白，方便 TTS 念干净 */
function cleanText(s) {
  return String(s)
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\uFE0F\u200D]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** SSML 文本转义 */
function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function proxyItems(req, res) {
  const incoming = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const qs = new URLSearchParams();
  const allow = ["mode", "category", "since", "take", "cursor", "q", "fields"];
  for (const key of allow) {
    if (incoming.searchParams.has(key)) qs.set(key, incoming.searchParams.get(key));
  }
  if (!qs.has("mode")) qs.set("mode", "all");
  if (!qs.has("take")) qs.set("take", "40");
  if (!qs.has("fields")) qs.set("fields", "default");

  const target = `${UPSTREAM}/api/public/items?${qs.toString()}`;
  try {
    const r = await fetch(target, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    const text = await r.text();
    if (!r.ok) {
      return send(
        res,
        r.status,
        { error: `upstream ${r.status}`, body: text.slice(0, 500) },
        { "Content-Type": "application/json; charset=utf-8" }
      );
    }
    const data = JSON.parse(text);
    const items = (data.items || []).map((it) => ({
      id: it.id,
      title: cleanText(it.title || ""),
      title_en: cleanText(it.title_en || ""),
      summary: cleanText(it.summary || ""),
      source: cleanText(it.source || ""),
      publishedAt: it.publishedAt || null,
      category: it.category || "",
      score: typeof it.score === "number" ? it.score : null,
      selected: !!it.selected,
      url: it.url || "",
      permalink: it.permalink || `${UPSTREAM}/items/${it.id}`,
    }));
    send(
      res,
      200,
      {
        count: items.length,
        hasNext: !!data.hasNext,
        nextCursor: data.nextCursor || null,
        items,
      },
      { "Content-Type": "application/json; charset=utf-8" }
    );
  } catch (err) {
    send(
      res,
      502,
      { error: String(err.message || err) },
      { "Content-Type": "application/json; charset=utf-8" }
    );
  }
}

/**
 * POST /api/tts
 * body: { text, voice?, rate?, volume? }
 * returns: audio/mpeg stream
 */
async function handleTts(req, res) {
  try {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return send(res, 400, { error: "invalid json" }, { "Content-Type": "application/json; charset=utf-8" });
    }

    let text = cleanText(body.text || "");
    if (!text) {
      return send(res, 400, { error: "text required" }, { "Content-Type": "application/json; charset=utf-8" });
    }
    // Edge TTS 单次别太长；更长文由前端分段多次请求
    if (text.length > 2800) text = text.slice(0, 2800);

    const voice = String(body.voice || "zh-CN-XiaoxiaoNeural");
    const known = ZH_VOICES.some((v) => v.id === voice);
    const voiceId = known ? voice : "zh-CN-XiaoxiaoNeural";

    // rate: 前端 0.6~1.6 → 相对倍率数字
    let rate = Number(body.rate);
    if (!Number.isFinite(rate)) rate = 1;
    rate = Math.min(1.8, Math.max(0.5, rate));

    let volume = Number(body.volume);
    if (!Number.isFinite(volume)) volume = 100;
    // 前端 0~1 或 0~100
    if (volume <= 1) volume = Math.round(volume * 100);
    volume = Math.min(100, Math.max(0, volume));

    const tts = new MsEdgeTTS();
    await tts.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

    const safeText = escapeXml(text);
    const { audioStream } = tts.toStream(safeText, {
      rate,
      volume,
    });

    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "X-Voice": voiceId,
    });

    audioStream.on("data", (chunk) => {
      res.write(chunk);
    });
    audioStream.on("close", () => {
      res.end();
    });
    audioStream.on("error", (err) => {
      console.error("tts stream error", err);
      if (!res.headersSent) {
        send(res, 502, { error: String(err.message || err) }, { "Content-Type": "application/json; charset=utf-8" });
      } else {
        res.end();
      }
    });
  } catch (err) {
    console.error("tts error", err);
    if (!res.headersSent) {
      send(
        res,
        502,
        { error: String(err.message || err) },
        { "Content-Type": "application/json; charset=utf-8" }
      );
    }
  }
}

/**
 * 把 Markdown/杂讯清理成适合朗读的纯文本
 */
function markdownToSpeechText(md) {
  let t = String(md || "");
  // jina 头
  t = t.replace(/^Title:.*$/gim, "");
  t = t.replace(/^URL Source:.*$/gim, "");
  t = t.replace(/^Published Time:.*$/gim, "");
  t = t.replace(/^Markdown Content:\s*/im, "");

  // 先剥 Markdown 链接/图片，避免截断后出现 `](url)` 残片
  t = t.replace(/!\[[^\]]*\]\([^)]+\)/g, "");
  t = t.replace(/\[([^\]]*)\]\([^)]+\)/g, "$1");
  t = t.replace(/\]\([^)]+\)/g, ""); // 残留
  t = t.replace(/^#{1,6}\s+/gm, "");
  t = t.replace(/^>\s?/gm, "");
  t = t.replace(/^[-*+]\s+/gm, "");
  t = t.replace(/^\d+\.\s+/gm, "");
  t = t.replace(/```[\s\S]*?```/g, "");
  t = t.replace(/`([^`]+)`/g, "$1");
  t = t.replace(/<[^>]+>/g, " ");

  // 从正文锚点切入
  for (const a of ["跳到正文", "AI 摘要", "精选理由", "正文"]) {
    const i = t.indexOf(a);
    if (i >= 0) {
      t = t.slice(i);
      break;
    }
  }

  // 页尾裁切
  for (const end of [
    "同一事件",
    "关于作者",
    "阅读原文",
    "分享海报",
    "导出 Markdown",
    "内部员工登录",
    "本文根据知识共享",
  ]) {
    const i = t.indexOf(end);
    if (i > 120) {
      t = t.slice(0, i);
      break;
    }
  }

  const noiseLine =
    /^(返回|原文|精选|内容|主题|收藏|接入|更多|关于|更新日志|反馈|全部 AI 动态|AI 日报|跳到正文|阅读原文|中文|正文|AI 翻译|AI 摘要|精选理由)$/i;

  const lines = t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const deduped = [];
  let prev = "";
  for (const line of lines) {
    if (line === prev) continue;
    if (/^Image\s+\d+/i.test(line)) continue;
    if (noiseLine.test(line)) continue;
    if (/^·\s*\d+/.test(line)) continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(line) && line.length < 48) continue;
    if (line.length <= 2) continue;
    // 纯标签粘连行
    if (/^(智能体|模型发布|语音|行业动态|产品更新|编码|端侧|政策\/监管|现象\/趋势|部署\/工程){1,6}$/.test(line))
      continue;
    deduped.push(line);
    prev = line;
  }
  t = deduped.join("\n");
  t = cleanText(t);

  // UI 粘连串
  t = t.replace(
    /内容\s*精选\s*全部\s*AI\s*动态\s*AI\s*日报\s*主题\s*收藏\s*接入\s*Agent\s*接入\s*更多\s*关于\s*更新日志\s*反馈\s*内部员工登录/gi,
    ""
  );
  t = t.replace(/跳到正文/g, "");
  t = t.replace(/正文\s*[·•]?\s*AI\s*翻译\s*中文\s*原文/gi, "正文：");
  t = t.replace(/AI\s*摘要/g, "摘要：");
  t = t.replace(/精选理由/g, "精选理由：");
  t = t.replace(/返回\s*原文/g, "");
  t = t.replace(/阅读原文/g, "");
  t = t.replace(/分享海报/g, "");

  t = t.replace(/\n+/g, "。");
  t = t.replace(/。{2,}/g, "。");
  t = t.replace(/\s+/g, " ").trim();
  // 去掉残留 URL
  t = t.replace(/https?:\/\/\S+/g, "");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/**
 * 从 AI HOT 详情页 HTML 抽正文（成功时优先，无 bot 墙）
 */
function extractFromAihotHtml(html) {
  if (!html || html.includes("__tst_status") || html.includes("EO_Bot")) return null;
  // AI 摘要
  let summary = "";
  const sumMatch =
    html.match(/AI\s*摘要[\s\S]{0,40}?<p[^>]*>([\s\S]*?)<\/p>/i) ||
    html.match(/class="[^"]*summary[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/i);
  if (sumMatch) summary = cleanText(sumMatch[1].replace(/<[^>]+>/g, " "));

  // 原文区块：从「原文」到推荐/标签结束
  let full = "";
  const origIdx = html.search(/>\s*原文\s*</);
  if (origIdx >= 0) {
    let chunk = html.slice(origIdx, origIdx + 80000);
    // 截到后续导航块
    const cut = chunk.search(/同一事件|推荐理由|阅读原文|导出 Markdown|timeline-tags|footer/i);
    if (cut > 200) chunk = chunk.slice(0, cut);
    full = cleanText(
      chunk
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/原文/i, "")
    );
  }

  // article-body
  if (!full) {
    const bodyMatch = html.match(/id=["']article-body["'][^>]*>([\s\S]*?)<\/(?:section|div|article)>/i);
    if (bodyMatch) {
      full = cleanText(bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " "));
    }
  }

  if (!full || full.length < 40) return null;
  return { summary, fullText: full, via: "aihot-html" };
}

async function fetchFulltext(id) {
  if (!id || !/^[a-z0-9]+$/i.test(id)) {
    throw new Error("invalid id");
  }
  const cached = FULLTEXT_CACHE.get(id);
  if (cached && Date.now() - cached.at < FULLTEXT_TTL_MS) {
    return { ...cached.data, cached: true };
  }

  const permalink = `${UPSTREAM}/items/${id}`;

  // 1) 直连详情页
  try {
    const r = await fetch(permalink, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
      },
    });
    const html = await r.text();
    const extracted = extractFromAihotHtml(html);
    if (extracted && extracted.fullText) {
      const data = {
        id,
        permalink,
        fullText: extracted.fullText,
        summary: extracted.summary || "",
        via: extracted.via,
        length: extracted.fullText.length,
      };
      FULLTEXT_CACHE.set(id, { at: Date.now(), data });
      return { ...data, cached: false };
    }
  } catch (e) {
    console.warn("direct fulltext fail", e.message);
  }

  // 2) Jina 正文提取（详情页有 bot 墙时）
  const jinaUrl = `https://r.jina.ai/${permalink}`;
  const jr = await fetch(jinaUrl, {
    headers: {
      "User-Agent": UA,
      Accept: "text/plain",
      "X-Return-Format": "markdown",
    },
  });
  if (!jr.ok) {
    throw new Error(`fulltext upstream ${jr.status}`);
  }
  const md = await jr.text();
  const fullText = markdownToSpeechText(md);
  if (!fullText || fullText.length < 20) {
    throw new Error("fulltext empty");
  }
  const data = {
    id,
    permalink,
    fullText,
    summary: "",
    via: "jina",
    length: fullText.length,
  };
  FULLTEXT_CACHE.set(id, { at: Date.now(), data });
  return { ...data, cached: false };
}

async function handleFulltext(req, res) {
  try {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const id = u.searchParams.get("id") || "";
    const data = await fetchFulltext(id);
    send(res, 200, data, { "Content-Type": "application/json; charset=utf-8" });
  } catch (err) {
    send(
      res,
      502,
      { error: String(err.message || err) },
      { "Content-Type": "application/json; charset=utf-8" }
    );
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return send(res, 204, "", {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
  }

  if (req.url.startsWith("/api/items")) {
    return proxyItems(req, res);
  }
  if (req.url.startsWith("/api/fulltext")) {
    return handleFulltext(req, res);
  }
  if (req.url === "/api/voices" && req.method === "GET") {
    return send(res, 200, { voices: ZH_VOICES, default: "zh-CN-XiaoxiaoNeural" }, {
      "Content-Type": "application/json; charset=utf-8",
    });
  }
  if (req.url === "/api/tts" && req.method === "POST") {
    return handleTts(req, res);
  }
  if (req.url === "/api/health") {
    return send(res, 200, { ok: true, tts: "msedge-tts", fulltext: true }, {
      "Content-Type": "application/json; charset=utf-8",
    });
  }
  return serveStatic(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`AI HOT 朗读器已启动: http://127.0.0.1:${PORT}`);
  console.log(`TTS: Microsoft Edge 神经网络语音（默认 晓晓）`);
  console.log(`全文: 详情页 / Jina 提取`);
  console.log(`数据源: ${UPSTREAM}/api/public/items`);
  console.log(`按 Ctrl+C 退出`);
});
