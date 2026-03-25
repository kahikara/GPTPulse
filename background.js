const DB_NAME = 'gptpulse-db';
const STORE_NAME = 'kv';
const DIR_HANDLE_KEY = 'logDirHandle';

const DEFAULTS = {
  overlayVisible: true,
  loggingEnabled: false,
  maxVisibleMessages: 10,
  folderConfigured: false,
  folderName: ''
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const patch = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (current[key] === undefined) patch[key] = value;
  }
  if (Object.keys(patch).length) {
    await chrome.storage.local.set(patch);
  }
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

    if (message.type === 'storeDirectoryHandle') {
      const result = await storeDirectoryHandle(message);
      sendResponse(result);
      return;
    }

    if (message.type === 'appendLogs') {
      const result = await appendLogs(message.payload || {});
      sendResponse(result);
      return;
    }

    sendResponse({ ok: false, error: 'unknown-message-type' });
  })().catch((error) => {
    console.error('[GPTPulse][background]', error);
    sendResponse({ ok: false, error: String(error?.message || error) });
  });

  return true;
});

async function storeDirectoryHandle(message) {
  const handle = message?.handle;
  if (!handle) {
    return { ok: false, error: 'missing-handle' };
  }

  await idbSet(DIR_HANDLE_KEY, handle);

  const folderName =
    message?.folderName ||
    handle?.name ||
    'selected-folder';

  await chrome.storage.local.set({
    folderConfigured: true,
    folderName
  });

  return { ok: true, folderName };
}

async function appendLogs(payload) {
  const {
    chatId = 'unknown-chat',
    chatTitle = '',
    url = '',
    entries = []
  } = payload;

  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: true, written: 0, skipped: 0 };
  }

  const settings = await chrome.storage.local.get([
    'loggingEnabled',
    'folderConfigured'
  ]);

  if (!settings.loggingEnabled) {
    return { ok: false, error: 'logging-disabled' };
  }

  if (!settings.folderConfigured) {
    return { ok: false, error: 'folder-not-configured' };
  }

  const dirHandle = await idbGet(DIR_HANDLE_KEY);
  if (!dirHandle) {
    await chrome.storage.local.set({ folderConfigured: false, folderName: '' });
    return { ok: false, error: 'missing-directory-handle' };
  }

  const perm = await queryReadWritePermission(dirHandle);
  if (perm !== 'granted') {
    return { ok: false, error: 'folder-permission-not-granted' };
  }

  const indexKey = makeIndexKey(chatId);
  const stored = await chrome.storage.local.get(indexKey);
  const existingIndex = Array.isArray(stored[indexKey]) ? stored[indexKey] : [];
  const seen = new Set(existingIndex);

  const fresh = [];
  for (const entry of entries) {
    if (!entry || !entry.signature) continue;
    if (seen.has(entry.signature)) continue;
    fresh.push(entry);
    seen.add(entry.signature);
  }

  if (fresh.length === 0) {
    return { ok: true, written: 0, skipped: entries.length };
  }

  const rootDir = await dirHandle.getDirectoryHandle('GPTPulse', { create: true });

  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');

  const yearDir = await rootDir.getDirectoryHandle(year, { create: true });
  const monthDir = await yearDir.getDirectoryHandle(month, { create: true });

  const safeChatId = sanitizeFileName(chatId || 'unknown-chat');
  const fileHandle = await monthDir.getFileHandle(`${safeChatId}.jsonl`, { create: true });

  const file = await fileHandle.getFile();
  const writable = await fileHandle.createWritable({ keepExistingData: true });
  await writable.seek(file.size);

  const lines = fresh.map((entry) => JSON.stringify({
    loggedAt: new Date().toISOString(),
    chatId,
    chatTitle,
    url,
    role: entry.role,
    text: entry.text,
    charCount: entry.charCount,
    signature: entry.signature,
    capturedAt: entry.capturedAt
  })).join('\n') + '\n';

  await writable.write(lines);
  await writable.close();

  const trimmed = Array.from(seen).slice(-15000);
  await chrome.storage.local.set({ [indexKey]: trimmed });

  return {
    ok: true,
    written: fresh.length,
    skipped: entries.length - fresh.length
  };
}

function makeIndexKey(chatId) {
  return `loggedIndex:${chatId}`;
}

function sanitizeFileName(input) {
  return String(input)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 180);
}

async function queryReadWritePermission(handle) {
  const options = { mode: 'readwrite' };

  try {
    if (await handle.queryPermission(options) === 'granted') {
      return 'granted';
    }
  } catch (error) {
    console.warn('[GPTPulse] queryPermission failed', error);
  }

  try {
    return await handle.requestPermission(options);
  } catch (error) {
    console.warn('[GPTPulse] requestPermission failed', error);
    return 'denied';
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(value, key);

    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
