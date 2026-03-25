const DEFAULTS = {
  overlayVisible: true,
  maxVisibleMessages: 10
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const patch = {};

  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (current[key] === undefined) {
      patch[key] = value;
    }
  }

  if (Object.keys(patch).length) {
    await chrome.storage.local.set(patch);
  }

  await chrome.storage.local.remove([
    'loggingEnabled',
    'folderConfigured',
    'folderName'
  ]);
});

chrome.action.onClicked.addListener(async () => {
  await chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || !message.type) {
      sendResponse({ ok: false, error: 'invalid-message' });
      return;
    }

    if (message.type === 'openOptions') {
      await chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: 'unknown-message-type' });
  })().catch((error) => {
    console.error('[GPTPulse][background]', error);
    sendResponse({ ok: false, error: String(error?.message || error) });
  });

  return true;
});
