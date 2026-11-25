'use client';

import { useEffect, useMemo, useState } from 'react';
import { useFigJamPlugin } from './useFigJamPlugin';
import { SyncedImage } from '@/app/miro-plugin/useMiroSelection';
import { getOrCreatePairingId, rotatePairingId } from '@/lib/sync/pairingId';
import { PLAN } from '@/lib/version';
import { AppHeader } from '@/app/miro-plugin/components/AppHeader';
import { TabNav } from '@/app/miro-plugin/components/TabNav';
import { BoardStatusFooter } from '@/app/miro-plugin/components/BoardStatusFooter';
import { SyncTab } from '@/app/miro-plugin/components/SyncTab';
import { ImportTab } from '@/app/miro-plugin/components/ImportTab';
import { SettingsTab } from '@/app/miro-plugin/components/SettingsTab';
import { VersionStamp } from '@/components/VersionStamp';
import {
  GroupedSyncedImage,
  ImportPlatform,
  MiroPluginTab,
} from '@/app/miro-plugin/types';
import { releaseLocalRelaySession } from '@/lib/sync/companionRelayClient';
import {
  getLastBridgeProbeDiagnostics,
  notifyTauriMiroConnect,
  probeTauriBridge,
} from '@/lib/sync/tauriBridgeClient';

const MAX_SCALE = PLAN === 'community' ? 2 : 4;
const AVAILABLE_SCALES = Array.from({ length: MAX_SCALE }, (_, i) => i + 1);

function buildGroupedItems(selectedItems: SyncedImage[]): GroupedSyncedImage[] {
  const groups: Record<string, GroupedSyncedImage> = {};
  for (const item of selectedItems) {
    const key = `${item.fileKey}|${item.nodeId}`;
    if (!groups[key]) {
      const platform = item.platform || 'figma';
      const sourceUrl =
        platform === 'github'
          ? item.fileKey
          : platform === 'figma' && item.fileKey && item.nodeId
            ? `https://www.figma.com/file/${item.fileKey}/?node-id=${encodeURIComponent(item.nodeId)}`
            : undefined;
      groups[key] = {
        key,
        fileKey: item.fileKey,
        nodeId: item.nodeId,
        nodeName: item.nodeName,
        format: item.format || (platform === 'penpot' ? 'svg' : 'png'),
        scale: item.scale || 2,
        url: sourceUrl,
        widgets: [],
        platform,
      };
    }
    groups[key].widgets.push({ id: item.id });
  }
  return Object.values(groups);
}

export default function FigJamPluginPage() {
  const hook = useFigJamPlugin();
  const [activeTab, setActiveTab] = useState<MiroPluginTab>('sync');
  const [importPlatform, setImportPlatform] = useState<ImportPlatform>('figma');
  const [importFormat, setImportFormat] = useState<'png' | 'svg'>('png');
  const [importScale, setImportScale] = useState<number>(1);
  const [defaultPngScale, setDefaultPngScale] = useState<number>(1);
  const [copiedPairing, setCopiedPairing] = useState(false);
  const [pairingId, setPairingId] = useState<string>('');
  const [useTauri, setUseTauri] = useState<boolean>(false);
  const [figmaConnected, setFigmaConnected] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raf = window.requestAnimationFrame(() => {
      const savedScaleRaw = localStorage.getItem('default_png_scale');
      const parsed = savedScaleRaw ? Number(savedScaleRaw) : 1;
      const safe = Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_SCALE ? parsed : 1;
      setDefaultPngScale(safe);
      setImportScale(safe);
      setUseTauri(localStorage.getItem('syncingboard_use_tauri') === 'true');
      setPairingId(getOrCreatePairingId());
    });
    return () => window.cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const wantsTauri = typeof window !== 'undefined' && localStorage.getItem('syncingboard_use_tauri') === 'true';
    if (!useTauri && !wantsTauri) return;
    const check = async () => {
      if (localStorage.getItem('syncingboard_use_tauri') !== 'true') return;
      const health = await probeTauriBridge(3000);
      if (health && health.status === 'ok') {
        if (!useTauri) {
          setUseTauri(true);
          releaseLocalRelaySession();
          void notifyTauriMiroConnect();
        }
        setFigmaConnected(health.figmaConnected === true);
      } else {
        setUseTauri(false);
        setFigmaConnected(false);
      }
    };
    void check();
    const interval = setInterval(check, 15_000);
    return () => clearInterval(interval);
  }, [useTauri]);

  const handleToggleTauri = async () => {
    if (useTauri) {
      setUseTauri(false);
      setFigmaConnected(false);
      localStorage.setItem('syncingboard_use_tauri', 'false');
    } else {
      const health = await probeTauriBridge(2000);
      if (health && health.status === 'ok') {
        setUseTauri(true);
        setFigmaConnected(health.figmaConnected === true);
        localStorage.setItem('syncingboard_use_tauri', 'true');
        releaseLocalRelaySession();
        void notifyTauriMiroConnect();
      } else {
        const diag = getLastBridgeProbeDiagnostics();
        const details = diag.length > 0 ? `\n\nDiagnostics:\n${diag.join('\n')}` : '';
        alert(
          `Could not reach SyncingBridge on localhost:4401 or 127.0.0.1:4401. Make sure SyncingBridge is running.${details}`
        );
      }
    }
  };

  const copyPairingId = (): void => {
    const text = pairingId;
    if (!text) return;
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        /* ignore */
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => setCopiedPairing(true))
        .catch(fallback);
    } else {
      fallback();
    }
    setCopiedPairing(true);
    setTimeout(() => setCopiedPairing(false), 2000);
  };

  const handleDefaultPngScaleChange = (value: number): void => {
    setDefaultPngScale(value);
    localStorage.setItem('default_png_scale', String(value));
  };

  const groupedItems = useMemo(() => buildGroupedItems(hook.selectedItems), [hook.selectedItems]);

  const onGroupSettingChange = (ids: string[], key: 'format' | 'scale', value: unknown): void => {
    hook.applyGroupSettings(ids, key, value);
  };

  const onGitHubSectionChange = async (
    itemIds: string[],
    sectionId: string,
    sectionTitle: string
  ): Promise<void> => {
    const match = hook.selectedItems.find((i) => itemIds.includes(i.id));
    const url = match?.fileKey || '';
    if (!url) return;
    await hook.githubDocs.retargetGitHubSection(itemIds, url, sectionId, sectionTitle);
  };

  const onGitHubBranchChange = async (
    itemIds: string[],
    nextUrl: string,
    nextBranch: string
  ): Promise<void> => {
    await hook.githubDocs.retargetGitHubBranch(itemIds, nextUrl, nextBranch);
  };

  const onRefreshNodeName = async (): Promise<void> => {
    // Node name refreshes flow through the Figma source during the next sync.
  };

  return (
    <div className="flex flex-col min-h-screen p-5 bg-bg-page text-text-page font-sans selection:bg-accent selection:text-bg-page transition-colors duration-200">
      <AppHeader tokensLoading={hook.tokensLoading} figmaToken={hook.figmaToken} miroToken={null} useTauri={useTauri} hideMiro />
      <TabNav activeTab={activeTab} selectedItemsCount={hook.selectedItems.length} onTabChange={setActiveTab} />
      <section className="flex-grow flex flex-col">
        {activeTab === 'sync' && (
          <SyncTab
            selectedItemsCount={hook.selectedItems.length}
            groupedItems={groupedItems}
            syncAllCopies={hook.syncAllCopies}
            setSyncAllCopies={hook.setSyncAllCopies}
            preserveSize={hook.preserveSize}
            setPreserveSize={hook.setPreserveSize}
            propagate={hook.propagate}
            setPropagate={hook.setPropagate}
            isSyncing={hook.isSyncing}
            cooldownSeconds={hook.cooldownSeconds}
            hasMiroToken={true}
            onSync={hook.syncSelectedScreens}
            onGroupSettingChange={onGroupSettingChange}
            onGitHubSectionChange={onGitHubSectionChange}
            onGitHubBranchChange={onGitHubBranchChange}
            onRefreshNodeName={onRefreshNodeName}
            onRemoveGroup={hook.handleDeselectGroup}
            availableScales={AVAILABLE_SCALES}
            mirrorMode
          />
        )}
        {activeTab === 'import' && (
          <ImportTab
            hasMiroToken={true}
            importPlatform={importPlatform}
            setImportPlatform={setImportPlatform}
            importFormat={importFormat}
            setImportFormat={setImportFormat}
            importScale={importScale}
            setImportScale={setImportScale}
            availableScales={AVAILABLE_SCALES}
            isSyncing={hook.isSyncing}
            isAnyImageSelected={hook.isAnyImageSelected}
            preserveSize={hook.preserveSize}
            setPreserveSize={hook.setPreserveSize}
            figmaToken={hook.figmaToken}
            figmaInput={hook.figmaInput}
            figmaParseError={hook.figmaParseError}
            figmaNodeInfo={hook.figmaNodeInfo}
            isDetectingLocal={hook.isDetectingLocal}
            parseFigmaLink={hook.parseFigmaLink}
            detectLocalFigmaSelection={hook.detectLocalFigmaSelection}
            importFigmaScreen={hook.importFigmaScreen}
            mirrorMode
            penpotNodeInfo={hook.penpotNodeInfo}
            isDetectingPenpotLocal={hook.isDetectingPenpotLocal}
            detectLocalPenpotSelection={hook.detectLocalPenpotSelection}
            importPenpotScreen={hook.importPenpotScreen}
            replaceSelectedWidget={hook.replaceSelectedWidget}
            onResetCache={hook.resetRenderCache}
            onClearFigmaNodeInfo={hook.resetImportState}
            onClearPenpotNodeInfo={hook.resetImportState}
            githubDocs={{
              githubUrl: hook.githubDocs.githubUrl,
              setGithubUrl: hook.githubDocs.setGithubUrl,
              githubPat: hook.githubDocs.githubPat,
              updateGithubPat: hook.githubDocs.setGithubPat,
              docData: hook.githubDocs.docData,
              selectedSectionId: hook.githubDocs.selectedSectionId,
              setSelectedSectionId: hook.githubDocs.setSelectedSectionId,
              isLoadingDoc: hook.githubDocs.isLoadingDoc,
              isSyncingDocs: hook.githubDocs.isSyncingDocs,
              docError: hook.githubDocs.docError,
              loadGitHubDoc: hook.githubDocs.loadDoc,
              placeTextOnBoard: hook.githubDocs.placeAsText,
              bindSelectedTextWidget: hook.githubDocs.bindSelectedWidgets,
              syncSelectedGitHubDocs: hook.syncSelectedScreens,
              branches: hook.githubDocs.branches,
              switchBranch: hook.githubDocs.switchBranch,
            }}
          />
        )}
        {activeTab === 'settings' && (
          <SettingsTab
            tokensLoading={hook.tokensLoading}
            figmaToken={hook.figmaToken}
            miroToken={null}
            githubToken={hook.githubToken}
            connectFigma={hook.connectFigma}
            connectMiro={() => {}}
            connectGithub={hook.connectGithub}
            disconnectFigma={hook.disconnectFigma}
            disconnectMiro={hook.disconnectMiro}
            disconnectGithub={hook.disconnectGithub}
            hideMiro
            copiedPairing={copiedPairing}
            pairingId={pairingId}
            copyPairingId={copyPairingId}
            onRegeneratePairingId={() => {
              setPairingId(rotatePairingId());
              setCopiedPairing(false);
            }}
            useTauri={useTauri}
            onToggleTauri={handleToggleTauri}
            figmaConnected={figmaConnected}
            defaultPngScale={defaultPngScale}
            onDefaultPngScaleChange={handleDefaultPngScaleChange}
            availableScales={AVAILABLE_SCALES}
          />
        )}
      </section>
      <footer className="mt-4 pt-3 border-t border-border-card">
        <VersionStamp />
      </footer>
      <BoardStatusFooter status={hook.syncStatus} />
    </div>
  );
}