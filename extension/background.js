/**
 * TTS 在 service worker 合成
 * declarativeNetRequest 规则会把 speech.platform.bing.com 的 Origin 改成微软 Read Aloud 扩展 ID
 */
importScripts("edge-tts-classic.js");

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  const url = tab.url || "";
  if (/^https:\/\/aihot\.virxact\.com\//.test(url)) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "aihot-show-bar" });
    } catch {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content.js"],
        });
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["content.css"],
        });
        await chrome.tabs.sendMessage(tab.id, { type: "aihot-show-bar" });
      } catch (e) {
        console.warn(e);
        if (chrome.sidePanel?.open) await chrome.sidePanel.open({ tabId: tab.id });
      }
    }
  } else if (chrome.sidePanel?.open) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "aihot-tts") {
    (async () => {
      try {
        const buf = await self.AihotEdgeTTS.synthesizeSmart(msg.text || "", {
          voice: msg.voice,
          rate: msg.rate,
          volume: msg.volume,
        });
        sendResponse({
          ok: true,
          engine: "edge-or-local",
          audio: Array.from(new Uint8Array(buf)),
        });
      } catch (e) {
        sendResponse({
          ok: false,
          error: String(e.message || e),
          edgeError: e.edgeError,
          localError: e.localError,
          useWebSpeech: true,
        });
      }
    })();
    return true;
  }
  return false;
});
