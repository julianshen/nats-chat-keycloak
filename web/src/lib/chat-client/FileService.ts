import { ConnectionManager, sc } from './ConnectionManager';
import { tracedHeaders } from '../../utils/tracing';
import type { FileAttachment } from '../../types';

export interface UploadResponse {
  uploadUrl: string;
  token: string;
  fileId: string;
}

export interface DownloadResponse {
  downloadUrl: string;
  token: string;
}

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB

export class FileService {
  private cm: ConnectionManager;
  private mediaBaseUrl: string;
  private fileInfoCache = new Map<string, FileAttachment>();

  constructor(cm: ConnectionManager, _username: string, mediaBaseUrl?: string) {
    this.cm = cm;
    this.mediaBaseUrl = mediaBaseUrl || '';
  }

  private rewriteUrl(url: string): string {
    if (!this.mediaBaseUrl) return url;
    return url.replace(/^https?:\/\/[^/]+/, this.mediaBaseUrl);
  }

  async requestUpload(room: string, filename: string, contentType?: string): Promise<UploadResponse> {
    if (!this.cm.nc) throw new Error('Not connected');
    const { headers } = tracedHeaders('file.upload.request');
    const reply = await this.cm.nc.request(
      'file.upload.request',
      sc.encode(JSON.stringify({ room, filename, contentType })),
      { timeout: 5000, headers },
    );
    const result = JSON.parse(sc.decode(reply.data));
    if (result.error) throw new Error(result.error);
    return { ...result, uploadUrl: this.rewriteUrl(result.uploadUrl) };
  }

  async uploadFile(uploadUrl: string, file: File, onProgress?: (pct: number) => void): Promise<{ id: string; size: number }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', uploadUrl);
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          reject(new Error(`Upload failed: ${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(new Error('Upload failed: network error'));
      const formData = new FormData();
      formData.append('file', file);
      xhr.send(formData);
    });
  }

  async confirmUpload(token: string, filename: string, size: number, contentType: string): Promise<void> {
    if (!this.cm.nc) throw new Error('Not connected');
    const { headers } = tracedHeaders('file.uploaded');
    const reply = await this.cm.nc.request(
      'file.uploaded',
      sc.encode(JSON.stringify({ token, filename, size, contentType })),
      { timeout: 5000, headers },
    );
    const result = JSON.parse(sc.decode(reply.data));
    if (result.error) throw new Error(result.error);
  }

  async requestDownload(fileId: string): Promise<DownloadResponse> {
    if (!this.cm.nc) throw new Error('Not connected');
    const { headers } = tracedHeaders('file.download.request');
    const reply = await this.cm.nc.request(
      'file.download.request',
      sc.encode(JSON.stringify({ fileId })),
      { timeout: 5000, headers },
    );
    const result = JSON.parse(sc.decode(reply.data));
    if (result.error) throw new Error(result.error);
    return { ...result, downloadUrl: this.rewriteUrl(result.downloadUrl) };
  }

  async getFileInfo(fileId: string): Promise<FileAttachment> {
    const cached = this.fileInfoCache.get(fileId);
    if (cached) return cached;
    if (!this.cm.nc) throw new Error('Not connected');
    const { headers } = tracedHeaders('file.info');
    const reply = await this.cm.nc.request(
      `file.info.${fileId}`,
      sc.encode(''),
      { timeout: 5000, headers },
    );
    const result = JSON.parse(sc.decode(reply.data));
    if (result.error) throw new Error(result.error);
    this.fileInfoCache.set(fileId, result);
    return result;
  }

  /** Full upload flow: request URL -> upload file -> confirm metadata */
  async upload(room: string, file: File, onProgress?: (pct: number) => void): Promise<string> {
    if (file.size > MAX_UPLOAD_SIZE) {
      throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 50 MB.`);
    }
    const { uploadUrl, token, fileId } = await this.requestUpload(room, file.name, file.type);
    const uploaded = await this.uploadFile(uploadUrl, file, onProgress);
    await this.confirmUpload(token, file.name, uploaded.size, file.type || 'application/octet-stream');
    return fileId;
  }

  destroy(): void {
    this.fileInfoCache.clear();
  }
}
