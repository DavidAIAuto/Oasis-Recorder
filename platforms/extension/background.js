// Clicking the toolbar icon opens (or focuses) the recorder tab.
const APP_URL = chrome.runtime.getURL('index.html');

async function openRecorder() {
  const [existing] = await chrome.tabs.query({ url: APP_URL });
  if (existing && existing.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: APP_URL });
  }
}

chrome.action.onClicked.addListener(() => void openRecorder());
chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') void openRecorder();
});
