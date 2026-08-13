#!/usr/bin/env node

/**
 * SyncingBoard Companion Bundler
 * Compiles modular TypeScript companion cores (src/companion-core/*)
 * into self-contained HTML bundles (public/figma-companion-ui.html & public/penpot-companion-ui.html).
 */

import fs from 'fs';
import path from 'path';
import esbuild from 'esbuild';

const ROOT_DIR = process.cwd();
const TEMPLATE_PATH = path.join(ROOT_DIR, 'src/companion-core/companion-template.html');
const PKG_PATH = path.join(ROOT_DIR, 'package.json');

const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'));
const versionString = `v${pkg.version} ${pkg.plan === 'pro' ? 'Pro' : 'Community'}`;

async function bundleEntry(entryPath) {
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2020',
    minify: false, // keep human-readable for review
    treeShaking: true,
  });

  return result.outputFiles[0].text;
}

async function buildCompanions() {
  console.log(`[build-companion] Building companion bundles for ${versionString}...`);

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');

  // 1. Build Figma Companion
  const figmaScript = await bundleEntry(path.join(ROOT_DIR, 'src/companion-core/figma-entry.ts'));
  const figmaHtml = template
    .replace(/<!-- TITLE -->/g, 'Figma Companion Relay')
    .replace(/<!-- BUILD_VERSION -->/g, versionString)
    .replace('<!-- SCRIPT_BUNDLE -->', figmaScript);

  const figmaOutPath = path.join(ROOT_DIR, 'public/figma-companion-ui.html');
  fs.writeFileSync(figmaOutPath, figmaHtml, 'utf-8');
  const figmaSize = (fs.statSync(figmaOutPath).size / 1024).toFixed(1);
  console.log(`  ✔ public/figma-companion-ui.html (${figmaSize} KB)`);

  // 2. Build Penpot Companion
  const penpotScript = await bundleEntry(path.join(ROOT_DIR, 'src/companion-core/penpot-entry.ts'));
  const penpotHtml = template
    .replace(/<!-- TITLE -->/g, 'SyncingBoard Companion UI')
    .replace(/<!-- BUILD_VERSION -->/g, versionString)
    .replace('<!-- SCRIPT_BUNDLE -->', penpotScript);

  const penpotOutPath = path.join(ROOT_DIR, 'public/penpot-companion-ui.html');
  fs.writeFileSync(penpotOutPath, penpotHtml, 'utf-8');
  const penpotSize = (fs.statSync(penpotOutPath).size / 1024).toFixed(1);
  console.log(`  ✔ public/penpot-companion-ui.html (${penpotSize} KB)`);

  console.log('[build-companion] Done.');
}

buildCompanions().catch((err) => {
  console.error('[build-companion] Build failed:', err);
  process.exit(1);
});
