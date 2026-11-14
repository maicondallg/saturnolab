import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { normalizeThemeId } from './themes';
import { bootstrapConfig } from './services/bootstrap';

// Apply saved appearance before React can paint provisional defaults.
try {
  document.documentElement.dataset.theme = normalizeThemeId(localStorage.getItem('saturno_theme') || bootstrapConfig?.theme);
  const fontSize = bootstrapConfig?.editor_font_size || Number(localStorage.getItem('saturno_font_size'));
  if (fontSize > 0) document.documentElement.style.setProperty('--sat-editor-font-size', `${fontSize}px`);
} catch { /* Storage may be unavailable; initialization supplies server defaults. */ }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
