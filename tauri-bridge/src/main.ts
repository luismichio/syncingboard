// SyncingBridge Webview Entrypoint
import './styles.css';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { initAblyCloudBridge } from './ablyBridge';

const statusDot    = document.getElementById('bridge-dot');
const statusText   = document.getElementById('bridge-text');
const sourcesSpan  = document.getElementById('sources-count');
const targetsSpan  = document.getElementById('targets-count');
const logEl        = document.getElementById('activity-log');
const brokerToggle = document.getElementById('toggle-broker-enabled') as HTMLInputElement | null;
const portInput    = document.getElementById('input-broker-port') as HTMLInputElement | null;
const labelPort    = document.getElementById('label-port');

function appendLog(msg: string) {
  if (!logEl) return;
  const now = new Date().toLocaleTimeString('en-GB', { hour12: false });
  logEl.textContent = `[${now}] ${msg}\n` + (logEl.textContent || '');
}

function clearLogs() {
  if (logEl) {
    logEl.textContent = '';
  }
}

// Tab navigation handler
function setupTabs() {
  const navTabs = document.querySelectorAll<HTMLButtonElement>('.nav-tab');
  const views = document.querySelectorAll<HTMLElement>('.tab-view');

  navTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const targetId = tab.dataset.tab;
      navTabs.forEach((t) => t.classList.remove('active'));
      views.forEach((v) => v.classList.remove('active'));

      tab.classList.add('active');
      const targetView = document.getElementById(`view-${targetId}`);
      if (targetView) targetView.classList.add('active');
    });
  });

  const subtabs = document.querySelectorAll<HTMLButtonElement>('.platform-tab');
  const guides = document.querySelectorAll<HTMLElement>('.guide-content');

  subtabs.forEach((subtab) => {
    subtab.addEventListener('click', () => {
      const targetSub = subtab.dataset.subtab;
      subtabs.forEach((st) => st.classList.remove('active'));
      guides.forEach((g) => g.classList.remove('active'));

      subtab.classList.add('active');
      const targetGuide = document.getElementById(`guide-${targetSub}`);
      if (targetGuide) targetGuide.classList.add('active');
    });
  });

  document.getElementById('btn-settings-clear-logs')?.addEventListener('click', clearLogs);
}

// Broker settings
function setupSettings() {
  const savedPort = localStorage.getItem('syncingboard_bridge_port') || '4401';
  if (portInput) {
    portInput.value = savedPort;
    portInput.addEventListener('change', () => {
      const raw = portInput.value.trim();
      const parsed = parseInt(raw, 10);
      const validPort = !isNaN(parsed) && parsed >= 1024 && parsed <= 65535 ? parsed : 4401;
      const pStr = String(validPort);
      portInput.value = pStr;
      localStorage.setItem('syncingboard_bridge_port', pStr);
      if (labelPort) labelPort.textContent = pStr;
      void invoke('set_broker_port', { port: validPort }).catch((err: unknown) => {
        appendLog(`Failed to rebind broker port: ${String(err)}`);
      });
    });
  }
  if (labelPort) labelPort.textContent = savedPort;

  if (brokerToggle) {
    brokerToggle.addEventListener('change', () => {
      const isEnabled = brokerToggle.checked;
      if (statusText) {
        statusText.textContent = isEnabled ? 'Active' : 'Paused';
        statusText.className = `status-state-text ${isEnabled ? 'connected' : 'disconnected'}`;
      }
      if (statusDot) {
        statusDot.className = `status-dot ${isEnabled ? 'connected' : 'disconnected'}`;
      }
      void invoke('set_broker_enabled', { enabled: isEnabled }).catch(() => {
        appendLog(`Local broker connection ${isEnabled ? 'enabled' : 'paused'}.`);
      });
    });
  }

  // Global Shortcuts settings
  const hotkeyImportInput = document.getElementById('input-hotkey-import') as HTMLInputElement | null;
  const hotkeyReplaceInput = document.getElementById('input-hotkey-replace') as HTMLInputElement | null;
  const hotkeySyncInput = document.getElementById('input-hotkey-sync') as HTMLInputElement | null;
  const btnHotkeysSave = document.getElementById('btn-hotkeys-save');
  const btnHotkeysReset = document.getElementById('btn-hotkeys-reset');
  const hotkeyStatusMsg = document.getElementById('hotkey-status-msg');

  const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
  const primaryModLabel = isMac ? 'Cmd' : 'Ctrl';

  const toDisplayHotkey = (raw: string): string =>
    raw.replace(/CommandOrControl/g, primaryModLabel);

  const toTauriHotkey = (display: string): string =>
    display.trim().replace(/^(?:Cmd\/Ctrl|Cmd|Ctrl)\b/i, 'CommandOrControl');

  const formatKeyCombo = (e: KeyboardEvent): string | null => {
    const mods: string[] = [];
    if (e.ctrlKey || e.metaKey) mods.push(primaryModLabel);
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');

    const key = e.key;
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return null;
    if (mods.length === 0) return null;

    let normalizedKey = key.length === 1 ? key.toUpperCase() : key;
    if (normalizedKey === ' ') normalizedKey = 'Space';
    return [...mods, normalizedKey].join('+');
  };

  const attachRecorder = (input: HTMLInputElement | null) => {
    if (!input) return;
    let previousValue = input.value;
    let isRecording = false;
    let countdownTimer: ReturnType<typeof setInterval> | null = null;
    let remainingSecs = 0;

    const stopRecording = (restorePrevious: boolean) => {
      if (!isRecording) return;
      isRecording = false;
      if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
      input.classList.remove('recording');
      input.placeholder = 'Disabled';
      if (restorePrevious) {
        input.value = previousValue;
      }
    };

    input.addEventListener('focus', () => {
      previousValue = input.value;
      isRecording = true;
      remainingSecs = 4;
      input.value = '';
      input.placeholder = `Press keys… (${remainingSecs}s)`;
      input.classList.add('recording');

      countdownTimer = setInterval(() => {
        remainingSecs -= 1;
        if (remainingSecs <= 0) {
          stopRecording(true);
          input.blur();
        } else {
          input.placeholder = `Press keys… (${remainingSecs}s)`;
        }
      }, 1000);
    });

    input.addEventListener('blur', () => {
      stopRecording(true);
    });

    input.addEventListener('keydown', (e) => {
      if (!isRecording) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Backspace' || e.key === 'Delete') {
        stopRecording(false);
        input.value = '';
        input.blur();
        return;
      }
      if (e.key === 'Escape') {
        stopRecording(true);
        input.blur();
        return;
      }
      const combo = formatKeyCombo(e);
      if (combo) {
        stopRecording(false);
        input.value = combo;
        input.blur();
      }
    });
  };

  attachRecorder(hotkeyImportInput);
  attachRecorder(hotkeyReplaceInput);
  attachRecorder(hotkeySyncInput);

  if (btnHotkeysSave) {
    btnHotkeysSave.addEventListener('click', async () => {
      const payload = {
        import: toTauriHotkey(hotkeyImportInput?.value || ''),
        replace: toTauriHotkey(hotkeyReplaceInput?.value || ''),
        sync: toTauriHotkey(hotkeySyncInput?.value || ''),
      };
      try {
        await invoke('set_hotkeys', payload);
        if (hotkeyStatusMsg) hotkeyStatusMsg.textContent = 'Shortcuts saved and active.';
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (hotkeyStatusMsg) hotkeyStatusMsg.textContent = `Error: ${msg}`;
        appendLog(`[Hotkeys] Failed to update shortcuts: ${msg}`);
      }
    });
  }

  if (btnHotkeysReset) {
    btnHotkeysReset.addEventListener('click', async () => {
      const defaults = {
        import: 'CommandOrControl+Shift+I',
        replace: 'CommandOrControl+Shift+R',
        sync: 'CommandOrControl+Shift+S',
      };
      if (hotkeyImportInput) hotkeyImportInput.value = toDisplayHotkey(defaults.import);
      if (hotkeyReplaceInput) hotkeyReplaceInput.value = toDisplayHotkey(defaults.replace);
      if (hotkeySyncInput) hotkeySyncInput.value = toDisplayHotkey(defaults.sync);
      try {
        await invoke('set_hotkeys', defaults);
        if (hotkeyStatusMsg) hotkeyStatusMsg.textContent = 'Restored default shortcuts.';
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (hotkeyStatusMsg) hotkeyStatusMsg.textContent = `Error: ${msg}`;
      }
    });
  }

  void invoke<{ import: string; replace: string; sync: string }>('get_hotkeys')
    .then((cfg) => {
      if (hotkeyImportInput) hotkeyImportInput.value = toDisplayHotkey(cfg.import || '');
      if (hotkeyReplaceInput) hotkeyReplaceInput.value = toDisplayHotkey(cfg.replace || '');
      if (hotkeySyncInput) hotkeySyncInput.value = toDisplayHotkey(cfg.sync || '');
    })
    .catch(() => {
      // keep defaults
    });
}

// Listen to bridge_status events emitted by Rust
listen<{ status: string; sessions: number; sources?: number; targets?: number; port?: number; message?: string }>('bridge_status', (event) => {
  const { status, sources, targets, port, message } = event.payload;

  if (statusText) {
    const isAct = status === 'active';
    statusText.textContent = isAct ? 'Active' : status.toUpperCase();
    statusText.className = `status-state-text ${isAct ? 'connected' : 'disconnected'}`;
  }

  if (statusDot) {
    statusDot.className = `status-dot ${status === 'active' ? 'connected' : 'disconnected'}`;
  }

  if (sourcesSpan && typeof sources === 'number') sourcesSpan.textContent = String(sources);
  if (targetsSpan && typeof targets === 'number') targetsSpan.textContent = String(targets);
  if (typeof port === 'number') {
    if (labelPort) labelPort.textContent = String(port);
    if (portInput && document.activeElement !== portInput) portInput.value = String(port);
  }

  if (message) {
    appendLog(message);
  }
});

// Proactively pull initial status on load
async function initStatus() {
  try {
    const initial = await invoke<{ status: string; sessions: number; sources?: number; targets?: number; port?: number }>('get_bridge_status');
    const isAct = initial.status === 'active';
    if (statusText) {
      statusText.textContent = isAct ? 'Active' : initial.status.toUpperCase();
      statusText.className = `status-state-text ${isAct ? 'connected' : 'disconnected'}`;
    }
    if (statusDot) {
      statusDot.className = `status-dot ${isAct ? 'connected' : 'disconnected'}`;
    }
    if (sourcesSpan && typeof initial.sources === 'number') sourcesSpan.textContent = String(initial.sources);
    if (targetsSpan && typeof initial.targets === 'number') targetsSpan.textContent = String(initial.targets);

    const savedPort = parseInt(localStorage.getItem('syncingboard_bridge_port') || '4401', 10);
    if (!isNaN(savedPort) && savedPort >= 1024 && savedPort <= 65535 && initial.port && savedPort !== initial.port) {
      await invoke('set_broker_port', { port: savedPort });
    } else if (typeof initial.port === 'number' && labelPort) {
      labelPort.textContent = String(initial.port);
    }

    appendLog('Connected to SyncingBridge core.');
  } catch (err) {
    appendLog('Failed to fetch bridge core status: ' + err);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupSettings();
  initAblyCloudBridge();
  void initStatus();
});
