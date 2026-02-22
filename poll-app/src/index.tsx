import { createRoot, Root } from 'react-dom/client';
import { App } from './App';
import { styles } from './styles';
import type { AppBridge } from './types';

class RoomAppPoll extends HTMLElement {
  private _root: Root | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  setBridge(bridge: AppBridge) {
    if (!this.shadowRoot) return;

    const style = document.createElement('style');
    style.textContent = styles;
    this.shadowRoot.appendChild(style);

    const container = document.createElement('div');
    container.style.display = 'contents';
    this.shadowRoot.appendChild(container);

    this._root = createRoot(container);
    this._root.render(<App bridge={bridge} />);
  }

  disconnectedCallback() {
    if (this._root) {
      this._root.unmount();
      this._root = null;
    }
  }
}

customElements.define('room-app-poll', RoomAppPoll);
