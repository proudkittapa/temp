import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { preloadScreen, roleFromHash } from './screens';
import './index.css';

// Opened on the counter or settings address: fetch that screen's code
// before the first render, so it appears at once instead of after React's
// ~300 ms loading placeholder (screens.ts). The customer page waits for
// nothing.
preloadScreen(roleFromHash()).then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
