import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './ui/styles/tokens.css';
import './ui/styles/global.css';
// Side-effect import: registers MediaSession action handlers and
// starts publishing track + position state to the OS Now Playing
// widget. See src/state/media-session.ts.
import './state/media-session';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('renderer: #root element missing from index.html');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
