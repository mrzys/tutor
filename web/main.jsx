import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import 'katex/dist/katex.min.css';
import './styles.css';
import { normalizeRoute } from './routes.js';

normalizeRoute();
createRoot(document.getElementById('root')).render(<App />);
