import { bootstrapApplication, provideProtractorTestingSupport } from '@angular/platform-browser';
import { provideExperimentalZonelessChangeDetection } from '@angular/core';
import { AppComponent } from './app.component';

class RoomAppKb extends HTMLElement {
  private _initialized = false;

  async setBridge(bridge: any) {
    if (this._initialized) return;
    this._initialized = true;

    this.style.display = 'flex';
    this.style.flexDirection = 'column';
    this.style.flex = '1';
    this.style.minHeight = '0';
    this.style.overflow = 'hidden';

    (window as any).__KB_BRIDGE__ = bridge;

    const host = document.createElement('kb-root');
    this.appendChild(host);

    try {
      await bootstrapApplication(AppComponent, {
        providers: [
          provideExperimentalZonelessChangeDetection(),
        ],
      });
    } catch (e) {
      console.error('[KB] Angular bootstrap failed:', e);
    }
  }
}

if (!customElements.get('room-app-kb')) {
  customElements.define('room-app-kb', RoomAppKb);
}
