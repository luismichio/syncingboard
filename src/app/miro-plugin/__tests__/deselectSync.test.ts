import { describe, it, expect } from 'vitest';
import { SyncedImage } from '../useMiroSelection';
import { GroupedSyncedImage } from '../types';

function buildGroupedItems(selectedItems: SyncedImage[]): GroupedSyncedImage[] {
  const groups: Record<string, GroupedSyncedImage> = {};

  for (const item of selectedItems) {
    const key = `${item.fileKey}|${item.nodeId}`;
    if (!groups[key]) {
      const platform = item.platform || 'figma';
      const sourceUrl =
        platform === 'figma' && item.fileKey && item.nodeId
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

describe('Deselect Items from Sync List', () => {
  const sampleItems: SyncedImage[] = [
    { id: 'w1', title: 'Header [FigmaSync|file1|01:01]', fileKey: 'file1', nodeId: '01:01', nodeName: 'Header', platform: 'figma' },
    { id: 'w2', title: 'Footer [FigmaSync|file1|01:02]', fileKey: 'file1', nodeId: '01:02', nodeName: 'Footer', platform: 'figma' },
    { id: 'w3', title: 'Sidebar [FigmaSync|file1|01:03]', fileKey: 'file1', nodeId: '01:03', nodeName: 'Sidebar', platform: 'figma' },
    { id: 'w4', title: 'Hero [FigmaSync|file1|01:04]', fileKey: 'file1', nodeId: '01:04', nodeName: 'Hero', platform: 'figma' },
    { id: 'w5', title: 'Header Copy [FigmaSync|file1|01:01]', fileKey: 'file1', nodeId: '01:01', nodeName: 'Header', platform: 'figma' },
  ];

  it('groups items correctly before deselection', () => {
    const groups = buildGroupedItems(sampleItems);
    expect(groups).toHaveLength(4);
    const headerGroup = groups.find((g) => g.key === 'file1|01:01');
    expect(headerGroup).toBeDefined();
    expect(headerGroup?.widgets).toHaveLength(2);
  });

  it('filters out individual widgets by ID', () => {
    const deselectedIds = ['w2'];
    const active = sampleItems.filter((i) => !deselectedIds.includes(i.id));
    const groups = buildGroupedItems(active);

    expect(groups).toHaveLength(3);
    expect(groups.some((g) => g.nodeName === 'Footer')).toBe(false);
  });

  it('filters out entire multi-copy groups when all group widget IDs are deselected', () => {
    const deselectedIds = ['w1', 'w5']; // Both Header copies
    const active = sampleItems.filter((i) => !deselectedIds.includes(i.id));
    const groups = buildGroupedItems(active);

    expect(groups).toHaveLength(3);
    expect(groups.some((g) => g.key === 'file1|01:01')).toBe(false);
  });

  it('brings an over-the-limit selection (4 groups) down to allowable batch size (3 groups)', () => {
    // Initial: 4 unique frames (Header, Footer, Sidebar, Hero)
    const initialGroups = buildGroupedItems(sampleItems);
    expect(initialGroups.length > 3).toBe(true); // Exceeds 3-item limit

    // User clicks '✕' on Footer
    const deselectedIds = ['w2'];
    const active = sampleItems.filter((i) => !deselectedIds.includes(i.id));
    const finalGroups = buildGroupedItems(active);

    expect(finalGroups).toHaveLength(3);
    expect(finalGroups.length <= 3).toBe(true); // Now allowed to sync!
  });

  it('handles complete deselection gracefully', () => {
    const allIds = sampleItems.map((i) => i.id);
    const active = sampleItems.filter((i) => !allIds.includes(i.id));
    const groups = buildGroupedItems(active);

    expect(active).toHaveLength(0);
    expect(groups).toHaveLength(0);
  });
});
