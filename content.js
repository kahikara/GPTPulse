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
    hiddenCount: 0
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

  const messages = collectMessageContainers();
  const visibleLimit = clampInt(settings.maxVisibleMessages, 1, 200, 10);

  applyVisibility(messages, visibleLimit);

  if (token !== latestRunToken) return;

  const hiddenCount = Math.max(0, messages.length - Math.min(messages.length, visibleLimit));

  renderOverlay({
    totalCount: messages.length,
    visibleCount: messages.length - hiddenCount,
    hiddenCount
  });

  markTrimReady();
}

function collectMessageContainers() {
  const nodes = Array.from(document.querySelectorAll('main [data-message-author-role], [data-message-author-role]'));
  const seen = new Set();
  const result = [];

  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    if (root && (node === root || root.contains(node))) continue;

    const container = node.closest('article') || node;
    if (!(container instanceof HTMLElement)) continue;
    if (!container.isConnected) continue;
    if (root && (container === root || root.contains(container))) continue;
    if (seen.has(container)) continue;

    seen.add(container);
    result.push(container);
  }

  return result;
}

function applyVisibility(messages, visibleLimit) {
  const cutoff = Math.max(0, messages.length - visibleLimit);

  withDomChanges(() => {
    for (let i = 0; i < messages.length; i++) {
      const node = messages[i];
      const shouldHide = i < cutoff;
      const isHidden = node.dataset.gptpulseHidden === '1';

      if (shouldHide && !isHidden) {
        if (node.dataset.gptpulsePrevDisplay === undefined) {
          node.dataset.gptpulsePrevDisplay = node.style.display || '';
        }

        node.dataset.gptpulseHidden = '1';
        node.setAttribute('aria-hidden', 'true');
        node.style.display = 'none';
      } else if (!shouldHide && isHidden) {
        const prevDisplay = node.dataset.gptpulsePrevDisplay || '';

        if (prevDisplay) {
          node.style.display = prevDisplay;
        } else {
          node.style.removeProperty('display');
        }

        node.removeAttribute('aria-hidden');
        delete node.dataset.gptpulseHidden;
        delete node.dataset.gptpulsePrevDisplay;
      }
    }
  });
}

function renderOverlay({ totalCount, visibleCount, hiddenCount }) {
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

function formatNumber(num) {
  return new Intl.NumberFormat().format(Number(num) || 0);
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
