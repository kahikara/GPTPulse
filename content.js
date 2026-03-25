const ROOT_ID = 'gptpulse-root';

const DEFAULTS = {
  overlayVisible: true,
  loggingEnabled: false,
  maxVisibleMessages: 10,
  folderConfigured: false,
  folderName: ''
};

let settings = { ...DEFAULTS };
let root = null;
let observer = null;
let updateTimer = null;
const pageSeen = new Map();

bootstrap().catch((error) => {
  console.error('[GPTPulse][content] bootstrap failed', error);
});

async function bootstrap() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  settings = { ...DEFAULTS, ...stored };

  ensureRoot();
  render({
    totalCount: 0,
    shownCount: 0,
    hiddenCount: 0,
    totalChars: 0,
    chatId: getChatId(),
    loggingStateText: getLoggingStateText()
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue;
    }
    scheduleUpdate();
  });

  observer = new MutationObserver(() => scheduleUpdate());
  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  window.addEventListener('popstate', () => {
    pageSeen.clear();
    scheduleUpdate();
  });

  window.addEventListener('hashchange', () => {
    pageSeen.clear();
    scheduleUpdate();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleUpdate();
  });

  scheduleUpdate();
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

function scheduleUpdate() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(runUpdate, 250);
}

async function runUpdate() {
  ensureRoot();

  if (!settings.overlayVisible) {
    root.style.display = 'none';
    restoreAllMessages();
    return;
  }

  root.style.display = '';

  const messages = collectMessages();
  const totalCount = messages.length;
  const totalChars = messages.reduce((sum, msg) => sum + msg.charCount, 0);
  const limit = clampInt(settings.maxVisibleMessages, 1, 200, 10);
  const shownCount = Math.min(totalCount, limit);
  const hiddenCount = Math.max(0, totalCount - shownCount);
  const chatId = getChatId();
  const chatTitle = getChatTitle();

  applyVisibility(messages, limit);

  render({
    totalCount,
    shownCount,
    hiddenCount,
    totalChars,
    chatId,
    loggingStateText: getLoggingStateText()
  });

  if (!settings.loggingEnabled || !settings.folderConfigured || messages.length === 0) {
    return;
  }

  const seenKey = chatId || 'unknown-chat';
  const seen = pageSeen.get(seenKey) || new Set();

  const newEntries = [];
  for (const msg of messages) {
    if (seen.has(msg.signature)) continue;
    seen.add(msg.signature);
    newEntries.push({
      role: msg.role,
      text: msg.text,
      charCount: msg.charCount,
      signature: msg.signature,
      capturedAt: msg.capturedAt
    });
  }

  pageSeen.set(seenKey, seen);

  if (newEntries.length === 0) return;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'appendLogs',
      payload: {
        chatId,
        chatTitle,
        url: location.href,
        entries: newEntries
      }
    });

    if (!response?.ok && response?.error) {
      console.warn('[GPTPulse] appendLogs failed:', response.error);
    }
  } catch (error) {
    console.warn('[GPTPulse] appendLogs exception:', error);
  }
}

function render({ totalCount, shownCount, hiddenCount, totalChars, chatId, loggingStateText }) {
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
        <div class="gptpulse-row">
          <span class="gptpulse-label">Logging</span>
          <span class="gptpulse-value">${escapeHtml(loggingStateText)}</span>
        </div>
        <div class="gptpulse-slider-wrap">
          <div class="gptpulse-slider-head">
            <span class="gptpulse-label">Visible messages</span>
            <span class="gptpulse-value" id="gptpulse-slider-value">${formatNumber(sliderValue)}</span>
          </div>
          <input class="gptpulse-slider" id="gptpulse-slider" type="range" min="1" max="200" step="1" value="${sliderValue}">
        </div>
        <div class="gptpulse-footer">
          <button class="gptpulse-btn" id="gptpulse-toggle-log" type="button">
            ${settings.loggingEnabled ? 'Logging On' : 'Logging Off'}
          </button>
          <button class="gptpulse-btn" id="gptpulse-open-options" type="button">
            Options
          </button>
        </div>
        <div class="gptpulse-muted">
          Chat: ${escapeHtml(shorten(chatId, 26))}
        </div>
      </div>
    </div>
  `;

  const toggleBtn = root.querySelector('#gptpulse-toggle-log');
  const optionsBtn = root.querySelector('#gptpulse-open-options');
  const slider = root.querySelector('#gptpulse-slider');
  const sliderValueEl = root.querySelector('#gptpulse-slider-value');

  toggleBtn?.addEventListener('click', async () => {
    const next = !settings.loggingEnabled;
    await chrome.storage.local.set({ loggingEnabled: next });
  });

  optionsBtn?.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'openOptions' });
  });

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

function collectMessages() {
  const nodes = Array.from(document.querySelectorAll('main [data-message-author-role], [data-message-author-role]'));
  const uniqueNodes = [];
  const seenNodes = new Set();

  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    if (seenNodes.has(node)) continue;
    seenNodes.add(node);
    uniqueNodes.push(node);
  }

  const messages = [];
  const seenSignatures = new Set();

  for (const node of uniqueNodes) {
    const role = node.getAttribute('data-message-author-role') || 'unknown';
    const rawText = normalizeText(node.innerText || node.textContent || '');
    if (!rawText) continue;

    const signature = hashString(`${role}\u241f${rawText}`);
    if (seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);

    messages.push({
      node,
      role,
      text: rawText,
      charCount: rawText.length,
      signature,
      capturedAt: new Date().toISOString()
    });
  }

  return messages;
}

function applyVisibility(messages, limit) {
  const cutoff = Math.max(0, messages.length - limit);

  for (let i = 0; i < messages.length; i++) {
    const node = messages[i].node;
    if (!(node instanceof HTMLElement)) continue;

    if (i < cutoff) {
      if (!node.dataset.gptpulsePrevDisplay) {
        node.dataset.gptpulsePrevDisplay = node.style.display || '';
      }
      node.style.display = 'none';
      node.setAttribute('data-gptpulse-hidden', '1');
    } else {
      restoreMessage(node);
    }
  }
}

function restoreMessage(node) {
  if (!(node instanceof HTMLElement)) return;
  if (node.dataset.gptpulsePrevDisplay !== undefined) {
    const prev = node.dataset.gptpulsePrevDisplay;
    if (prev) {
      node.style.display = prev;
    } else {
      node.style.removeProperty('display');
    }
    delete node.dataset.gptpulsePrevDisplay;
  } else if (node.style.display === 'none') {
    node.style.removeProperty('display');
  }
  node.removeAttribute('data-gptpulse-hidden');
}

function restoreAllMessages() {
  const hidden = document.querySelectorAll('[data-gptpulse-hidden="1"], [data-message-author-role]');
  for (const node of hidden) {
    restoreMessage(node);
  }
}

function getLoggingStateText() {
  if (!settings.loggingEnabled) return 'Off';
  if (!settings.folderConfigured) return 'No folder';
  return `On · ${settings.folderName || 'folder set'}`;
}

function getChatId() {
  const match = location.pathname.match(/\/c\/([^/?#]+)/);
  if (match?.[1]) return match[1];

  const title = getChatTitle();
  if (title) return `temp_${title}`;
  return 'temporary-chat';
}

function getChatTitle() {
  const title =
    document.querySelector('main h1')?.textContent?.trim() ||
    document.title?.replace(/\s+\|\s+ChatGPT.*$/i, '').trim() ||
    'Untitled Chat';

  return sanitizeSmall(title);
}

function sanitizeSmall(input) {
  return String(input).replace(/\s+/g, '_').replace(/[^\w.\-]+/g, '_').slice(0, 80);
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

function formatCompact(num) {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(num);
}

function formatNumber(num) {
  return new Intl.NumberFormat().format(Number(num) || 0);
}

function shorten(input, max) {
  const str = String(input || '');
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}…`;
}

function escapeHtml(input) {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function hashString(input) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return `${(h2 >>> 0).toString(16)}${(h1 >>> 0).toString(16)}`;
}
