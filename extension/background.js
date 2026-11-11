import { serviceOrigin } from "./config.js";
import { createController } from "./controller.js";

const controller = createController(chrome, serviceOrigin);
const ready = chrome.storage.session.setAccessLevel({
  accessLevel: "TRUSTED_CONTEXTS",
});
chrome.runtime.onInstalled.addListener(() => {
  void chrome.contextMenus.removeAll().then(() => {
    for (const [id, title, contexts] of [
      ["drop-page", "Save page to Drop It", ["page"]],
      ["drop-selection", "Save selected text to Drop It", ["selection"]],
      ["drop-link", "Save link to Drop It", ["link"]],
    ])
      chrome.contextMenus.create({
        id,
        title,
        contexts,
        documentUrlPatterns: ["https://*/*", "http://*/*"],
        ...(id === "drop-link"
          ? { targetUrlPatterns: ["https://*/*", "http://*/*"] }
          : {}),
      });
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  void ready
    .then(() => controller.context(info, tab))
    .catch(async () => {
      await chrome.storage.session.set({
        connectionNotice:
          "This capture could not open. Use a web page or a selection of up to 50,000 characters.",
      });
      await chrome.windows.create({
        url: chrome.runtime.getURL("popup.html?notice=1"),
        type: "popup",
        width: 440,
        height: 600,
      });
    });
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // No content scripts or external web pages can operate this message bridge.
  if (
    sender.id !== chrome.runtime.id ||
    sender.url?.split("?")[0] !== chrome.runtime.getURL("popup.html")
  )
    return false;
  void ready
    .then(() => controller.handle(message))
    .then(
      (data) => sendResponse({ ok: true, data }),
      (error) =>
        sendResponse({
          ok: false,
          error: error.message || "The request could not finish.",
          code: error.code || "",
          items: error.items || [],
        }),
    );
  return true;
});
