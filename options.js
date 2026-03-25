const DEFAULTS = {
  overlayVisible: true,
  loggingEnabled: false,
  maxVisibleMessages: 10,
  folderConfigured: false,
  folderName: ''
};

const els = {
  maxVisibleMessages: document.getElementById('maxVisibleMessages'),
  maxVisibleNumber: document.getElementById('maxVisibleNumber'),
  maxVisibleValue: document.getElementById('maxVisibleValue'),
  overlayVisible: document.getElementById('overlayVisible'),
  loggingEnabled: document.getElementById('loggingEnabled'),
  saveSettings: document.getElementById('saveSettings'),
  folderInfo: document.getElementById('folderInfo'),
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
  els.loggingEnabled.checked = !!settings.loggingEnabled;
  els.folderInfo.textContent = settings.folderConfigured
    ? `Stored folder: ${settings.folderName || 'folder set'}`
    : 'Custom folder picker disabled in extension only mode.';

  els.maxVisibleMessages.addEventListener('input', syncFromRange);
  els.maxVisibleNumber.addEventListener('input', syncFromNumber);
  els.saveSettings.addEventListener('click', saveSettings);
  els.overlayVisible.addEventListener('change', saveQuickToggles);
  els.loggingEnabled.addEventListener('change', saveQuickToggles);
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
    overlayVisible: els.overlayVisible.checked,
    loggingEnabled: els.loggingEnabled.checked
  });

  setStatus('Overlay and logging toggles saved.');
}

async function saveSettings() {
  const maxVisibleMessages = clampInt(els.maxVisibleNumber.value, 1, 200, 10);

  await chrome.storage.local.set({
    maxVisibleMessages,
    overlayVisible: els.overlayVisible.checked,
    loggingEnabled: els.loggingEnabled.checked
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
