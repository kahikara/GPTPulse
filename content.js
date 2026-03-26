const ROOT_ID = 'gptpulse-root';
const ARCHIVE_BLOCK_ID = 'gptpulse-archive-block';
const DB_NAME = 'gptpulse-archive';
const DB_VERSION = 1;
const META_STORE = 'chatMeta';
const MESSAGE_STORE = 'chatMessages';
const LIVE_DOM_CAP = 12;

const DEFAULTS = {
  overlayVisible: true,
  maxVisibleMessages: 10
};

let settings = { ...DEFAULTS };
let root = null;
let observer = null;
let updateTimer = null;
let suppressObserver = false;
let pendingRevealTimer = null;
let latestRunToken = 0;
let currentState = makeChatState(getChatId());
let dbPromise = null;

bootstrap().catch((error) => {
  console.error('[GPTPulse][content] bootstrap failed', error);
  markTrimReady();
});

async function bootstrap() {
  patchHistory();
  markTrimPending();

  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  settings = { ...DEFAULTS, ...stored };

  ensureRoot();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue;
    }

    scheduleUpdate(0);
  });

  observer = new MutationObserver(() => {
    if (suppressObserver) return;
    scheduleUpdate(0);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });

  window.addEventListener('gptpulse:navigation', handleNavigation, true);
  window.addEventListener('popstate', handleNavigation, true);
  window.addEventListener('hashchange', handleNavigation, true);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleUpdate(0);
  });

  renderOverlay({
    totalCount: 0,
    shownCount: 0,
    hiddenCount: 0,
    totalChars: 0
  });

  scheduleUpdate(0);
}

function patchHistory() {
  if (window.__gptpulseHistoryPatched) return;
  window.__gptpulseHistoryPatched = true;

  for (const name of ['pushState', 'replaceState']) {
    const original = history[name];
    if (typeof original !== 'function') continue;

    history[name] = function (...args) {
      const result = original.apply(this, args);
      window.dispatchEvent(new Event('gptpulse:navigation'));
      return result;
    };
  }
}

function handleNavigation() {
  currentState = makeChatState(getChatId());
  removeArchiveBlock();
  markTrimPending();
  scheduleUpdate(0);
}

function makeChatState(chatId) {
  return {
    chatId,
    prepPromise: clearChatArchive(chatId)
  };
}

function ensureCurrentState() {
  const chatId = getChatId();
  if (!currentState || currentState.chatId !== chatId) {
    currentState = makeChatState(chatId);
  }
  return currentState;
}

function ensureRoot() {
  let existing = document.getElementById(ROOT_ID);
  if (existing) {
    root = existing;
    return;
  }

  root = document.createElement('div');
  root.id = ROOT_ID;
  document.documentElement.appendChild(root);
}

function markTrimPending() {
  document.documentElement.classList.add('gptpulse-trim-pending');

  clearTimeout(pendingRevealTimer);
  pendingRevealTimer = setTimeout(() => {
    markTrimReady();
  }, 2500);
}

function markTrimReady() {
  clearTimeout(pendingRevealTimer);
  document.documentElement.classList.remove('gptpulse-trim-pending');
}

function scheduleUpdate(delay = 80) {
  clearTimeout(updateTimer);
  const token = ++latestRunToken;
  updateTimer = setTimeout(() => {
    void runUpdate(token);
  }, delay);
}

async function runUpdate(token) {
  ensureRoot();
  const state = ensureCurrentState();

  try {
    await state.prepPromise;
  } catch (error) {
    console.warn('[GPTPulse] archive clear failed', error);
  }

  if (token !== latestRunToken) return;

  if (settings.overlayVisible) {
    root.style.display = '';
  } else {
    root.style.display = 'none';
  }

  const visibleTarget = clampInt(settings.maxVisibleMessages, 1, 200, 10);
  const liveTarget = Math.min(visibleTarget, LIVE_DOM_CAP);

  let realMessages = collectRealMessages();

  if (realMessages.length > liveTarget) {
    markTrimPending();
    const overflow = realMessages.slice(0, realMessages.length - liveTarget);
    await archiveAndRemoveMessages(state.chatId, overflow);
    if (token !== latestRunToken) return;
    realMessages = collectRealMessages();
  }

  const meta = await getChatMeta(state.chatId);
  if (token !== latestRunToken) return;

  const archiveVisibleTarget = Math.max(0, visibleTarget - realMessages.length);
  const archiveVisibleEntries = archiveVisibleTarget > 0
    ? await getTailArchivedMessages(state.chatId, archiveVisibleTarget)
    : [];

  if (token !== latestRunToken) return;

  renderArchiveBlock(archiveVisibleEntries, meta.count);
  renderOverlay({
    totalCount: realMessages.length + meta.count,
    shownCount: realMessages.length + archiveVisibleEntries.length,
    hiddenCount: Math.max(0, meta.count - archiveVisibleEntries.length),
    totalChars: sumChars(realMessages) + (meta.totalChars || 0)
  });

  markTrimReady();
}

async function archiveAndRemoveMessages(chatId, messages) {
  if (!messages.length) return;

  const snapshots = messages.map((message) => ({
    role: message.role,
    text: message.text,
    charCount: message.charCount
  }));

  await appendArchivedMessages(chatId, snapshots);

  withDomChanges(() => {
    for (const message of messages) {
      message.node.remove();
    }
  });
}

function renderOverlay({ totalCount, shownCount, hiddenCount, totalChars }) {
  const sliderValue = clampInt(settings.maxVisibleMessages, 1, 200, 10);

  root.innerHTML = `
    <div class="gptpulse-card">
      <div class="gptpulse-head">
        <div class="gptpulse-title">GPTPulse</div>
      </div>
      <div class="gptpulse-body">
        <div class="gptpulse-row">
          <span class="gptpulse-label">Showing</span>
          <span class="gptpulse-value">${formatNumber(shownCount)} / ${formatNumber(totalCount)}</span>
        </div>
        <div class="gptpulse-row">
          <span class="gptpulse-label">Hidden</span>
          <span class="gptpulse-value">${formatNumber(hiddenCount)}</span>
        </div>
        <div class="gptpulse-row">
          <span class="gptpulse-label">Chars</span>
          <span class="gptpulse-value">${formatCompact(totalChars)}</span>
        </div>
        <div class="gptpulse-slider-wrap">
          <div class="gptpulse-slider-head">
            <span class="gptpulse-label">Visible messages</span>
            <span class="gptpulse-value" id="gptpulse-slider-value">${formatNumber(sliderValue)}</span>
          </div>
          <input class="gptpulse-slider" id="gptpulse-slider" type="range" min="1" max="200" step="1" value="${sliderValue}">
        </div>
      </div>
    </div>
  `;

  const slider = root.querySelector('#gptpulse-slider');
  const sliderValueEl = root.querySelector('#gptpulse-slider-value');

  slider?.addEventListener('input', () => {
    if (sliderValueEl) {
      sliderValueEl.textContent = formatNumber(slider.value);
    }
  });

  slider?.addEventListener('change', async () => {
    const next = clampInt(slider.value, 1, 200, 10);
    await chrome.storage.local.set({ maxVisibleMessages: next });
  });
}

function renderArchiveBlock(entries, totalArchivedCount) {
  removeArchiveBlock();

  if (!entries.length) return;

  const firstReal = collectRealMessages()[0]?.node || null;
  const parent = firstReal?.parentNode || findThreadParent();
  if (!parent) return;

  const block = document.createElement('div');
  block.id = ARCHIVE_BLOCK_ID;
  block.setAttribute('data-gptpulse-archive-block', '1');

  const hiddenCount = Math.max(0, totalArchivedCount - entries.length);

  block.innerHTML = `
    <div class="gptpulse-archive-summary">
      <span><strong>${formatNumber(entries.length)}</strong> archived messages rendered in lightweight mode</span>
      <span>${formatNumber(hiddenCount)} still collapsed</span>
    </div>
    <div class="gptpulse-archive-list">
      ${entries.map(renderArchiveItem).join('')}
    </div>
  `;

  withDomChanges(() => {
    parent.insertBefore(block, firstReal);
  });
}

function renderArchiveItem(entry) {
  return `
    <div class="gptpulse-archive-item">
      <div class="gptpulse-archive-role">${escapeHtml(formatRole(entry.role))}</div>
      <div class="gptpulse-archive-text">${escapeHtml(entry.text)}</div>
    </div>
  `;
}

function formatRole(role) {
  if (role === 'user') return 'You';
  if (role === 'assistant') return 'Assistant';
  if (role === 'system') return 'System';
  return role || 'Message';
}

function removeArchiveBlock() {
  const existing = document.getElementById(ARCHIVE_BLOCK_ID);
  if (existing) {
    withDomChanges(() => {
      existing.remove();
    });
  }
}

function collectRealMessages() {
  const candidates = Array.from(document.querySelectorAll('main [data-message-author-role], [data-message-author-role]'));
  const seenContainers = new Set();
  const messages = [];

  for (const node of candidates) {
    if (!(node instanceof HTMLElement)) continue;
    if (root && (node === root || root.contains(node))) continue;
    if (node.closest('[data-gptpulse-archive-block="1"]')) continue;

    const container = node.closest('article') || node;
    if (!(container instanceof HTMLElement)) continue;
    if (!container.isConnected) continue;
    if (root && (container === root || root.contains(container))) continue;
    if (container.closest('[data-gptpulse-archive-block="1"]')) continue;
    if (seenContainers.has(container)) continue;

    const text = normalizeText(container.innerText || container.textContent || '');
    if (!text) continue;

    seenContainers.add(container);

    messages.push({
      node: container,
      role: extractRole(container),
      text,
      charCount: text.length
    });
  }

  return messages;
}

function extractRole(container) {
  const roleNode = container.querySelector('[data-message-author-role]');
  return roleNode?.getAttribute('data-message-author-role') || 'message';
}

function findThreadParent() {
  const firstReal = collectRealMessages()[0]?.node;
  if (firstReal?.parentNode) return firstReal.parentNode;

  const main = document.querySelector('main');
  return main || null;
}

function withDomChanges(fn) {
  suppressObserver = true;
  try {
    fn();
  } finally {
    requestAnimationFrame(() => {
      suppressObserver = false;
    });
  }
}

function normalizeText(text) {
  return String(text)
    .replace(/\u00A0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function getChatId() {
  const match = location.pathname.match(/\/c\/([^/?#]+)/);
  if (match?.[1]) return match[1];
  return location.pathname || 'temporary-chat';
}

function sumChars(items) {
  return items.reduce((sum, item) => sum + (item.charCount || 0), 0);
}

function formatCompact(num) {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(num);
}

function formatNumber(num) {
  return new Intl.NumberFormat().format(Number(num) || 0);
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function escapeHtml(input) {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'chatId' });
      }

      if (!db.objectStoreNames.contains(MESSAGE_STORE)) {
        db.createObjectStore(MESSAGE_STORE, { keyPath: ['chatId', 'seq'] });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

async function clearChatArchive(chatId) {
  const db = await openDb();

  await new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, MESSAGE_STORE], 'readwrite');
    const metaStore = tx.objectStore(META_STORE);
    const messageStore = tx.objectStore(MESSAGE_STORE);

    metaStore.delete(chatId);

    const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
    const cursorRequest = messageStore.openCursor(range);

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };

    cursorRequest.onerror = () => reject(cursorRequest.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function getChatMeta(chatId) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const store = tx.objectStore(META_STORE);
    const request = store.get(chatId);

    request.onsuccess = () => {
      resolve(request.result || {
        chatId,
        count: 0,
        totalChars: 0,
        lastSeq: 0
      });
    };

    request.onerror = () => reject(request.error);
  });
}

async function appendArchivedMessages(chatId, snapshots) {
  if (!snapshots.length) return;

  const db = await openDb();

  await new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, MESSAGE_STORE], 'readwrite');
    const metaStore = tx.objectStore(META_STORE);
    const messageStore = tx.objectStore(MESSAGE_STORE);
    const metaRequest = metaStore.get(chatId);

    metaRequest.onsuccess = () => {
      const meta = metaRequest.result || {
        chatId,
        count: 0,
        totalChars: 0,
        lastSeq: 0
      };

      for (const snapshot of snapshots) {
        meta.lastSeq += 1;
        meta.count += 1;
        meta.totalChars += snapshot.charCount || 0;

        messageStore.put({
          chatId,
          seq: meta.lastSeq,
          role: snapshot.role,
          text: snapshot.text,
          charCount: snapshot.charCount || 0
        });
      }

      metaStore.put(meta);
    };

    metaRequest.onerror = () => reject(metaRequest.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function getTailArchivedMessages(chatId, limit) {
  if (limit <= 0) return [];

  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(MESSAGE_STORE, 'readonly');
    const store = tx.objectStore(MESSAGE_STORE);
    const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
    const request = store.openCursor(range, 'prev');
    const result = [];

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || result.length >= limit) {
        result.reverse();
        resolve(result);
        return;
      }

      result.push(cursor.value);
      cursor.continue();
    };

    request.onerror = () => reject(request.error);
  });
}
