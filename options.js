const DEFAULTS = {
  overlayVisible: true,
  maxVisibleMessages: 10
};

const els = {
  maxVisibleMessages: document.getElementById('maxVisibleMessages'),
  maxVisibleNumber: document.getElementById('maxVisibleNumber'),
  maxVisibleValue: document.getElementById('maxVisibleValue'),
  overlayVisible: document.getElementById('overlayVisible'),
  saveSettings: document.getElementById('saveSettings'),
  status: document.getElementById('status')
};

init().catch((error) => {
  console.error('[GPTPulse][options] init failed', error);
  setStatus(`Init failed: ${String(error?.message || error)}`, true);
});

async function init() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const settings = { ...DEFAULTS, ...stored };

  const visible = clampInt(settings.maxVisibleMessages, 1, 200, 10);

  els.maxVisibleMessages.value = visible;
  els.maxVisibleNumber.value = visible;
  els.maxVisibleValue.textContent = String(visible);
  els.overlayVisible.checked = !!settings.overlayVisible;

  els.maxVisibleMessages.addEventListener('input', syncFromRange);
  els.maxVisibleNumber.addEventListener('input', syncFromNumber);
  els.saveSettings.addEventListener('click', saveSettings);
  els.overlayVisible.addEventListener('change', saveQuickToggles);
}

function syncFromRange() {
  const value = clampInt(els.maxVisibleMessages.value, 1, 200, 10);
  els.maxVisibleNumber.value = value;
  els.maxVisibleValue.textContent = String(value);
}

function syncFromNumber() {
  const value = clampInt(els.maxVisibleNumber.value, 1, 200, 10);
  els.maxVisibleMessages.value = value;
  els.maxVisibleValue.textContent = String(value);
}

async function saveQuickToggles() {
  await chrome.storage.local.set({
    overlayVisible: els.overlayVisible.checked
  });

  setStatus('Overlay setting saved.');
}

async function saveSettings() {
  const maxVisibleMessages = clampInt(els.maxVisibleNumber.value, 1, 200, 10);

  await chrome.storage.local.set({
    maxVisibleMessages,
    overlayVisible: els.overlayVisible.checked
  });

  els.maxVisibleMessages.value = maxVisibleMessages;
  els.maxVisibleNumber.value = maxVisibleMessages;
  els.maxVisibleValue.textContent = String(maxVisibleMessages);

  setStatus('Settings saved.');
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.style.color = isError ? '#fca5a5' : 'rgba(255,255,255,0.85)';
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
