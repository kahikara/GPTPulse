const ROOT_ID = 'gptpulse-root';

const DEFAULTS = {
  overlayVisible: true,
  maxVisibleMessages: 10,
  autoReloadEnabled: false,
  autoReloadHiddenThreshold: 120
};

let settings = { ...DEFAULTS };
let root = null;
let observer = null;
let updateTimer = null;
let suppressObserver = false;
let pendingRevealTimer = null;
let latestRunToken = 0;

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
    visibleLimit: settings.maxVisibleMessages,
    stateLabel: 'Idle'
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

  applyHardCollapse(messages, visibleLimit);

  if (token !== latestRunToken) return;

  const finalMessages = collectMessageContainers();
  const hiddenCount = finalMessages.filter((m) => m.isCollapsed).length;
  const visibleCount = finalMessages.length - hiddenCount;

  const stateLabel = computeStateLabel({
    visibleCount,
    hiddenCount,
    visibleLimit
  });

  renderOverlay({
    totalCount: finalMessages.length,
    visibleCount,
    hiddenCount,
    visibleLimit,
    stateLabel
  });

  maybeAutoReload({
    hiddenCount,
    visibleLimit
  });

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

function computeStateLabel({ visibleCount, hiddenCount, visibleLimit }) {
  if (hiddenCount > 0 && visibleCount < visibleLimit) {
    return 'Reload';
  }

  if (settings.autoReloadEnabled) {
    const threshold = clampInt(settings.autoReloadHiddenThreshold, 1, 100000, 120);
    if (hiddenCount >= threshold) {
      if (isGenerating()) return 'Waiting';
      if (hasReloadCooldown(hiddenCount)) return 'Cooldown';
      return 'Ready';
    }
  }

  return 'Live';
}

function maybeAutoReload({ hiddenCount, visibleLimit }) {
  if (!settings.autoReloadEnabled) return;
  if (document.hidden) return;

  const threshold = clampInt(settings.autoReloadHiddenThreshold, 1, 100000, 120);
  if (hiddenCount < threshold) return;
  if (isGenerating()) return;
  if (visibleLimit < 1) return;
  if (hasReloadCooldown(hiddenCount)) return;

  recordReload(hiddenCount);
  setTimeout(() => {
    location.reload();
  }, 120);
}

function getChatKey() {
  const match = location.pathname.match(/\/c\/([^/?#]+)/);
  if (match?.[1]) return match[1];
  return location.pathname || 'temporary-chat';
}

function getReloadStorageKey() {
  return `gptpulseReload:${getChatKey()}`;
}

function hasReloadCooldown(hiddenCount) {
  try {
    const raw = sessionStorage.getItem(getReloadStorageKey());
    if (!raw) return false;

    const info = JSON.parse(raw);
    if (!info || typeof info !== 'object') return false;

    const lastHidden = Number(info.hiddenCount || 0);
    const lastTs = Number(info.ts || 0);
    const now = Date.now();
    const deltaNeeded = Math.max(20, Math.floor(clampInt(settings.autoReloadHiddenThreshold, 1, 100000, 120) / 4));

    if (now - lastTs < 15000) return true;
    if (hiddenCount < lastHidden + deltaNeeded) return true;

    return false;
  } catch {
    return false;
  }
}

function recordReload(hiddenCount) {
  try {
    sessionStorage.setItem(
      getReloadStorageKey(),
      JSON.stringify({
        hiddenCount,
        ts: Date.now()
      })
    );
  } catch {}
}

function isGenerating() {
  const selectorMatches = document.querySelector(
    'button[data-testid*="stop"], button[aria-label*="Stop"], button[aria-label*="stop"]'
  );
  if (selectorMatches) return true;

  const buttons = Array.from(document.querySelectorAll('button'));
  return buttons.some((button) => {
    if (!(button instanceof HTMLElement)) return false;
    if (button.offsetParent === null) return false;

    const text = normalizeText(button.innerText || button.textContent || '').toLowerCase();
    return text === 'stop' || text === 'stop generating' || text.includes('stop generating');
  });
}

function renderOverlay({ totalCount, visibleCount, hiddenCount, visibleLimit, stateLabel }) {
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
          <span class="gptpulse-label">State</span>
          <span class="gptpulse-value">${escapeHtml(stateLabel)}</span>
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

function escapeHtml(input) {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
