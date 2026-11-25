// SyncingBoard Companion Plugin - Penpot background runner
penpot.ui.open('SyncingBoard Companion', './penpot-companion-ui.html', {
  width: 320,
  height: 700,
});

function normalizeTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  if (theme === 'os' || theme === 'system' || theme === 'auto') return 'os';
  return 'dark';
}

let currentTheme = normalizeTheme(penpot.theme);

function sendTheme() {
  penpot.ui.sendMessage({
    action: 'theme-change',
    theme: currentTheme,
  });
}

// Fallback push in case UI is already mounted.
setTimeout(() => {
  sendTheme();
  broadcastSelection();
}, 300);

setTimeout(() => {
  broadcastSelection();
}, 800);

// Keep UI in sync with runtime theme changes.
penpot.on('themechange', (theme) => {
  currentTheme = normalizeTheme(theme);
  sendTheme();
});

function broadcastSelection() {
  try {
    const list = penpot.selection;
    const item = Array.isArray(list) && list.length > 0 ? list[0] : null;
    const fileId = penpot.currentFile ? penpot.currentFile.id : (penpot.currentFileId || penpot.fileId || 'penpot-doc');

    let selId = null;
    let selName = null;
    let selWidth = 0;
    let selHeight = 0;
    let selType = null;
    let selGitMeta = null;

    if (item && typeof item === 'object') {
      selId = item.id;
      selName = item.name || 'Untitled Shape';
      selType = item.type || null;
      try {
        if (typeof item.getPluginData === 'function') {
          const raw = item.getPluginData('syncboard-git');
          if (raw) selGitMeta = JSON.parse(raw);
        }
      } catch {
        // ignore invalid metadata
      }
      if (item.selrect) {
        selWidth = Math.round(item.selrect.width || 0);
        selHeight = Math.round(item.selrect.height || 0);
      } else if (typeof item.width === 'number') {
        selWidth = Math.round(item.width);
        selHeight = Math.round(item.height || 0);
      }
    } else if (typeof item === 'string') {
      selId = item;
      if (penpot.currentPage && typeof penpot.currentPage.getShapeById === 'function') {
        const shape = penpot.currentPage.getShapeById(item);
        if (shape) {
          selName = shape.name || 'Untitled Shape';
          selType = shape.type || null;
          try {
            if (typeof shape.getPluginData === 'function') {
              const raw = shape.getPluginData('syncboard-git');
              if (raw) selGitMeta = JSON.parse(raw);
            }
          } catch {
            // ignore
          }
          if (shape.selrect) {
            selWidth = Math.round(shape.selrect.width || 0);
            selHeight = Math.round(shape.selrect.height || 0);
          }
        }
      }
    }

    penpot.ui.sendMessage({
      action: 'selection-changed-locally',
      data: selId
        ? {
            id: selId,
            name: selName || 'Untitled Shape',
            fileId: fileId,
            width: selWidth,
            height: selHeight,
            shapeType: selType,
            gitMeta: selGitMeta,
          }
        : null,
    });
  } catch (err) {
    // Fallback silent
  }
}

// Keep UI in sync with live canvas selection changes.
penpot.on('selectionchange', () => {
  broadcastSelection();
});

async function findShapeById(shapeId) {
  // 1. Check active selection first (fastest and most reliable)
  if (penpot.selection && penpot.selection.length > 0) {
    const selMatch = penpot.selection.find((s) => s && s.id === shapeId);
    if (selMatch) return selMatch;
    // Do NOT fall back to the current selection if shapeId doesn't match.
    // The stored nodeId in SyncingBoard metadata is the source of truth.
  }

  // 2. Use official getShapeById API on current page (O(1) internal map lookup)
  //    This is synchronous and much faster than tree walking.
  if (penpot.currentPage && typeof penpot.currentPage.getShapeById === 'function') {
    const found = penpot.currentPage.getShapeById(shapeId);
    if (found) return found;
  }

  // 3. Cross-page search via official getShapeById API (O(1) per page)
  const allPages = penpot.pages || (penpot.currentFile && penpot.currentFile.pages);
  if (allPages && Array.isArray(allPages)) {
    for (const page of allPages) {
      if (page === penpot.currentPage) continue;
      if (typeof page.getShapeById === 'function') {
        const found = page.getShapeById(shapeId);
        if (found) {
          return found;
        }
      }
    }
  }

  // 4. Fallback: recursive tree walk (for older Penpot instances without getShapeById)
  function search(node) {
    if (!node) return null;
    if (node.id === shapeId) return node;
    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        const found = search(child);
        if (found) return found;
      }
    }
    return null;
  }

  if (penpot.currentPage && penpot.currentPage.root) {
    const found = search(penpot.currentPage.root);
    if (found) return found;
  }

  if (allPages && Array.isArray(allPages)) {
    for (const page of allPages) {
      if (page === penpot.currentPage || !page.root) continue;
      const found = search(page.root);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

async function exportShapeBuffer(shapeId, format, scale) {
  // Preload: if the shape is on a different page, navigate there so WASM
  // has the shape data cached and export is instant (<1s) instead of a
  // 10-60s main-thread freeze. After export, navigate back to the original
  // page so the user's workspace is not disrupted.
  const originalPageId = penpot.currentPage ? penpot.currentPage.id : null;
  if (typeof penpot.openPage === 'function' && originalPageId) {
    const allPages = penpot.pages || (penpot.currentFile && penpot.currentFile.pages);
    if (allPages && Array.isArray(allPages)) {
      for (const page of allPages) {
        if (page.id === originalPageId) continue;
        if (typeof page.getShapeById === 'function') {
          const found = page.getShapeById(shapeId);
          if (found) {
            await penpot.openPage(page);
            break;
          }
        }
      }
    }
  }

  // Run the actual export (await the full result so WASM data is captured
  // before any page navigation happens).
  const shapeFromPage = await findShapeById(shapeId);
  let result;
  if (shapeFromPage && typeof shapeFromPage.export === 'function') {
    result = await shapeFromPage.export({ type: format, scale });
  } else if (shapeFromPage && typeof shapeFromPage.exportShape === 'function') {
    result = await shapeFromPage.exportShape({ format, scale });
  } else if (typeof penpot.export === 'function') {
    result = await penpot.export(shapeId, { format, scale });
  } else {
    throw new Error(`Penpot shape "${shapeId}" export API unavailable. Ensure a valid frame or shape is selected in Penpot.`);
  }

  // Navigate back after export data is fully captured in memory.
  if (originalPageId && typeof penpot.openPage === 'function') {
    await penpot.openPage(originalPageId).catch(() => {});
  }

  return result;
}

// Listen to messages from the UI Iframe
penpot.ui.onMessage(async (message) => {
  if (!message || typeof message !== 'object') return;

  if (message.action === 'ui-ready') {
    sendTheme();
    broadcastSelection();
    return;
  }

  if (message.action === 'get-selection') {
    const selection = penpot.selection[0];
    const fileId = penpot.currentFile ? penpot.currentFile.id : (penpot.currentFileId || penpot.fileId || 'penpot-doc');

    let selWidth = 0;
    let selHeight = 0;
    if (selection && selection.selrect) {
      selWidth = Math.round(selection.selrect.width);
      selHeight = Math.round(selection.selrect.height);
    }

    penpot.ui.sendMessage({
      action: 'selection-result',
      requestId: message.requestId,
      data: selection
        ? {
            id: selection.id,
            name: selection.name,
            fileId: fileId,
            width: selWidth,
            height: selHeight,
          }
        : null,
    });
  }

  if (message.action === 'export-shape' || message.action === 'export-frame') {
    try {
      const format = message.format === 'png' ? 'png' : 'svg';
      const scale = typeof message.scale === 'number' && Number.isFinite(message.scale) ? message.scale : 2;
      const targetId = message.shapeId || message.nodeId || (penpot.selection && penpot.selection[0] ? penpot.selection[0].id : null);
      if (!targetId) {
        throw new Error('No Penpot shape selected or specified for export.');
      }
      const buffer = await exportShapeBuffer(targetId, format, scale);

      // Get the shape name and natural dimensions so the Miro / FigJam plugin can
      // create the widget at the correct display size regardless of scale.
      let shapeName = null;
      let shapeWidth = 0;
      let shapeHeight = 0;
      try {
        const shapeFromPage = await findShapeById(targetId);
        if (shapeFromPage) {
          if (shapeFromPage.name) shapeName = shapeFromPage.name;
          if (shapeFromPage.selrect && typeof shapeFromPage.selrect.width === 'number') {
            shapeWidth = Math.round(shapeFromPage.selrect.width);
            shapeHeight = Math.round(shapeFromPage.selrect.height);
          }
        }
      } catch (e) {
        // Silently fall back — name stays null, Miro plugin uses existing widget name
      }

      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

      if (format === 'svg') {
        // TextDecoder may not be available in the Penpot plugin sandbox;
        // use fromCharCode + decodeURIComponent as a portable fallback.
        let svgText;
        if (typeof TextDecoder !== 'undefined') {
          try {
            svgText = new TextDecoder().decode(bytes);
          } catch (_) {
            svgText = null;
          }
        }
        if (!svgText) {
          let raw = '';
          for (let i = 0; i < bytes.byteLength; i++) {
            raw += String.fromCharCode(bytes[i]);
          }
          svgText = decodeURIComponent(escape(raw));
        }
        penpot.ui.sendMessage({
          action: 'export-result',
          requestId: message.requestId,
          data: { svg: svgText, name: shapeName, width: shapeWidth, height: shapeHeight },
        });
      } else {
        // Base64 encode PNG binary
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        penpot.ui.sendMessage({
          action: 'export-result',
          requestId: message.requestId,
          data: { base64, name: shapeName, width: shapeWidth, height: shapeHeight },
        });
      }
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      penpot.ui.sendMessage({
        action: 'export-result',
        requestId: message.requestId,
        error: messageText,
      });
    }
    return;
  }

  // ---- Penpot GitHub Docs-as-Code Text Sync Handlers ----
  const safeSet = (target, prop, value) => {
    if (!target || value === undefined || value === null || value === '' || value === 'mixed') return;
    try {
      target[prop] = value;
    } catch {
      // Ignore unsupported property on this Penpot version
    }
  };

  /**
   * Applies Markdown character-range styles to a Penpot Text shape using the
   * 3-step Penpot 2.19.x safe sequence:
   *   1. Headings (fontSize BEFORE fontWeight, each set once)
   *   2. Non-heading gaps clamped to 14/400 (prevents Penpot heading bleed)
   *   3. Inline bold / italic / code spans
   */
  const applyStyledPenpotText = (shape, characters, ranges, isUpdate) => {
    const safeChars = typeof characters === 'string' ? characters : '';
    if (isUpdate) {
      shape.characters = safeChars;
    }
    if (typeof shape.getRange !== 'function' || safeChars.length === 0) {
      return shape;
    }

    // On in-place update, clear stale italic/code/bold/size across the whole range first
    if (isUpdate) {
      try {
        const full = shape.getRange(0, safeChars.length);
        if (full) {
          safeSet(full, 'fontSize', '14');
          safeSet(full, 'fontWeight', '400');
          safeSet(full, 'fontStyle', 'normal');
          safeSet(full, 'fontFamily', 'Source Sans Pro');
        }
      } catch {
        // ignore
      }
    }

    if (!Array.isArray(ranges)) return shape;

    const validRanges = ranges
      .filter((r) => r && typeof r.start === 'number' && typeof r.end === 'number')
      .map((r) => ({
        start: Math.max(0, Math.min(safeChars.length, r.start)),
        end: Math.max(0, Math.min(safeChars.length, r.end)),
        bold: Boolean(r.bold),
        italic: Boolean(r.italic),
        code: Boolean(r.code),
        headingLevel: typeof r.headingLevel === 'number' && r.headingLevel >= 1 ? r.headingLevel : 0,
      }))
      .filter((r) => r.end > r.start);

    // 1. Apply heading ranges first (fontSize BEFORE fontWeight, each set once)
    const headingRanges = validRanges
      .filter((r) => r.headingLevel >= 1)
      .sort((a, b) => a.start - b.start);
    for (const r of headingRanges) {
      try {
        const range = shape.getRange(r.start, r.end);
        if (!range) continue;
        const headingSize =
          r.headingLevel === 1 ? '24' : r.headingLevel === 2 ? '20' : r.headingLevel === 3 ? '17' : '15';
        safeSet(range, 'fontSize', headingSize);
        safeSet(range, 'fontWeight', '700');
      } catch {
        // Ignore unsupported range style properties
      }
    }

    // 2. Explicitly clamp all non-heading gaps to 14/400 (prevents Penpot 2.19.x
    //    rich-text engine from leaking heading size/weight into sibling paragraphs)
    if (headingRanges.length > 0) {
      let cursor = 0;
      for (const r of headingRanges) {
        if (r.start > cursor) {
          try {
            const gap = shape.getRange(cursor, r.start);
            if (gap) {
              safeSet(gap, 'fontSize', '14');
              safeSet(gap, 'fontWeight', '400');
            }
          } catch {
            // ignore
          }
        }
        cursor = Math.max(cursor, r.end);
      }
      if (cursor < safeChars.length) {
        try {
          const gap = shape.getRange(cursor, safeChars.length);
          if (gap) {
            safeSet(gap, 'fontSize', '14');
            safeSet(gap, 'fontWeight', '400');
          }
        } catch {
          // ignore
        }
      }
    }

    // 3. Apply inline bold / italic / code spans
    for (const r of validRanges) {
      if (r.headingLevel >= 1) continue;
      if (!r.bold && !r.italic && !r.code) continue;
      try {
        const range = shape.getRange(r.start, r.end);
        if (!range) continue;
        if (r.bold) safeSet(range, 'fontWeight', '700');
        if (r.italic) safeSet(range, 'fontStyle', 'italic');
        if (r.code) safeSet(range, 'fontFamily', 'JetBrains Mono');
      } catch {
        // Ignore unsupported range style properties
      }
    }

    return shape;
  };

  if (message.action === 'scan-git-shapes') {
    try {
      const page = penpot.currentPage;
      const textShapes = page && typeof page.findShapes === 'function'
        ? page.findShapes({ type: 'text' })
        : [];
      const found = [];
      for (const s of textShapes) {
        let meta = null;
        try {
          if (typeof s.getPluginData === 'function') {
            const raw = s.getPluginData('syncboard-git');
            if (raw) meta = JSON.parse(raw);
          }
        } catch {
          // ignore
        }
        const name = s.name || '';
        const hasConvention = /^#?git:/i.test(name);
        if (meta || hasConvention) {
          found.push({
            id: s.id,
            name,
            meta,
          });
        }
      }
      penpot.ui.sendMessage({
        action: 'scan-git-shapes-result',
        requestId: message.requestId,
        data: found,
      });
    } catch (err) {
      penpot.ui.sendMessage({
        action: 'scan-git-shapes-result',
        requestId: message.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (message.action === 'create-git-text') {
    try {
      if (typeof penpot.createText !== 'function') {
        throw new Error('penpot.createText is unavailable (check content:write permission)');
      }
      const chars = typeof message.characters === 'string' ? message.characters : '';
      const shape = penpot.createText(chars || ' ');
      if (!shape) throw new Error('Failed to create Penpot text shape');
      applyStyledPenpotText(shape, chars, message.ranges, false);
      // Match Miro/FigJam's 480px wrapped column default.
      // Penpot gotcha: resize() forces growType='fixed', so set growType AFTER resize().
      if (typeof shape.resize === 'function') {
        try {
          shape.resize(480, Math.max(80, shape.height || 80));
        } catch {
          // ignore
        }
      }
      safeSet(shape, 'growType', 'auto-height');
      if (penpot.viewport && penpot.viewport.center) {
        shape.x = Math.round(penpot.viewport.center.x);
        shape.y = Math.round(penpot.viewport.center.y);
      }
      if (message.meta && message.meta.sectionHeading) {
        shape.name = String(message.meta.sectionHeading);
      }
      if (typeof shape.setPluginData === 'function' && message.meta) {
        shape.setPluginData('syncboard-git', JSON.stringify(message.meta));
      }
      penpot.selection = [shape];
      broadcastSelection();
      penpot.ui.sendMessage({
        action: 'git-text-result',
        requestId: message.requestId,
        data: { id: shape.id, created: true },
      });
    } catch (err) {
      penpot.ui.sendMessage({
        action: 'git-text-result',
        requestId: message.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (message.action === 'update-git-text') {
    try {
      const targetId =
        message.shapeId ||
        (Array.isArray(penpot.selection) && penpot.selection[0] ? penpot.selection[0].id : null);
      if (!targetId) {
        throw new Error('Select a Penpot Text shape first.');
      }
      const shape = await findShapeById(targetId);
      if (!shape) {
        throw new Error(`Text shape ${targetId} not found.`);
      }
      if (shape.type !== 'text') {
        throw new Error(`Selected shape "${shape.name || targetId}" is type "${shape.type}", not a text shape.`);
      }
      const chars = typeof message.characters === 'string' ? message.characters : '';
      const prevGrowType = shape.growType;
      const prevW = typeof shape.width === 'number' ? shape.width : 0;
      const prevH = typeof shape.height === 'number' ? shape.height : 0;

      // Update in-place to preserve exact shape ID, fills, and layout constraints
      applyStyledPenpotText(shape, chars, message.ranges, true);

      // Re-assert box dimensions after character mutation.
      // Penpot gotcha: resize() forces growType='fixed', so ALWAYS set growType AFTER resize().
      if (typeof shape.resize === 'function' && prevW > 0) {
        try {
          if (prevGrowType === 'fixed' && prevH > 0) {
            shape.resize(prevW, prevH);
          } else if (prevGrowType === 'auto-height') {
            shape.resize(prevW, Math.max(40, shape.height || prevH || 40));
          }
        } catch {
          // ignore
        }
      }
      if (prevGrowType) safeSet(shape, 'growType', prevGrowType);
      if (message.meta && message.meta.sectionHeading) {
        shape.name = String(message.meta.sectionHeading);
      }
      if (typeof shape.setPluginData === 'function' && message.meta) {
        shape.setPluginData('syncboard-git', JSON.stringify(message.meta));
      }

      broadcastSelection();
      penpot.ui.sendMessage({
        action: 'git-text-result',
        requestId: message.requestId,
        data: { id: shape.id, updated: true },
      });
    } catch (err) {
      penpot.ui.sendMessage({
        action: 'git-text-result',
        requestId: message.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
});
