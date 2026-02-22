import {
  Component, ElementRef, EventEmitter, Input, OnDestroy, OnInit,
  Output, ViewChild, ViewEncapsulation, ChangeDetectorRef
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { AppBridge, Page, PresenceEvent } from './types';

@Component({
  selector: 'kb-page-editor',
  standalone: true,
  imports: [CommonModule],
  encapsulation: ViewEncapsulation.None,
  template: `
    <div class="kb-editor">
      <div class="kb-editor-toolbar">
        <button class="kb-toolbar-btn kb-back-btn" (click)="goBack()" title="Back to pages">&larr;</button>
        <div class="kb-toolbar-sep"></div>
        <button class="kb-toolbar-btn" (click)="execCmd('bold')" title="Bold"><b>B</b></button>
        <button class="kb-toolbar-btn" (click)="execCmd('italic')" title="Italic"><i>I</i></button>
        <div class="kb-toolbar-sep"></div>
        <button class="kb-toolbar-btn" (click)="execHeading('H1')" title="Heading 1">H1</button>
        <button class="kb-toolbar-btn" (click)="execHeading('H2')" title="Heading 2">H2</button>
        <div class="kb-toolbar-sep"></div>
        <button class="kb-toolbar-btn" (click)="execCmd('insertUnorderedList')" title="Bullet list">&#8226;</button>
        <button class="kb-toolbar-btn" (click)="execCmd('insertOrderedList')" title="Ordered list">1.</button>
        <div class="kb-toolbar-sep"></div>
        <button class="kb-toolbar-btn" (click)="insertLink()" title="Insert link">&#128279;</button>
        <div class="kb-toolbar-spacer"></div>
        <span class="kb-save-status" *ngIf="saving">Saving...</span>
        <span class="kb-save-status kb-saved" *ngIf="!saving && saved">Saved</span>
        <button class="kb-toolbar-btn kb-delete-btn" (click)="deletePage()" title="Delete page">&#128465;</button>
      </div>
      <div class="kb-editors-bar" *ngIf="otherEditors.length > 0">
        <span *ngFor="let editor of otherEditors" class="kb-editor-chip">
          {{ editor }} is editing
        </span>
      </div>
      <input class="kb-title-input"
             [value]="pageTitle"
             (input)="onTitleInput($event)"
             placeholder="Untitled" />
      <div class="kb-content-area"
           #contentArea
           contenteditable="true"
           (input)="onContentInput()"
           (keydown)="onKeydown($event)"
           [attr.data-placeholder]="'Start writing...'">
      </div>
    </div>
  `,
  styles: [`
    .kb-editor {
      display: flex;
      flex-direction: column;
      height: 100%;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .kb-editor-toolbar {
      display: flex;
      align-items: center;
      padding: 8px 12px;
      border-bottom: 1px solid #333;
      gap: 2px;
      flex-shrink: 0;
    }
    .kb-toolbar-btn {
      background: transparent;
      border: 1px solid transparent;
      color: #ccc;
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 13px;
      cursor: pointer;
      min-width: 28px;
      text-align: center;
    }
    .kb-toolbar-btn:hover {
      background: rgba(255,255,255,0.1);
      border-color: #555;
    }
    .kb-back-btn {
      font-size: 16px;
      padding: 4px 10px;
    }
    .kb-delete-btn {
      color: #e06060;
    }
    .kb-delete-btn:hover {
      background: rgba(224,96,96,0.15);
    }
    .kb-toolbar-sep {
      width: 1px;
      height: 20px;
      background: #444;
      margin: 0 4px;
    }
    .kb-toolbar-spacer {
      flex: 1;
    }
    .kb-save-status {
      font-size: 12px;
      color: #888;
      margin-right: 8px;
    }
    .kb-saved {
      color: #6a6;
    }
    .kb-editors-bar {
      display: flex;
      gap: 6px;
      padding: 6px 16px;
      flex-wrap: wrap;
      border-bottom: 1px solid #333;
      flex-shrink: 0;
    }
    .kb-editor-chip {
      background: #3a4a6a;
      color: #a0c0ff;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      white-space: nowrap;
    }
    .kb-title-input {
      background: transparent;
      border: none;
      color: #fff;
      font-size: 24px;
      font-weight: 700;
      padding: 16px 20px 8px;
      outline: none;
      flex-shrink: 0;
    }
    .kb-title-input::placeholder {
      color: #555;
    }
    .kb-content-area {
      flex: 1;
      padding: 8px 20px 20px;
      outline: none;
      overflow-y: auto;
      font-size: 15px;
      line-height: 1.6;
      color: #ddd;
    }
    .kb-content-area:empty:before {
      content: attr(data-placeholder);
      color: #555;
      pointer-events: none;
    }
    .kb-content-area h1 {
      font-size: 22px;
      font-weight: 700;
      color: #fff;
      margin: 16px 0 8px;
    }
    .kb-content-area h2 {
      font-size: 18px;
      font-weight: 600;
      color: #eee;
      margin: 12px 0 6px;
    }
    .kb-content-area a {
      color: #7aa8ff;
    }
    .kb-content-area ul, .kb-content-area ol {
      padding-left: 24px;
      margin: 8px 0;
    }
    .kb-content-area li {
      margin: 2px 0;
    }
  `]
})
export class PageEditorComponent implements OnInit, OnDestroy {
  @Input() bridge!: AppBridge;
  @Input() pageId!: string;
  @Input() username!: string;
  @Output() back = new EventEmitter<void>();
  @ViewChild('contentArea', { static: true }) contentArea!: ElementRef<HTMLDivElement>;

  pageTitle = '';
  otherEditors: string[] = [];
  saving = false;
  saved = false;
  private saveTimer: any = null;
  private savedTimer: any = null;

  constructor(private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    try {
      const page: Page = await this.bridge.request('load', { pageId: this.pageId });
      this.pageTitle = page.title || '';
      // Content is stored HTML from our own backend (contenteditable output persisted to PostgreSQL).
      // This is a rich text editor — innerHTML is required to render formatting.
      this.contentArea.nativeElement.innerHTML = page.content || '';
      this.otherEditors = (page.editors || []).filter((e: string) => e !== this.username);
      this.cdr.markForCheck();
    } catch (e) {
      console.error('[KB] Failed to load page:', e);
    }

    this.bridge.request('editing', { pageId: this.pageId }).catch(() => {});

    this.bridge.subscribe('presence', (data: PresenceEvent) => {
      if (data.pageId === this.pageId) {
        this.otherEditors = (data.editors || []).filter((e: string) => e !== this.username);
        this.cdr.markForCheck();
      }
    });
  }

  ngOnDestroy() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.savedTimer) clearTimeout(this.savedTimer);
    this.bridge.request('stopedit', { pageId: this.pageId }).catch(() => {});
  }

  execCmd(command: string) {
    document.execCommand(command, false);
    this.contentArea.nativeElement.focus();
    this.scheduleSave();
  }

  execHeading(level: string) {
    document.execCommand('formatBlock', false, level);
    this.contentArea.nativeElement.focus();
    this.scheduleSave();
  }

  insertLink() {
    const url = prompt('Enter URL:');
    if (url) {
      document.execCommand('createLink', false, url);
      this.contentArea.nativeElement.focus();
      this.scheduleSave();
    }
  }

  onTitleInput(event: Event) {
    this.pageTitle = (event.target as HTMLInputElement).value;
    this.scheduleSave();
  }

  onContentInput() {
    this.scheduleSave();
  }

  onKeydown(event: KeyboardEvent) {
    if (event.key === 'Tab') {
      event.preventDefault();
      document.execCommand('insertText', false, '    ');
    }
  }

  private scheduleSave() {
    this.saved = false;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 2000);
  }

  private async save() {
    this.saving = true;
    this.cdr.markForCheck();
    try {
      await this.bridge.request('save', {
        pageId: this.pageId,
        title: this.pageTitle,
        content: this.contentArea.nativeElement.innerHTML,
      });
      this.saving = false;
      this.saved = true;
      this.cdr.markForCheck();
      if (this.savedTimer) clearTimeout(this.savedTimer);
      this.savedTimer = setTimeout(() => { this.saved = false; this.cdr.markForCheck(); }, 3000);
    } catch (e) {
      console.error('[KB] Failed to save:', e);
      this.saving = false;
      this.cdr.markForCheck();
    }
  }

  async deletePage() {
    if (!confirm('Delete this page?')) return;
    try {
      await this.bridge.request('delete', { pageId: this.pageId });
      this.back.emit();
    } catch (e) {
      console.error('[KB] Failed to delete:', e);
    }
  }

  goBack() {
    this.back.emit();
  }
}
