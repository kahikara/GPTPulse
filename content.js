const ROOT_ID = 'gptpulse-root';
const DB_NAME = 'gptpulse-snapshots';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';

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
let dbPromise = null;
let currentState = makeChatState(getChatId());

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
  renderOverlay({
    totalCount: 0,
    visibleCount: 0,
    hiddenCount: 0,
    totalChars: 0
  });

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

  scheduleUpdate(0);
}

function makeChatState(chatId) {
  return {
    chatId,
    nextSeq: 1,
    prepPromise: clearChatSnapshots(chatId)
  };
}

function ensureCurrentState() {
  const chatId = getChatId();
  if (!currentState || currentState.chatId !== chatId) {
    currentState = makeChatState(chatId);
  }
  return currentState;
}

function handleNavigation() {
  currentState = makeChatState(getChatId());
  markTrimPending();
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
  const state = ensureCurrentState();

  try {
    await state.prepPromise;
  } catch (error) {
    console.warn('[GPTPulse] clear snapshots failed', error);
  }

  if (token !== latestRunToken) return;

  ensureRoot();
  root.style.display = settings.overlayVisible ? '' : 'none';

  let messages = collectMessages(state);
  const targetVisible = clampInt(settings.maxVisibleMessages, 1, 200, 10);
  const cutoff = Math.max(0, messages.length - targetVisible);

  for (let i = 0; i < messages.length; i++) {
    if (token !== latestRunToken) return;

    const message = messages[i];

    if (i < cutoff) {
      if (!message.isHiddenByPulse) {
        await hideMessage(state.chatId, message);
      }
    } else {
      if (message.isHiddenByPulse) {
        await restoreMessage(state.chatId, message);
      }
    }
  }

  if (token !== latestRunToken) return;

  messages = collectMessages(state);

  renderOverlay({
    totalCount: messages.length,
    visibleCount: messages.filter((m) => !m.isHiddenByPulse).length,
    hiddenCount: messages.filter((m) => m.isHiddenByPulse).length,
    totalChars: sumChars(messages)
  });

  markTrimReady();
}

function collectMessages(state) {
  const candidates = Array.from(document.querySelectorAll('main [data-message-author-role], [data-message-author-role]'));
  const seenContainers = new Set();
  const messages = [];

  for (const node of candidates) {
    if (!(node instanceof HTMLElement)) continue;
    if (root && (node === root || root.contains(node))) continue;

    const container = node.closest('article') || node;
    if (!(container instanceof HTMLElement)) continue;
    if (!container.isConnected) continue;
    if (root && (container === root || root.contains(container))) continue;
    if (seenContainers.has(container)) continue;

    seenContainers.add(container);

    if (!container.dataset.gptpulseSeq) {
      container.dataset.gptpulseSeq = String(state.nextSeq++);
    } else {
      const seqNum = Number(container.dataset.gptpulseSeq);
      if (Number.isFinite(seqNum) && seqNum >= state.nextSeq) {
        state.nextSeq = seqNum + 1;
      }
    }

    const isHiddenByPulse = container.dataset.gptpulseHidden === '1';
    const text = isHiddenByPulse
      ? (container.dataset.gptpulseCharCount ? 'x'.repeat(Number(container.dataset.gptpulseCharCount)) : '')
      : normalizeText(container.innerText || container.textContent || '');

    if (!isHiddenByPulse && !text) continue;

    messages.push({
      node: container,
      seq: Number(container.dataset.gptpulseSeq),
      charCount: isHiddenByPulse
        ? Number(container.dataset.gptpulseCharCount || 0)
        : text.length,
      isHiddenByPulse
    });
  }

  messages.sort((a, b) => a.seq - b.seq);
  return messages;
}

async function hideMessage(chatId, message) {
  await putSnapshot(chatId, message.seq, {
    html: message.node.innerHTML
  });

  withDomChanges(() => {
    message.node.dataset.gptpulseHidden = '1';
    message.node.dataset.gptpulseCharCount = String(message.charCount);
    message.node.dataset.gptpulsePrevDisplay = message.node.style.display || '';
    message.node.innerHTML = '<div class="gptpulse-hidden-stub" aria-hidden="true"></div>';
    message.node.style.display = 'none';
  });
}

async function restoreMessage(chatId, message) {
  const snapshot = await getSnapshot(chatId, message.seq);
  if (!snapshot?.html) return;

  withDomChanges(() => {
    message.node.innerHTML = snapshot.html;

    const prevDisplay = message.node.dataset.gptpulsePrevDisplay || '';
    if (prevDisplay) {
      message.node.style.display = prevDisplay;
    } else {
      message.node.style.removeProperty('display');
    }

    delete message.node.dataset.gptpulseHidden;
    delete message.node.dataset.gptpulseCharCount;
    delete message.node.dataset.gptpulsePrevDisplay;
  });
}

function renderOverlay({ totalCount, visibleCount, hiddenCount, totalChars }) {
  const sliderValue = clampInt(settings.maxVisibleMessages, 1, 200, 10);

  root.innerHTML = `
    <div class="gptpulse-card">
      <div class="gptpulse-head">
        <div class="gptpulse-title">GPTPulse</div>
      </div>
      <div class="gptpulse-body">
        <div class="gptpulse-row">
          <span class="gptpulse-label">Total</span>
          <span class="gptpulse-value">${formatNumber(totalCount)}</span>
        </div>
        <div class="gptpulse-row">
          <span class="gptpulse-label">Visible</span>
          <span class="gptpulse-value">${formatNumber(visibleCount)}</span>
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

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: ['chatId', 'seq'] });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

async function clearChatSnapshots(chatId) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
    const request = store.openCursor(range);

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };

    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function putSnapshot(chatId, seq, value) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    store.put({
      chatId,
      seq,
      ...value
    });

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function getSnapshot(chatId, seq) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get([chatId, seq]);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}
