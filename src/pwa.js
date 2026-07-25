/**
 * PWA plumbing: service-worker registration, install prompt, update prompt and
 * online/offline status.
 */

import { toast } from './ui/toast.js';

let deferredPrompt = null;
let updateReady = null;
const listeners = new Set();

export function onPwaChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of [...listeners]) listener(installState());
}

export function installState() {
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  return {
    installed: standalone,
    canPrompt: Boolean(deferredPrompt),
    updateReady: Boolean(updateReady),
    online: navigator.onLine,
  };
}

export async function promptInstall() {
  if (!deferredPrompt) return false;
  const prompt = deferredPrompt;
  deferredPrompt = null;
  emit();
  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  if (outcome === 'accepted') toast('Zenith installed.', { tone: 'success' });
  return outcome === 'accepted';
}

export function applyUpdate() {
  if (!updateReady) return;
  updateReady.postMessage({ type: 'SKIP_WAITING' });
  updateReady = null;
}

export function initPwa() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
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

  window.addEventListener('load', async () => {
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
  });
}
