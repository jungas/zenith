/**
 * PWA plumbing: service-worker registration, install prompt, update prompt and
 * online/offline status.
 */

import { toast } from './ui/toast.ts';
import { isEmbedded } from './core/model.ts';

/** The install prompt event, which is not in the standard DOM lib. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface InstallState {
  installed: boolean;
  canPrompt: boolean;
  updateReady: boolean;
  online: boolean;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let updateReady: ServiceWorker | null = null;
let registration: ServiceWorkerRegistration | null = null;
const listeners = new Set<(state: InstallState) => void>();

/**
 * How often to look for a new version while the app stays open.
 *
 * Registering the worker asks the browser to check once, at page load — and
 * that is the *only* check there was, which meant an app left open never
 * learned about a deploy. You had to reload to be told to reload.
 *
 * The check is a conditional request for Zenith's own `sw.js`. It sends
 * nothing: there is still no account, no sync and no data leaving the device.
 */
const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000;

export function onPwaChange(listener: (state: InstallState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of [...listeners]) listener(installState());
}

export function installState(): InstallState {
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return {
    installed: standalone,
    canPrompt: Boolean(deferredPrompt),
    updateReady: Boolean(updateReady),
    online: navigator.onLine,
  };
}

export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) return false;
  const prompt = deferredPrompt;
  deferredPrompt = null;
  emit();
  void prompt.prompt();
  const { outcome } = await prompt.userChoice;
  if (outcome === 'accepted') toast('Zenith installed.', { tone: 'success' });
  return outcome === 'accepted';
}

export function applyUpdate(): void {
  if (!updateReady) return;
  updateReady.postMessage({ type: 'SKIP_WAITING' });
  updateReady = null;
}

/**
 * Ask whether a new version has been published.
 *
 * Safe to call often — the browser answers from its own cache headers, and a
 * failure (offline, most likely) is not worth reporting: this app works
 * offline, so being unable to check for an update changes nothing.
 */
export function checkForUpdate(): void {
  void registration?.update().catch(() => {});
}

export function initPwa(): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    emit();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    emit();
  });

  window.addEventListener('online', () => {
    emit();
    toast('Back online.', { tone: 'success' });
  });
  window.addEventListener('offline', () => {
    emit();
    toast('Offline — everything still works, your data is on this device.', { tone: 'info' });
  });

  if (!('serviceWorker' in navigator)) return;
  // file:// has no origin a worker can be scoped to; skip rather than throw.
  if (window.location.protocol === 'file:') return;
  // The single-file build has no separate worker script to point at.
  if (isEmbedded()) return;

  window.addEventListener('load', () => {
    void (async () => {
    try {
      registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      const active = registration;

      // Look again when the app comes back to the foreground, and periodically
      // while it stays there. Without this the only check ever made is the one
      // above, so a tab left open — or an installed app never closed — sits on
      // an old version indefinitely.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate();
      });
      window.addEventListener('focus', checkForUpdate);
      setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL);

      active.addEventListener('updatefound', () => {
        const installing = active.installing;
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            updateReady = installing;
            emit();
            // The toast is the nudge, not the only way through: it lasts
            // seconds, and `updateReady` keeps a button in the header and a row
            // in Settings for anyone who was not looking.
            toast('A new version of Zenith is ready.', {
              tone: 'info',
              duration: 12_000,
              action: { label: 'Reload', onClick: applyUpdate },
            });
          }
        });
      });

      // A worker that finished installing before this page loaded is already
      // waiting, and fires no `updatefound` — without this it would go
      // unnoticed until the next reload, which is the thing being fixed.
      if (active.waiting && navigator.serviceWorker.controller) {
        updateReady = active.waiting;
        emit();
      }

      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
      });
      } catch (error) {
        console.warn('Service worker registration failed — the app still works online.', error);
      }
    })();
  });
}
