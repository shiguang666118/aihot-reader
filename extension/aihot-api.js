/**
 * AI HOT 数据拉取 + 全文提取（扩展内直连，免本地 Node）
 */
const UPSTREAM = "https://aihot.virxact.com";
const UA = "aihot-reader-ext/1.0 (+chrome-extension; personal TTS reader)";

export function cleanText(s) {
  return String(s || "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\uFE0F\u200D]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchItems({ mode = "all", category = "", take = 40, cursor = "" } = {}) {
  const qs = new URLSearchParams({ mode, take: String(take), fields: "default" });
  if (category) qs.set("category", category);
  if (cursor) qs.set("cursor", cursor);

  const r = await fetch(`${UPSTREAM}/api/public/items?${qs}`, {
    headers: {
      Accept: "application/json",
      // 扩展里 UA 可能被浏览器覆盖，仍带上
      "X-Aihot-Client": UA,
    },
  });
  if (!r.ok) throw new Error(`items HTTP ${r.status}`);
  const data = await r.json();
  const items = (data.items || []).map((it) => ({
    id: it.id,
    title: cleanText(it.title || ""),
    summary: cleanText(it.summary || ""),
    source: cleanText(it.source || ""),
    publishedAt: it.publishedAt || null,
    category: it.category || "",
    score: typeof it.score === "number" ? it.score : null,
    selected: !!it.selected,
    url: it.url || "",
    permalink: it.permalink || `${UPSTREAM}/items/${it.id}`,
  }));
  return {
    items,
    hasNext: !!data.hasNext,
    nextCursor: data.nextCursor || null,
  };
}

function markdownToSpeechText(md) {
  let t = String(md || "");
  t = t.replace(/^Title:.*$/gim, "");
  t = t.replace(/^URL Source:.*$/gim, "");
  t = t.replace(/^Published Time:.*$/gim, "");
  t = t.replace(/^Markdown Content:\s*/im, "");
  t = t.replace(/!\[[^\]]*\]\([^)]+\)/g, "");
  t = t.replace(/\[([^\]]*)\]\([^)]+\)/g, "$1");
  t = t.replace(/\]\([^)]+\)/g, "");
  t = t.replace(/^#{1,6}\s+/gm, "");
  t = t.replace(/^>\s?/gm, "");
  t = t.replace(/^[-*+]\s+/gm, "");
  t = t.replace(/^\d+\.\s+/gm, "");
  t = t.replace(/```[\s\S]*?```/g, "");
  t = t.replace(/`([^`]+)`/g, "$1");
  t = t.replace(/<[^>]+>/g, " ");

  for (const a of ["跳到正文", "AI 摘要", "精选理由", "正文"]) {
    const i = t.indexOf(a);
    if (i >= 0) {
      t = t.slice(i);
      break;
    }
  }
  for (const end of ["同一事件", "关于作者", "阅读原文", "分享海报", "导出 Markdown", "内部员工登录", "本文根据知识共享"]) {
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
    if (line.length <= 2) continue;
    deduped.push(line);
    prev = line;
  }
  t = cleanText(deduped.join("\n"));
  t = t.replace(/跳到正文/g, "");
  t = t.replace(/正文\s*[·•]?\s*AI\s*翻译\s*中文\s*原文/gi, "正文：");
  t = t.replace(/AI\s*摘要/g, "摘要：");
  t = t.replace(/精选理由/g, "精选理由：");
  t = t.replace(/\n+/g, "。");
  t = t.replace(/。{2,}/g, "。");
  t = t.replace(/https?:\/\/\S+/g, "");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/** 拉取详情全文（优先 Jina，因直连详情页常有 bot 墙） */
export async function fetchFulltext(id) {
  if (!id || !/^[a-z0-9]+$/i.test(id)) throw new Error("invalid id");
  const permalink = `${UPSTREAM}/items/${id}`;
  const jinaUrl = `https://r.jina.ai/${permalink}`;
  const r = await fetch(jinaUrl, {
    headers: {
      Accept: "text/plain",
      "X-Return-Format": "markdown",
    },
  });
  if (!r.ok) throw new Error(`fulltext HTTP ${r.status}`);
  const md = await r.text();
  const fullText = markdownToSpeechText(md);
  if (!fullText || fullText.length < 20) throw new Error("fulltext empty");
  return { id, permalink, fullText, length: fullText.length, via: "jina" };
}
