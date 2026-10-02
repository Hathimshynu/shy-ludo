import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/outfit';
import '@fontsource-variable/inter';
import './styles/global.css';
import './styles/ui.css';
import './styles/game.css';
import { App } from './App';

// Read-only inspection hook for development and end-to-end tests. Never enabled in
// production builds (VITE_E2E is only set by the Playwright harness).
if (import.meta.env.DEV || import.meta.env.VITE_E2E === 'true') {
  void Promise.all([import('./store/gameStore'), import('./store/lobbyStore'), import('./services/socket')]).then(
    ([game, lobby, socket]) => {
      (window as unknown as Record<string, unknown>).__ludo = {
        game: () => game.useGame.getState(),
        lobby: () => lobby.useLobby.getState(),
        socket: socket.socketClient,
      };
    },
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
