// SyncingBridge Webview Entrypoint
import './styles.css';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

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
  void initStatus();
});
