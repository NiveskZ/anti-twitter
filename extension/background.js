const GATE_URL = browser.runtime.getURL("gate.html");
const TARGETS = [
  "*://x.com/*",
  "*://www.x.com/*",
  "*://twitter.com/*",
  "*://www.twitter.com/*"
];

console.log("[anti-twitter] background carregado");

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type !== "main_frame") return {};
    if (details.url.startsWith(GATE_URL)) return {};
    return {}; // deixa o webRequest passar, o redirecionamento é feito via tabs
  },
  { urls: TARGETS, types: ["main_frame"] },
  ["blocking"]
);

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading") return;
  const url = changeInfo.url || tab.url;
  if (!url) return;

  const isTwitter = ["x.com", "twitter.com"].some(d => url.includes(d));
  if (!isTwitter) return;
  if (url.startsWith(GATE_URL)) return;

  // Consulta o app.py para saber se está liberado
  const res = await browser.runtime.sendNativeMessage("reader_gate_host", { action: "status" });

  if (!res.ok || !res.allowed) {
    const redirectUrl = `${GATE_URL}?target=${encodeURIComponent(url)}`;
    browser.tabs.update(tabId, { url: redirectUrl });
  }
});

// Recebe mensagens da gate.js e repassa para o app.py
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  browser.runtime.sendNativeMessage("reader_gate_host", message)
    .then(sendResponse)
    .catch(err => sendResponse({ ok: false, error: String(err) }));
  return true;
});