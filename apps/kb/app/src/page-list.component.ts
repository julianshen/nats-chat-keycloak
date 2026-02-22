import { Component, EventEmitter, Input, OnInit, Output, ViewEncapsulation, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AppBridge, PageSummary } from './types';

@Component({
  selector: 'kb-page-list',
  standalone: true,
  imports: [CommonModule],
  encapsulation: ViewEncapsulation.None,
  template: `
    <div class="kb-page-list">
      <div class="kb-header">
        <h2 class="kb-title">Knowledge Base</h2>
        <button class="kb-btn kb-btn-primary" (click)="createPage()">+ New Page</button>
      </div>
      <div class="kb-pages">
        <div *ngIf="loading" class="kb-loading">Loading pages...</div>
        <div *ngIf="!loading && pages.length === 0" class="kb-empty">
          <div class="kb-empty-icon">&#128214;</div>
          <p>No pages yet. Create one to get started!</p>
        </div>
        <div *ngFor="let page of pages"
             class="kb-page-row"
             (click)="openPage.emit(page.id)">
          <div class="kb-page-icon">&#128196;</div>
          <div class="kb-page-info">
            <div class="kb-page-title">{{ page.title }}</div>
            <div class="kb-page-meta">
              Updated by {{ page.updatedBy }} &middot; {{ formatDate(page.updatedAt) }}
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .kb-page-list {
      display: flex;
      flex-direction: column;
      height: 100%;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .kb-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid #333;
    }
    .kb-title {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
      color: #fff;
    }
    .kb-btn {
      border: none;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 13px;
      cursor: pointer;
      font-weight: 500;
    }
    .kb-btn-primary {
      background: #5b6eae;
      color: #fff;
    }
    .kb-btn-primary:hover {
      background: #6b7ebe;
    }
    .kb-pages {
      flex: 1;
      overflow-y: auto;
      padding: 8px 0;
    }
    .kb-loading, .kb-empty {
      text-align: center;
      padding: 40px 20px;
      color: #888;
    }
    .kb-empty-icon {
      font-size: 48px;
      margin-bottom: 12px;
    }
    .kb-page-row {
      display: flex;
      align-items: center;
      padding: 12px 20px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .kb-page-row:hover {
      background: rgba(255,255,255,0.05);
    }
    .kb-page-icon {
      font-size: 24px;
      margin-right: 12px;
      flex-shrink: 0;
    }
    .kb-page-info {
      flex: 1;
      min-width: 0;
    }
    .kb-page-title {
      font-size: 14px;
      font-weight: 500;
      color: #e0e0e0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .kb-page-meta {
      font-size: 12px;
      color: #888;
      margin-top: 2px;
    }
  `]
})
export class PageListComponent implements OnInit {
  @Input() bridge!: AppBridge;
  @Output() openPage = new EventEmitter<string>();

  pages: PageSummary[] = [];
  loading = true;

  constructor(private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    await this.loadPages();
  }

  async loadPages() {
    this.loading = true;
    try {
      const resp = await this.bridge.request('list', {});
      this.pages = resp.pages || [];
    } catch (e) {
      console.error('[KB] Failed to load pages:', e);
    }
    this.loading = false;
    this.cdr.markForCheck();
  }

  async createPage() {
    const title = prompt('Page title:');
    if (!title) return;
    try {
      const resp = await this.bridge.request('create', { title });
      if (resp.id) {
        this.openPage.emit(resp.id);
      }
    } catch (e) {
      console.error('[KB] Failed to create page:', e);
    }
  }

  formatDate(dateStr: string): string {
    try {
      const date = new Date(dateStr);
      const now = new Date();
      const diff = now.getTime() - date.getTime();
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
      return date.toLocaleDateString();
    } catch {
      return dateStr;
    }
  }
}
