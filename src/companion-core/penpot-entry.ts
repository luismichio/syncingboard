/**
 * Penpot Companion UI Entry Point
 */

import { initCompanionRuntime } from './runtime';
import { initPenpotDocs } from './penpotDocs';

if (typeof window !== 'undefined') {
  initCompanionRuntime({
    platform: 'penpot',
    title: 'SyncingBoard Companion UI',
  });
  initPenpotDocs();
}
