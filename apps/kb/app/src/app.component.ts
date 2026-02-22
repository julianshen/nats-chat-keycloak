import { Component, ViewEncapsulation } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PageListComponent } from './page-list.component';
import { PageEditorComponent } from './page-editor.component';
import { AppBridge } from './types';

@Component({
  selector: 'kb-root',
  standalone: true,
  imports: [CommonModule, PageListComponent, PageEditorComponent],
  encapsulation: ViewEncapsulation.None,
  template: `
    <div class="kb-app-root">
      <kb-page-list
        *ngIf="!currentPageId"
        [bridge]="bridge"
        (openPage)="currentPageId = $event">
      </kb-page-list>
      <kb-page-editor
        *ngIf="currentPageId"
        [bridge]="bridge"
        [pageId]="currentPageId"
        [username]="username"
        (back)="currentPageId = null">
      </kb-page-editor>
    </div>
  `,
  styles: [`
    .kb-app-root {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: #1a1a2e;
    }
  `]
})
export class AppComponent {
  bridge!: AppBridge;
  currentPageId: string | null = null;
  username = '';

  constructor() {
    const b = (window as any).__KB_BRIDGE__;
    if (b) {
      this.bridge = b;
      this.username = b.user?.username || '';
    }
  }
}
