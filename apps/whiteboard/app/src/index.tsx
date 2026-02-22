import '@excalidraw/excalidraw/index.css';
import { createRoot, Root } from 'react-dom/client';
import { App } from './App';
import type { AppBridge } from './types';

// Excalidraw loads fonts/assets from this CDN path
(window as any).EXCALIDRAW_ASSET_PATH = 'https://unpkg.com/@excalidraw/excalidraw/dist/';

class RoomAppWhiteboard extends HTMLElement {
  private _root: Root | null = null;

  // Light DOM — no attachShadow() because Excalidraw injects CSS into document.head
  setBridge(bridge: AppBridge) {
    // The custom element itself must fill its flex parent
    this.style.display = 'flex';
    this.style.flexDirection = 'column';
    this.style.flex = '1';
    this.style.minHeight = '0';
    this.style.overflow = 'hidden';

    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.flex = '1';
    container.style.minHeight = '0';
    this.appendChild(container);

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

customElements.define('room-app-whiteboard', RoomAppWhiteboard);
