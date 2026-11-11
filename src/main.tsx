import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { joinInAddress } from './collab/join';
import { boot, openCollab, useStore } from './model/store';
import './styles.css';
import './ui/tips';

/** Shared projects (co-editing through a collaboration server) are under trial: on only in a build made with VITE_KEITO_COLLAB=1. */
const COLLAB = import.meta.env.VITE_KEITO_COLLAB === '1';

// In the desktop app, boards are kept through its own store; in a browser, the one found (see connect).
if ('__TAURI_INTERNALS__' in window) void import('./platform/tauri').then((m) => m.startDesktop());
else void boot(undefined, (COLLAB && joinInAddress()) || undefined);

if (COLLAB)
  window.addEventListener('hashchange', () => {
    const join = joinInAddress();
    if (join && useStore.getState().ready && useStore.getState().collab?.project !== join.project) void openCollab(join);
  });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Dev-only handle for poking at the store from the console.
if (import.meta.env.DEV) {
  import('./model/store').then((m) => Object.assign(window, { keito: m.useStore }));
}
