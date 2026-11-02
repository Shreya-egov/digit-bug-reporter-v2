// Forwards events from page-hook.js (page world) to the service worker, which keeps the last few minutes per tab.
function relay(e) {
  if (e.source !== window || e.data?.__digitBugV2 !== 1) return;
  // After the extension is reloaded or updated, this copy in an already-open tab is cut off and sendMessage
  // throws "Extension context invalidated" synchronously. Stop listening; reloading the tab starts a fresh copy.
  if (!chrome.runtime?.id) {
    window.removeEventListener('message', relay);
    return;
  }
  try {
    chrome.runtime.sendMessage({ type: 'event', event: e.data.event }).catch(() => {});
  } catch {
    window.removeEventListener('message', relay);
  }
}

window.addEventListener('message', relay);

// Lets the service worker check that this copy is still connected (see ensureCapture in background.js).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'relay-ping') sendResponse(true);
});
