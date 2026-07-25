/**
 * PWA plumbing: service-worker registration, install prompt, update prompt and
 * online/offline status.
 */

import { toast } from './ui/toast.ts';

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
const listeners = new Set<(state: InstallState) => void>();

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

  window.addEventListener('load', () => {
    void (async () => {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            updateReady = installing;
            emit();
            toast('A new version is ready.', {
              tone: 'info',
              action: { label: 'Reload', onClick: applyUpdate },
            });
          }
        });
      });

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
