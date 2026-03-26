const ROOT_ID = 'gptpulse-root';
const ARCHIVE_SUMMARY_ID = 'gptpulse-archive-summary';
const DB_NAME = 'gptpulse-archive';
const DB_VERSION = 1;
const META_STORE = 'chatMeta';
const SNAPSHOT_STORE = 'chatSnapshots';

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

function handleNavigation() {
  currentState = makeChatState(getChatId());
  removeArchiveSummary();
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
    console.warn('[GPTPulse] clear archive failed', error);
  }

  if (token !== latestRunToken) return;

  ensureRoot();
  root.style.display = settings.overlayVisible ? '' : 'none';

  let messages = collectMessages(state);
  const targetVisible = clampInt(settings.maxVisibleMessages, 1, 200, 10);

  if (messages.length > targetVisible) {
    markTrimPending();

    const overflow = messages.slice(0, messages.length - targetVisible);
    await archiveAndRemoveMessages(state.chatId, overflow);

    if (token !== latestRunToken) return;
    messages = collectMessages(state);
  }

  if (messages.length < targetVisible) {
    const restoreCount = targetVisible - messages.length;
    if (restoreCount > 0) {
      await restoreNewestArchivedMessages(state.chatId, restoreCount);

      if (token !== latestRunToken) return;
      messages = collectMessages(state);
    }
  }

  const meta = await getChatMeta(state.chatId);
  if (token !== latestRunToken) return;

  renderArchiveSummary(meta.count);
  renderOverlay({
    totalCount: messages.length + meta.count,
    visibleCount: messages.length,
    hiddenCount: meta.count,
    totalChars: sumChars(messages) + (meta.totalChars || 0)
  });

  markTrimReady();
}

async function archiveAndRemoveMessages(chatId, messages) {
  if (!messages.length) return;

  const snapshots = messages.map((message) => ({
    seq: message.seq,
    outerHTML: message.node.outerHTML,
    charCount: message.charCount
  }));

  await appendSnapshots(chatId, snapshots);

  withDomChanges(() => {
    for (const message of messages) {
      message.node.remove();
    }
  });
}

async function restoreNewestArchivedMessages(chatId, count) {
  const snapshots = await takeNewestSnapshots(chatId, count);
  if (!snapshots.length) return;

  const firstVisible = collectVisibleMessageNodes()[0] || null;
  const parent = firstVisible?.parentNode || findThreadParent();
  if (!parent) return;

  withDomChanges(() => {
    const range = document.createRange();
    range.selectNode(parent);

    for (const snapshot of snapshots) {
      const fragment = range.createContextualFragment(snapshot.outerHTML);
      parent.insertBefore(fragment, firstVisible);
    }
  });
}

function collectVisibleMessageNodes() {
  return collectMessages(ensureCurrentState()).map((message) => message.node);
}

function collectMessages(state) {
  const candidates = Array.from(document.querySelectorAll('main [data-message-author-role], [data-message-author-role]'));
  const seenContainers = new Set();
  const messages = [];

  for (const node of candidates) {
    if (!(node instanceof HTMLElement)) continue;
    if (root && (node === root || root.contains(node))) continue;
    if (node.closest(`#${ARCHIVE_SUMMARY_ID}`)) continue;

    const container = node.closest('article') || node;
    if (!(container instanceof HTMLElement)) continue;
    if (!container.isConnected) continue;
    if (root && (container === root || root.contains(container))) continue;
    if (container.closest(`#${ARCHIVE_SUMMARY_ID}`)) continue;
    if (seenContainers.has(container)) continue;

    const text = normalizeText(container.innerText || container.textContent || '');
    if (!text) continue;

    seenContainers.add(container);

    if (!container.dataset.gptpulseSeq) {
      container.dataset.gptpulseSeq = String(state.nextSeq++);
    } else {
      const seqNum = Number(container.dataset.gptpulseSeq);
      if (Number.isFinite(seqNum) && seqNum >= state.nextSeq) {
        state.nextSeq = seqNum + 1;
      }
    }

    messages.push({
      node: container,
      seq: Number(container.dataset.gptpulseSeq),
      charCount: text.length
    });
  }

  messages.sort((a, b) => a.seq - b.seq);
  return messages;
}

function renderArchiveSummary(hiddenCount) {
  removeArchiveSummary();

  if (!hiddenCount) return;

  const firstVisible = collectVisibleMessageNodes()[0] || null;
  const parent = firstVisible?.parentNode || findThreadParent();
  if (!parent) return;

  const summary = document.createElement('div');
  summary.id = ARCHIVE_SUMMARY_ID;
  summary.innerHTML = `<strong>${formatNumber(hiddenCount)}</strong> older messages are currently hidden. Increase the visible message limit to bring more back into the chat.`;

  withDomChanges(() => {
    parent.insertBefore(summary, firstVisible);
  });
}

function removeArchiveSummary() {
  const node = document.getElementById(ARCHIVE_SUMMARY_ID);
  if (!node) return;

  withDomChanges(() => {
    node.remove();
  });
}

function findThreadParent() {
  const firstVisible = collectVisibleMessageNodes()[0];
  if (firstVisible?.parentNode) return firstVisible.parentNode;

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

function defaultMeta(chatId) {
  return {
    chatId,
    count: 0,
    totalChars: 0,
    lastSeq: 0
  };
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

      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE, { keyPath: ['chatId', 'seq'] });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

async function clearChatArchive(chatId) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, SNAPSHOT_STORE], 'readwrite');
    const metaStore = tx.objectStore(META_STORE);
    const snapshotStore = tx.objectStore(SNAPSHOT_STORE);

    metaStore.delete(chatId);

    const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
    const request = snapshotStore.openCursor(range);

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

async function getChatMeta(chatId) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const store = tx.objectStore(META_STORE);
    const request = store.get(chatId);

    request.onsuccess = () => resolve(request.result || defaultMeta(chatId));
    request.onerror = () => reject(request.error);
  });
}

async function appendSnapshots(chatId, snapshots) {
  if (!snapshots.length) return;

  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, SNAPSHOT_STORE], 'readwrite');
    const metaStore = tx.objectStore(META_STORE);
    const snapshotStore = tx.objectStore(SNAPSHOT_STORE);
    const metaRequest = metaStore.get(chatId);

    metaRequest.onsuccess = () => {
      const meta = metaRequest.result || defaultMeta(chatId);

      for (const snapshot of snapshots) {
        meta.count += 1;
        meta.totalChars += snapshot.charCount || 0;
        if (snapshot.seq > meta.lastSeq) meta.lastSeq = snapshot.seq;

        snapshotStore.put({
          chatId,
          seq: snapshot.seq,
          outerHTML: snapshot.outerHTML,
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

async function takeNewestSnapshots(chatId, limit) {
  if (limit <= 0) return [];

  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, SNAPSHOT_STORE], 'readwrite');
    const metaStore = tx.objectStore(META_STORE);
    const snapshotStore = tx.objectStore(SNAPSHOT_STORE);
    const metaRequest = metaStore.get(chatId);
    const collected = [];

    metaRequest.onsuccess = () => {
      const meta = metaRequest.result || defaultMeta(chatId);
      const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
      const cursorRequest = snapshotStore.openCursor(range, 'prev');

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;

        if (!cursor || collected.length >= limit) {
          for (const item of collected) {
            snapshotStore.delete([chatId, item.seq]);
            meta.count -= 1;
            meta.totalChars -= item.charCount || 0;
          }

          if (meta.count < 0) meta.count = 0;
          if (meta.totalChars < 0) meta.totalChars = 0;

          metaStore.put(meta);
          return;
        }

        collected.push(cursor.value);
        cursor.continue();
      };

      cursorRequest.onerror = () => reject(cursorRequest.error);
    };

    metaRequest.onerror = () => reject(metaRequest.error);

    tx.oncomplete = () => {
      collected.reverse();
      resolve(collected);
    };

    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
