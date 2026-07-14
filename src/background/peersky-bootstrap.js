/**
 * Peersky hosts run Ghostery without the onboarding flow. The DNR module only
 * enables filter rulesets after options.terms is set.
 */
import { store } from 'hybrids';

import Options from '/store/options.js';

export function isEmbeddedHost() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /Electron|Peersky/i.test(ua);
}

export async function bootstrapEmbedded() {
  try {
    const { options = {}, managedConfig } = await chrome.storage.local.get([
      'options',
      'managedConfig',
    ]);

    if (options.terms === false) return;

    if (!managedConfig?.disableOnboarding) {
      await chrome.storage.local.set({
        managedConfig: {
          ...(managedConfig || {}),
          disableOnboarding: true,
        },
      });
    }

    if (!options.terms) {
      await store.set(Options, {
        terms: true,
        blockAds: true,
        blockTrackers: true,
        blockAnnoyances: true,
        onboarding: true,
      });
    }
  } catch (e) {
    console.warn('[peersky-bootstrap] Failed:', e);
  }
}
