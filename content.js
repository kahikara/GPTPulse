const ROOT_ID = 'gptpulse-root';

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
  render({
    totalCount: 0,
    shownCount: 0,
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

function patchHistory() {
  if (window.__gptpulseHistoryPatched) return;
  window.__gptpulseHistoryPatched = true;

  const wrap = (name) => {
    const original = history[name];
    if (typeof original !== 'function') return;

    history[name] = function (...args) {
      const result = original.apply(this, args);
      window.dispatchEvent(new Event('gptpulse:navigation'));
      return result;
    };
  };

  wrap('pushState');
  wrap('replaceState');
}

function handleNavigation() {
  const chatId = getChatId();
  if (!currentState || currentState.chatId !== chatId) {
    currentState = makeChatState(chatId);
  } else {
    currentState.stashed = [];
  }

  markTrimPending();
  scheduleUpdate(0);
}

function makeChatState(chatId) {
  return {
    chatId,
    stashed: []
  };
}

function ensureCurrentState() {
  const chatId = getChatId();
  if (!currentState || currentState.chatId !== chatId) {
    currentState = makeChatState(chatId);
  }
  return currentState;
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

function scheduleUpdate(delay = 80) {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(runUpdate, delay);
}

async function runUpdate() {
  ensureRoot();
  const state = ensureCurrentState();

  if (!settings.overlayVisible) {
    restoreAllStashed(state);
    root.style.display = 'none';
    markTrimReady();
    return;
  }

  root.style.display = '';

  const limit = clampInt(settings.maxVisibleMessages, 1, 200, 10);
  const visibleBefore = collectVisibleMessages();

  if (visibleBefore.length === 0) {
    render({
      totalCount: state.stashed.length,
      shownCount: 0,
      hiddenCount: state.stashed.length,
      totalChars: sumChars(state.stashed)
    });
    return;
  }

  applyWindowing(state, visibleBefore, limit);

  const visibleAfter = collectVisibleMessages();
  const totalChars = sumChars(visibleAfter) + sumChars(state.stashed);

  render({
    totalCount: visibleAfter.length + state.stashed.length,
    shownCount: visibleAfter.length,
    hiddenCount: state.stashed.length,
    totalChars
  });

  markTrimReady();
}

function applyWindowing(state, visibleMessages, limit) {
  if (visibleMessages.length > limit) {
    const collapseCount = visibleMessages.length - limit;
    const toCollapse = visibleMessages.slice(0, collapseCount);

    withDomChanges(() => {
      for (const message of toCollapse) {
        state.stashed.push(snapshotMessage(message));
        message.node.remove();
      }
    });

    return;
  }

  if (visibleMessages.length < limit && state.stashed.length > 0) {
    const restoreCount = Math.min(limit - visibleMessages.length, state.stashed.length);
    const toRestore = state.stashed.splice(state.stashed.length - restoreCount, restoreCount);
    restoreSnapshots(toRestore);
  }
}

function restoreAllStashed(state) {
  if (!state.stashed.length) return;
  const toRestore = state.stashed.splice(0, state.stashed.length);
  restoreSnapshots(toRestore);
}

function restoreSnapshots(entries) {
  if (!entries.length) return;

  const visibleMessages = collectVisibleMessages();
  const referenceNode = visibleMessages[0]?.node || null;
  const parent = referenceNode?.parentNode || findMessageParent();

  if (!parent) return;

  withDomChanges(() => {
    const range = document.createRange();
    range.selectNode(parent);

    for (const entry of entries) {
      const fragment = range.createContextualFragment(entry.html);
      parent.insertBefore(fragment, referenceNode);
    }
  });
}

function snapshotMessage(message) {
  return {
    html: message.node.outerHTML,
    charCount: message.charCount
  };
}

function findMessageParent() {
  const firstVisible = collectVisibleMessages()[0]?.node;
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

function render({ totalCount, shownCount, hiddenCount, totalChars }) {
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

function collectVisibleMessages() {
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

    const text = normalizeText(container.innerText || container.textContent || '');
    if (!text) continue;

    seenContainers.add(container);
    messages.push({
      node: container,
      charCount: text.length
    });
  }

  return messages;
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
