const DEFAULTS = {
  overlayVisible: true,
  maxVisibleMessages: 10,
  autoReloadEnabled: false,
  autoReloadHiddenThreshold: 120
};

const els = {
  maxVisibleMessages: document.getElementById('maxVisibleMessages'),
  maxVisibleNumber: document.getElementById('maxVisibleNumber'),
  maxVisibleValue: document.getElementById('maxVisibleValue'),
  overlayVisible: document.getElementById('overlayVisible'),
  autoReloadEnabled: document.getElementById('autoReloadEnabled'),
  autoReloadHiddenThreshold: document.getElementById('autoReloadHiddenThreshold'),
  status: document.getElementById('status')
};

init().catch((error) => {
  console.error('[GPTPulse][options] init failed', error);
  setStatus(`Init failed: ${String(error?.message || error)}`, true);
});

async function init() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const settings = { ...DEFAULTS, ...stored };
  applySettingsToUi(settings);

  els.maxVisibleMessages.addEventListener('input', () => {
    const value = clampInt(els.maxVisibleMessages.value, 1, 200, 10);
    updateVisibleControls(value);
  });

  els.maxVisibleMessages.addEventListener('change', async () => {
    await saveCurrentSettings();
  });

  els.maxVisibleNumber.addEventListener('input', () => {
    const value = clampInt(els.maxVisibleNumber.value, 1, 200, 10);
    updateVisibleControls(value);
  });

  els.maxVisibleNumber.addEventListener('change', async () => {
    const value = clampInt(els.maxVisibleNumber.value, 1, 200, 10);
    updateVisibleControls(value);
    await saveCurrentSettings();
  });

  els.overlayVisible.addEventListener('change', async () => {
    await saveCurrentSettings();
  });

  els.autoReloadEnabled.addEventListener('change', async () => {
    await saveCurrentSettings();
  });

  els.autoReloadHiddenThreshold.addEventListener('change', async () => {
    const value = clampInt(els.autoReloadHiddenThreshold.value, 20, 5000, 120);
    els.autoReloadHiddenThreshold.value = value;
    await saveCurrentSettings();
  });
}

function applySettingsToUi(settings) {
  const value = clampInt(settings.maxVisibleMessages, 1, 200, 10);
  updateVisibleControls(value);
  els.overlayVisible.checked = !!settings.overlayVisible;
  els.autoReloadEnabled.checked = !!settings.autoReloadEnabled;
  els.autoReloadHiddenThreshold.value = clampInt(settings.autoReloadHiddenThreshold, 20, 5000, 120);
}

function updateVisibleControls(value) {
  els.maxVisibleMessages.value = value;
  els.maxVisibleNumber.value = value;
  els.maxVisibleValue.textContent = String(value);
}

async function saveCurrentSettings() {
  const maxVisibleMessages = clampInt(els.maxVisibleNumber.value, 1, 200, 10);
  const overlayVisible = !!els.overlayVisible.checked;
  const autoReloadEnabled = !!els.autoReloadEnabled.checked;
  const autoReloadHiddenThreshold = clampInt(els.autoReloadHiddenThreshold.value, 20, 5000, 120);

  await chrome.storage.local.set({
    maxVisibleMessages,
    overlayVisible,
    autoReloadEnabled,
    autoReloadHiddenThreshold
  });

  setStatus('Saved');
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.style.color = isError ? '#fca5a5' : 'rgba(255,255,255,0.85)';

  clearTimeout(setStatus._timer);
  if (!isError && text) {
    setStatus._timer = setTimeout(() => {
      if (els.status.textContent === text) {
        els.status.textContent = '';
      }
    }, 1400);
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
