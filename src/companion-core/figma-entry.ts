/**
 * Figma Companion UI Entry Point
 */

import { initCompanionRuntime } from './runtime';

if (typeof window !== 'undefined') {
  initCompanionRuntime({
    platform: 'figma',
    title: 'Figma Companion Relay',
  });
}
