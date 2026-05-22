import './style.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Popup } from './Popup.js';

const root = document.getElementById('root');
if (!root) throw new Error('No #root');
createRoot(root).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
