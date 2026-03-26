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
let latestRunToken = 0;
let lastAppliedLimit = null;

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
    restoreHint: false,
    visibleLimit: settings.maxVisibleMessages
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    let previousLimit = settings.maxVisibleMessages;

    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue;
    }

    if (changes.maxVisibleMessages && Number(settings.maxVisibleMessages) > Number(previousLimit)) {
      const hasCollapsed = document.querySelector('[data-gptpulse-collapsed="1"]');
      if (hasCollapsed) {
        lastAppliedLimit = null;
      }
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
    characterData: false
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
  lastAppliedLimit = null;
  markTrimPending();
  scheduleUpdate(0);
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
  }, 1800);
}

function markTrimReady() {
  clearTimeout(pendingRevealTimer);
  document.documentElement.classList.remove('gptpulse-trim-pending');
}

function scheduleUpdate(delay = 80) {
  clearTimeout(updateTimer);
  const token = ++latestRunToken;
  updateTimer = setTimeout(() => {
    runUpdate(token);
  }, delay);
}

function runUpdate(token) {
  if (token !== latestRunToken) return;

  ensureRoot();
  root.style.display = settings.overlayVisible ? '' : 'none';

  const visibleLimit = clampInt(settings.maxVisibleMessages, 1, 200, 10);
  const messages = collectMessageContainers();

  const hadCollapsed = messages.some((m) => m.isCollapsed);
  applyHardCollapse(messages, visibleLimit);

  if (token !== latestRunToken) return;

  const finalMessages = collectMessageContainers();
  const hiddenCount = finalMessages.filter((m) => m.isCollapsed).length;
  const visibleCount = finalMessages.length - hiddenCount;

  const restoreHint =
    hadCollapsed &&
    lastAppliedLimit !== null &&
    visibleLimit > lastAppliedLimit &&
    hiddenCount > 0;

  renderOverlay({
    totalCount: finalMessages.length,
    visibleCount,
    hiddenCount,
    restoreHint,
    visibleLimit
  });

  lastAppliedLimit = visibleLimit;
  markTrimReady();
}

function collectMessageContainers() {
  const nodes = Array.from(document.querySelectorAll(
    '[data-gptpulse-message-root="1"], main [data-message-author-role], [data-message-author-role]'
  ));

  const seen = new Set();
  const result = [];

  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    if (root && (node === root || root.contains(node))) continue;

    let container;
    if (node.dataset.gptpulseMessageRoot === '1') {
      container = node;
    } else {
      container = node.closest('article') || node;
    }

    if (!(container instanceof HTMLElement)) continue;
    if (!container.isConnected) continue;
    if (root && (container === root || root.contains(container))) continue;
    if (seen.has(container)) continue;

    container.dataset.gptpulseMessageRoot = '1';
    seen.add(container);

    const isCollapsed = container.dataset.gptpulseCollapsed === '1';
    const charCount = isCollapsed
      ? Number(container.dataset.gptpulseCharCount || 0)
      : getVisibleCharCount(container);

    result.push({
      node: container,
      isCollapsed,
      charCount
    });
  }

  return result;
}

function getVisibleCharCount(node) {
  const text = normalizeText(node.innerText || node.textContent || '');
  return text.length;
}

function applyHardCollapse(messages, visibleLimit) {
  const cutoff = Math.max(0, messages.length - visibleLimit);

  withDomChanges(() => {
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const node = message.node;
      const shouldCollapse = i < cutoff;

      if (shouldCollapse) {
        if (message.isCollapsed) continue;

        node.dataset.gptpulseCollapsed = '1';
        node.dataset.gptpulseCharCount = String(message.charCount);
        node.setAttribute('aria-hidden', 'true');
        node.style.display = 'none';
        node.replaceChildren(createCollapsedStub());
      } else {
        if (!message.isCollapsed) continue;
      }
    }
  });
}

function createCollapsedStub() {
  const stub = document.createElement('div');
  stub.className = 'gptpulse-collapsed-stub';
  stub.setAttribute('aria-hidden', 'true');
  return stub;
}

function renderOverlay({ totalCount, visibleCount, hiddenCount, restoreHint, visibleLimit }) {
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
          <span class="gptpulse-label">Limit</span>
          <span class="gptpulse-value">${formatNumber(visibleLimit)}</span>
        </div>
        <div class="gptpulse-row">
          <span class="gptpulse-label">Restore</span>
          <span class="gptpulse-value">${restoreHint ? 'Reload' : 'Live'}</span>
        </div>
      </div>
    </div>
  `;
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

function formatNumber(num) {
  return new Intl.NumberFormat().format(Number(num) || 0);
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
