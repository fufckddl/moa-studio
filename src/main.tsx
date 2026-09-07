import React from 'react';
import ReactDOM from 'react-dom/client';
import Root from './Root';
import './styles.css';
import './studio.css';

const root = document.getElementById('root')!;
const app = <React.StrictMode><Root /></React.StrictMode>;
const isApp = location.pathname.startsWith('/studio') || location.pathname.startsWith('/auth/') || location.hash.startsWith('#/studio') || ['payment', 'plan', 'account'].some(key => new URLSearchParams(location.search).has(key));
if (root.hasChildNodes() && !isApp) {
  ReactDOM.hydrateRoot(root, app);
} else {
  ReactDOM.createRoot(root).render(app);
}
