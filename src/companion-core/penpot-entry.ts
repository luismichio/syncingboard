/**
 * Penpot Companion UI Entry Point
 */

import { initCompanionRuntime } from './runtime';

if (typeof window !== 'undefined') {
  initCompanionRuntime({
    platform: 'penpot',
    title: 'SyncingBoard Companion UI',
  });
}
