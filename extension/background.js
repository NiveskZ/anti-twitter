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
    const redirectUrl = `${GATE_URL}?target=${encodeURIComponent(details.url)}`;
    return { redirectUrl };
  },
  { urls: TARGETS, types: ["main_frame"] },
  ["blocking"]
);