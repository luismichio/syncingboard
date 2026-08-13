/**
 * Companion Core - Unified Browser Runtime Controller
 * Reusable runtime logic for both Figma and Penpot companion plugin HTMLs.
 */

import { CompanionPlatform, SelectionPayload } from './types';
import { extractFigmaFileKey, generateTabId, isValidPairingId } from './validation';
import {
  isHostMessage,
  isRelayCommand,
  isRelayCompanionEvent,
  encodeSelectionStream,
  PendingRequestManager,
} from './protocol';
import { fetchAblyToken, CompanionConflictError } from './token';
import {
  CompanionStateMachine,
  calculateReconnectBackoff,
  calculateStandbyBackoff,
  sendSessionAction,
  sendReleaseBeacon,
} from './session';
import { getRelayChannelName, submitRelayResult } from './relay';
import { applyTheme } from './theme';

export interface AblyChannelLike {
  presence: {
    enter: (data: { ready: boolean }) => Promise<void>;
    leave?: () => Promise<void>;
  };
  subscribe: (event: string, listener: (msg: { data: unknown }) => void) => Promise<void> | void;
  unsubscribe: (event?: string, listener?: unknown) => Promise<void> | void;
  publish: (event: string, data: unknown) => Promise<void>;
}

export interface AblyClientLike {
  channels: {
    get: (name: string) => AblyChannelLike;
  };
  connection: {
    once: (event: string, listener: (state?: { reason?: { message?: string } }) => void) => void;
    on: (event: string, listener: () => void) => void;
  };
  close: () => void;
}

// Ably Realtime global type declaration
declare const Ably: {
  Realtime: new (options: {
    authCallback: (
      data: unknown,
      callback: (err: Error | null, tokenDetails: unknown) => void
    ) => void;
    recover?: boolean;
  }) => AblyClientLike;
};

export interface CompanionRuntimeOptions {
  platform: CompanionPlatform;
  title: string;
}

export function initCompanionRuntime(options: CompanionRuntimeOptions): void {
  const { platform } = options;
  const relayUrl = typeof window !== 'undefined' ? window.location.origin : '';

  // Stable tab ID seeded on window
  const win = window as unknown as { companionTabId?: string };
  const companionTabId = win.companionTabId || (win.companionTabId = generateTabId());

  // DOM Elements - Navigation
  const tabBtnSync = document.getElementById('tab-btn-sync') as HTMLButtonElement | null;
  const tabBtnSettings = document.getElementById('tab-btn-settings') as HTMLButtonElement | null;
  const viewSync = document.getElementById('view-sync') as HTMLElement | null;
  const viewSettings = document.getElementById('view-settings') as HTMLElement | null;

  // DOM Elements - Controls & Status
  const pairingInput = document.getElementById('pairing-id') as HTMLInputElement | null;
  const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement | null;
  const togglePairingVisBtn = document.getElementById('toggle-pairing-vis') as HTMLButtonElement | null;
  const statusText = document.getElementById('status-text') as HTMLElement | null;
  const statusDot = document.getElementById('status-dot') as HTMLElement | null;
  const pluginText = document.getElementById('plugin-text') as HTMLElement | null;
  const pluginDot = document.getElementById('plugin-dot') as HTMLElement | null;
  const logBox = document.getElementById('log') as HTMLElement | null;
  const linkCard = document.getElementById('link-card') as HTMLElement | null;
  const fileUrlInput = document.getElementById('file-url-input') as HTMLInputElement | null;
  const linkBtn = document.getElementById('link-btn') as HTMLButtonElement | null;
  const transferCard = document.getElementById('transfer-card') as HTMLElement | null;
  const companionTransferBtn = document.getElementById('companion-transfer-btn') as HTMLButtonElement | null;
  const themeToggleBtn = document.getElementById('theme-toggle-btn') as HTMLButtonElement | null;
  const themeIcon = document.getElementById('theme-icon') as SVGElement | null;
  const themeLabel = document.getElementById('theme-label') as HTMLElement | null;

  // Selection Card Elements
  const selectedNodeName = document.getElementById('selected-node-name') as HTMLElement | null;
  const selectedNodeInfo = document.getElementById('selected-node-info') as HTMLElement | null;
  const selectedNodeId = document.getElementById('selected-node-id') as HTMLElement | null;
  const selectedNodeDim = document.getElementById('selected-node-dim') as HTMLElement | null;
  const selectedNodeEmpty = document.getElementById('selected-node-empty') as HTMLElement | null;
  const copyNodeIdBtn = document.getElementById('copy-node-id-btn') as HTMLButtonElement | null;
  const copyNodeFeedback = document.getElementById('copy-node-feedback') as HTMLElement | null;

  // Runtime State
  let ablyClient: AblyClientLike | null = null;
  let ablyChannel: AblyChannelLike | null = null;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  let currentPairingId = '';
  let isConflictState = false;
  let currentThemeSetting: 'system' | 'light' | 'dark' = 'system';
  let currentNodeId = '';

  // Active file key parsed from URL parameters
  const urlParams = new URLSearchParams(window.location.search);
  let activeFileKey = urlParams.get('fileKey') || 'unknown';

  const pendingRequests = new PendingRequestManager(15_000, (reqId) => {
    log(`Request ${reqId} expired before the host plugin responded.`);
  });

  const stateMachine = new CompanionStateMachine(companionTabId, (state, status, text) => {
    updateStatusUI(status, text);
  });

  // Tab Navigation Handling
  function switchTab(tab: 'sync' | 'settings'): void {
    if (tab === 'sync') {
      tabBtnSync?.classList.add('active');
      tabBtnSettings?.classList.remove('active');
      viewSync?.classList.add('active');
      viewSettings?.classList.remove('active');
    } else {
      tabBtnSync?.classList.remove('active');
      tabBtnSettings?.classList.add('active');
      viewSync?.classList.remove('active');
      viewSettings?.classList.add('active');
    }
  }

  tabBtnSync?.addEventListener('click', () => switchTab('sync'));
  tabBtnSettings?.addEventListener('click', () => switchTab('settings'));

  function log(message: string): void {
    if (!logBox) return;
    const time = new Date().toLocaleTimeString();
    logBox.textContent = `[${time}] ${message}\n` + (logBox.textContent || '');
  }

  function updateStatusUI(status: 'connected' | 'connecting' | 'disconnected', text?: string): void {
    if (statusText) {
      statusText.className = 'status-state-text';
      if (status === 'connected') {
        statusText.classList.add('connected');
        statusText.textContent = (text || 'CONNECTED').toUpperCase();
      } else if (status === 'connecting') {
        statusText.classList.add('connecting');
        statusText.textContent = (text || 'CONNECTING...').toUpperCase();
      } else {
        statusText.classList.add('disconnected');
        statusText.textContent = (text || 'DISCONNECTED').toUpperCase();
      }
    }

    if (statusDot) {
      statusDot.className = 'status-dot';
      if (status === 'connected') {
        statusDot.classList.add('connected');
      } else if (status === 'connecting') {
        statusDot.classList.add('connecting');
      }
    }

    if (connectBtn) {
      if (status === 'connected') {
        connectBtn.className = 'btn-target-disconnect';
        connectBtn.textContent = 'DISCONNECT';
      } else {
        connectBtn.className = 'btn-target-connect';
        connectBtn.textContent = 'CONNECT';
      }
    }
  }

  function updatePluginBadge(connected: boolean): void {
    if (pluginText) {
      pluginText.className = 'status-state-text';
      if (connected) {
        pluginText.classList.add('connected');
        if (platform === 'figma') {
          pluginText.textContent =
            activeFileKey !== 'unknown' && activeFileKey
              ? `ACTIVE (${activeFileKey.substring(0, 6)}...)`
              : 'ACTIVE (UNLINKED)';
        } else {
          pluginText.textContent = 'ACTIVE';
        }
      } else {
        pluginText.classList.add('disconnected');
        pluginText.textContent = 'UNKNOWN';
      }
    }

    if (pluginDot) {
      pluginDot.className = 'status-dot';
      if (connected) {
        pluginDot.classList.add('connected');
      }
    }
  }

  function updateSelectionCard(node: SelectionPayload | null | undefined): void {
    if (!selectedNodeName) return;
    if (node && node.id) {
      currentNodeId = node.id;
      selectedNodeName.textContent = node.name || 'Selected Item';
      if (selectedNodeId) selectedNodeId.textContent = node.id;

      if (selectedNodeDim) {
        if (node.width && node.height) {
          selectedNodeDim.textContent = `• ${Math.round(node.width)}×${Math.round(node.height)} px`;
        } else {
          selectedNodeDim.textContent = '';
        }
      }

      if (selectedNodeInfo) selectedNodeInfo.style.display = 'flex';
      if (selectedNodeEmpty) selectedNodeEmpty.style.display = 'none';
    } else {
      currentNodeId = '';
      selectedNodeName.textContent = 'No selection';
      if (selectedNodeInfo) selectedNodeInfo.style.display = 'none';
      if (selectedNodeEmpty) selectedNodeEmpty.style.display = 'block';
    }
  }

  // Copy node ID handler
  copyNodeIdBtn?.addEventListener('click', () => {
    if (currentNodeId && navigator.clipboard) {
      navigator.clipboard.writeText(currentNodeId);
      if (copyNodeFeedback) {
        copyNodeFeedback.style.display = 'inline';
        setTimeout(() => {
          if (copyNodeFeedback) copyNodeFeedback.style.display = 'none';
        }, 1500);
      }
    }
  });

  function updateFileKeyUI(): void {
    if (!linkCard) return;
    if (platform === 'figma' && (activeFileKey === 'unknown' || !activeFileKey)) {
      linkCard.style.display = 'block';
    } else {
      linkCard.style.display = 'none';
    }
  }

  function updateThemeUI(theme: 'system' | 'light' | 'dark'): void {
    if (themeLabel) {
      themeLabel.textContent = theme.charAt(0).toUpperCase() + theme.slice(1);
    }
    if (themeIcon) {
      if (theme === 'system') {
        themeIcon.innerHTML = `<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>`;
      } else if (theme === 'light') {
        themeIcon.innerHTML = `<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>`;
      } else {
        themeIcon.innerHTML = `<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`;
      }
    }
  }

  function scheduleReconnect(): void {
    if (!currentPairingId) return;
    const attempt = stateMachine.incrementReconnect();
    if (attempt > 5) {
      log('Max reconnect attempts reached. Please check your network.');
      return;
    }
    const delay = calculateReconnectBackoff(attempt);
    log(`Reconnecting in ${delay / 1000}s (Attempt ${attempt}/5)...`);
    reconnectTimeout = setTimeout(() => void connectBridge(true), delay);
  }

  function scheduleEvictedReconnect(): void {
    if (!currentPairingId) return;
    const attempt = stateMachine.getStandbyAttempts();
    if (attempt >= 30) {
      log('Standby: re-admission gave up after 30 attempts. Click Connect to retry.');
      return;
    }
    const delay = calculateStandbyBackoff(attempt);
    reconnectTimeout = setTimeout(() => void connectBridge(true), delay);
  }

  async function disconnectAbly(reason: string = ''): Promise<void> {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (ablyChannel) {
      try {
        await ablyChannel.unsubscribe();
      } catch {
        // Ignore
      }
      ablyChannel = null;
    }
    if (ablyClient) {
      try {
        ablyClient.close();
      } catch {
        // Ignore
      }
      ablyClient = null;
    }
    stateMachine.setDisconnected(reason || 'Disconnected');
  }

  async function connectBridge(isAuto: boolean = false): Promise<void> {
    const rawPairing = pairingInput ? pairingInput.value : '';
    const pairingId = rawPairing.trim();

    if (!isValidPairingId(pairingId)) {
      log('Error: Pairing ID must start with "sb_" and be between 4 and 16 characters.');
      return;
    }

    if (!isAuto) {
      stateMachine.resetReconnect();
    }

    const previousPairingId = currentPairingId;
    isConflictState = false;
    currentPairingId = '';
    await disconnectAbly('Connecting...');

    if (previousPairingId && previousPairingId !== pairingId) {
      void sendSessionAction(relayUrl, previousPairingId, companionTabId, 'release');
    }

    currentPairingId = pairingId;
    stateMachine.startConnecting(pairingId);
    log('Connecting to cloud relay channel...');

    try {
      if (typeof Ably === 'undefined' || !Ably.Realtime) {
        throw new Error('Ably Realtime SDK not loaded.');
      }

      ablyClient = new Ably.Realtime({
        authCallback: (_data: unknown, callback: (err: Error | null, token: unknown) => void) => {
          fetchAblyToken(relayUrl, pairingId, platform, companionTabId)
            .then((tokenDetails) => {
              isConflictState = false;
              callback(null, tokenDetails);
            })
            .catch((err) => {
              if (err instanceof CompanionConflictError) {
                isConflictState = true;
              }
              callback(err instanceof Error ? err : new Error(String(err)), null);
            });
        },
        recover: false,
      });

      const client = ablyClient;
      const channelName = getRelayChannelName(platform, pairingId);
      ablyChannel = client.channels.get(channelName);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('WebSocket connection timed out.')),
          10_000
        );
        client.connection.once('connected', () => {
          clearTimeout(timeout);
          resolve();
        });
        client.connection.once('failed', (state?: { reason?: { message?: string } }) => {
          clearTimeout(timeout);
          reject(new Error(state?.reason?.message || 'WebSocket connection failed'));
        });
      });

      try {
        localStorage.setItem('syncingboard_pairing_id', pairingId);
      } catch {
        // LocalStorage sandbox block
      }

      // Enter presence set with ready: true
      try {
        await ablyChannel.presence.enter({ ready: true });
      } catch (presErr: unknown) {
        const presMsg = presErr instanceof Error ? presErr.message : String(presErr);
        log(`Warning: Presence registration failed: ${presMsg}`);
      }

      // Subscribe to command events
      await ablyChannel.subscribe('command', (msg: { data: unknown }) => {
        const command = msg.data;
        if (isRelayCommand(command)) {
          const cmdRecord = command as Record<string, unknown>;
          const clientOrigin = cmdRecord.client === 'figjam' || cmdRecord.source === 'figjam' ? 'FigJam' : 'Board';
          if (command.action === 'select') {
            log(`Selection request received from ${clientOrigin}.`);
            const reqId = command.id;
            pendingRequests.track(reqId);
            window.parent.postMessage({ action: 'get-selection', requestId: reqId }, '*');
          } else if (command.action === 'export' && platform === 'penpot') {
            log(`Export request received from ${clientOrigin}.`);
            const reqId = command.id;
            pendingRequests.track(reqId);
            const targetShapeId =
              (typeof cmdRecord.shapeId === 'string' ? cmdRecord.shapeId : null) ||
              (typeof cmdRecord.nodeId === 'string' ? cmdRecord.nodeId : null) ||
              (typeof cmdRecord.id === 'string' ? cmdRecord.id : null) ||
              currentNodeId;
            const formatVal = cmdRecord.format === 'png' || cmdRecord.format === 'svg' ? cmdRecord.format : 'png';
            const scaleVal = typeof cmdRecord.scale === 'number' ? cmdRecord.scale : 2;
            window.parent.postMessage(
              {
                action: 'export-shape',
                shapeId: targetShapeId,
                requestId: reqId,
                format: formatVal,
                scale: scaleVal,
              },
              '*'
            );
          }
        }
      });

      // Subscribe to companion events (eviction / transfer)
      await ablyChannel.subscribe('companion-event', (msg: { data: unknown }) => {
        const data = msg.data;
        if (isRelayCompanionEvent(data)) {
          if (data.tabId !== companionTabId) return;

          if (data.event === 'companion_transferred') {
            log('Connection moved to another tab.');
            currentPairingId = '';
            if (transferCard) transferCard.style.display = 'none';
            stateMachine.setTransferred();
            void disconnectAbly('Moved to another tab');
          } else if (data.event === 'companion_evicted') {
            log('Standby — slot granted to active sync. Re-admitting shortly.');
            stateMachine.setStandby();
            void disconnectAbly('Standby');
            scheduleEvictedReconnect();
          }
        }
      });

      // Connection lifecycle events
      client.connection.on('disconnected', () => {
        if (ablyClient !== client || !currentPairingId) return;
        updateStatusUI('connecting', 'Reconnecting');
      });

      const recoverConnection = (state: string) => {
        if (ablyClient !== client || !currentPairingId) return;
        try {
          client.close();
        } catch {
          // Ignore
        }
        ablyChannel = null;
        ablyClient = null;
        updateStatusUI('connecting', 'Reconnecting');
        log(`Ably connection ${state}; scheduling reconnect.`);
        scheduleReconnect();
      };

      client.connection.on('suspended', () => recoverConnection('suspended'));
      client.connection.on('failed', () => recoverConnection('failed'));
      client.connection.on('closed', () => recoverConnection('closed'));

      stateMachine.setConnected();
      if (transferCard) transferCard.style.display = 'none';
      log('Companion connected via Ably WebSocket.');
    } catch (err: unknown) {
      await disconnectAbly();
      const errMsg = err instanceof Error ? err.message : String(err);

      if (isConflictState) {
        log('Companion active in another tab.');
        if (transferCard) transferCard.style.display = 'block';
        stateMachine.setConflict();
        return;
      }

      log(`Connection failed: ${errMsg}`);
      stateMachine.setFailed(errMsg);
      scheduleReconnect();
    }
  }

  // Connect / Disconnect Action
  connectBtn?.addEventListener('click', () => {
    if (stateMachine.getState() === 'connected') {
      currentPairingId = '';
      void disconnectAbly('Disconnected by user');
    } else {
      void connectBridge(false);
    }
  });

  companionTransferBtn?.addEventListener('click', async () => {
    if (!currentPairingId) return;
    try {
      const ok = await sendSessionAction(relayUrl, currentPairingId, companionTabId, 'transfer');
      if (ok) {
        if (transferCard) transferCard.style.display = 'none';
        void connectBridge(false);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Transfer failed: ${errMsg}`);
    }
  });

  linkBtn?.addEventListener('click', () => {
    if (!fileUrlInput) return;
    const url = fileUrlInput.value.trim();
    if (!url) return;
    const extractedKey = extractFigmaFileKey(url);
    if (extractedKey) {
      log(`Linked file to key: ${extractedKey}`);
      activeFileKey = extractedKey;
      updateFileKeyUI();
      updatePluginBadge(true);
      window.parent.postMessage({ action: 'link-file', fileKey: extractedKey }, '*');
    } else {
      log('Error: Invalid Figma file URL.');
    }
  });

  togglePairingVisBtn?.addEventListener('click', () => {
    if (!pairingInput || !togglePairingVisBtn) return;
    const isHidden = pairingInput.type === 'password';
    pairingInput.type = isHidden ? 'text' : 'password';
    togglePairingVisBtn.setAttribute(
      'aria-label',
      isHidden ? 'Hide pairing ID' : 'Show pairing ID'
    );
    togglePairingVisBtn.innerHTML = isHidden
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  });

  // Target Theme Toggle Button Click Handler (Cycle System -> Light -> Dark -> System)
  themeToggleBtn?.addEventListener('click', () => {
    let next: 'system' | 'light' | 'dark' = 'system';
    if (currentThemeSetting === 'system') next = 'light';
    else if (currentThemeSetting === 'light') next = 'dark';
    else if (currentThemeSetting === 'dark') next = 'system';

    currentThemeSetting = next;
    try {
      localStorage.setItem('syncingboard_theme', next);
    } catch {
      // Sandbox
    }
    updateThemeUI(next);
    applyTheme(next === 'system' ? 'os' : next);
  });

  window.addEventListener('pagehide', () => {
    const pid = currentPairingId;
    if (pid) {
      sendReleaseBeacon(relayUrl, pid, companionTabId);
    }
    currentPairingId = '';
    void disconnectAbly();
  });

  // Listen to messages from host plugin wrapper
  window.addEventListener('message', (event: MessageEvent) => {
    const response = event.data;
    if (!isHostMessage(response)) return;

    if (response.action === 'ui-ready') {
      updatePluginBadge(true);
    }

    if (response.action === 'theme-change') {
      if (currentThemeSetting === 'system') {
        applyTheme(response.theme);
      }
      updatePluginBadge(true);
    }

    if (response.action === 'selection-changed-locally') {
      const d = response.data;
      const name = d && d.name ? d.name : 'None';
      log(`Selected node: ${name}`);
      updateSelectionCard(d);

      // Stream selection for live relay-pull
      if (ablyChannel && currentPairingId && d && d.id) {
        const streamPayload = encodeSelectionStream(d.name || '', d.id, d.fileKey || activeFileKey);
        ablyChannel
          .publish('selection', streamPayload)
          .then(() => {
            log(`Selection published to ${currentPairingId}: ${name}`);
          })
          .catch((e: unknown) => {
            const eMsg = e instanceof Error ? e.message : String(e);
            log(`Ably publish failed: ${eMsg}`);
          });
      }
    }

    if (response.action === 'selection-result') {
      if (response.data) {
        updateSelectionCard(response.data);
      }
      const request = pendingRequests.take(response.requestId);
      if (request) {
        void submitRelayResult({
          relayUrl,
          pairingId: currentPairingId,
          requestId: request.id,
          data: response.data,
          platform,
          ablyChannel,
        });
        const count = response.selectionCount || 0;
        log(
          `Selection returned: ${response.data ? response.data.name : 'None selected'}${
            platform === 'figma' ? ` (Figma saw ${count} selected items)` : ''
          }`
        );
      }
    }

    if (response.action === 'export-result' && platform === 'penpot') {
      const request = pendingRequests.take(response.requestId);
      if (request) {
        if (response.error) {
          void submitRelayResult({
            relayUrl,
            pairingId: currentPairingId,
            requestId: request.id,
            error: response.error,
            platform,
            ablyChannel,
          });
          log(`Export failed: ${response.error}`);
        } else {
          void submitRelayResult({
            relayUrl,
            pairingId: currentPairingId,
            requestId: request.id,
            data: response.data,
            platform,
            ablyChannel,
          });
          log('Export payload transmitted to Miro.');
        }
      }
    }
  });

  // Active selection polling
  function requestCurrentSelection(): void {
    window.parent.postMessage({ action: 'get-selection', requestId: 'local-init' }, '*');
  }

  // Startup initialization
  let savedTheme = 'system';
  try {
    const raw = localStorage.getItem('syncingboard_theme');
    if (raw === 'system' || raw === 'light' || raw === 'dark') {
      savedTheme = raw;
    }
  } catch {
    // Sandbox
  }
  currentThemeSetting = savedTheme as 'system' | 'light' | 'dark';
  updateThemeUI(currentThemeSetting);
  applyTheme(currentThemeSetting === 'system' ? 'os' : currentThemeSetting);
  updateFileKeyUI();

  // Handshake with parent wrapper
  window.parent.postMessage({ action: 'ui-ready' }, '*');
  requestCurrentSelection();
  window.addEventListener('focus', requestCurrentSelection);

  if (platform === 'penpot') {
    setTimeout(() => {
      window.parent.postMessage({ action: 'ui-ready' }, '*');
      requestCurrentSelection();
    }, 300);
    setTimeout(() => {
      requestCurrentSelection();
    }, 800);

    // Continuous 1s real-time selection polling for Penpot canvas
    const penpotPollInterval = setInterval(requestCurrentSelection, 1000);
    window.addEventListener('pagehide', () => {
      clearInterval(penpotPollInterval);
    });
  }

  // Restore saved pairing ID
  let savedId: string | null = null;
  try {
    savedId = localStorage.getItem('syncingboard_pairing_id');
  } catch {
    // Sandbox blocked
  }

  if (savedId && isValidPairingId(savedId)) {
    if (pairingInput) pairingInput.value = savedId;
    if (platform === 'penpot') {
      void connectBridge(false);
    }
  }
}
