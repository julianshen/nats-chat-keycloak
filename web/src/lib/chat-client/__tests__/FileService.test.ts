import { describe, it, expect, vi } from 'vitest';

// Mock tracing to avoid OTel dependency in tests
vi.mock('../../../utils/tracing', () => ({
  tracedHeaders: () => ({ headers: { set: vi.fn(), get: vi.fn(), keys: vi.fn(() => []) }, traceId: 'test-trace' }),
  startActionSpan: () => ({ ctx: {}, end: vi.fn() }),
  tracedHeadersWithContext: () => ({ headers: { set: vi.fn(), get: vi.fn(), keys: vi.fn(() => []) }, traceId: 'test-trace' }),
}));

import { FileService } from '../FileService';
import type { ConnectionManager } from '../ConnectionManager';

function mockCM(requestFn: (...args: any[]) => any): ConnectionManager {
  return {
    nc: { request: requestFn },
    isConnected: true,
  } as unknown as ConnectionManager;
}

describe('FileService', () => {
  it('requestUpload returns uploadUrl and fileId', async () => {
    const request = vi.fn().mockResolvedValue({
      data: new TextEncoder().encode(JSON.stringify({
        uploadUrl: 'http://media:8095/upload/abc?token=xyz',
        token: 'xyz',
        fileId: 'abc',
      })),
    });
    const fs = new FileService(mockCM(request), 'alice');
    const result = await fs.requestUpload('general', 'photo.jpg', 'image/jpeg');
    expect(result.fileId).toBe('abc');
    expect(result.uploadUrl).toContain('/upload/abc');
    expect(request).toHaveBeenCalledWith(
      'file.upload.request',
      expect.anything(),
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  it('requestDownload returns downloadUrl', async () => {
    const request = vi.fn().mockResolvedValue({
      data: new TextEncoder().encode(JSON.stringify({
        downloadUrl: 'http://media:8095/files/abc?token=xyz',
        token: 'xyz',
      })),
    });
    const fs = new FileService(mockCM(request), 'alice');
    const result = await fs.requestDownload('abc');
    expect(result.downloadUrl).toContain('/files/abc');
  });

  it('rewriteUrl replaces Docker-internal hostname', async () => {
    const request = vi.fn().mockResolvedValue({
      data: new TextEncoder().encode(JSON.stringify({
        uploadUrl: 'http://media-server:8095/upload/abc?token=xyz',
        token: 'xyz',
        fileId: 'abc',
      })),
    });
    const fs = new FileService(mockCM(request), 'alice', 'http://localhost:8095');
    const result = await fs.requestUpload('general', 'photo.jpg');
    expect(result.uploadUrl).toBe('http://localhost:8095/upload/abc?token=xyz');
  });

  it('throws on error response', async () => {
    const request = vi.fn().mockResolvedValue({
      data: new TextEncoder().encode(JSON.stringify({ error: 'not a member' })),
    });
    const fs = new FileService(mockCM(request), 'alice');
    await expect(fs.requestUpload('secret', 'file.txt')).rejects.toThrow('not a member');
  });

  it('throws when not connected', async () => {
    const fs = new FileService({ nc: null, isConnected: false } as unknown as ConnectionManager, 'alice');
    await expect(fs.requestUpload('general', 'file.txt')).rejects.toThrow('Not connected');
  });

  it('getFileInfo returns file metadata', async () => {
    const request = vi.fn().mockResolvedValue({
      data: new TextEncoder().encode(JSON.stringify({
        id: 'abc',
        room: 'general',
        uploader: 'alice',
        filename: 'photo.jpg',
        size: 12345,
        contentType: 'image/jpeg',
      })),
    });
    const fs = new FileService(mockCM(request), 'alice');
    const info = await fs.getFileInfo('abc');
    expect(info.filename).toBe('photo.jpg');
    expect(info.size).toBe(12345);
    expect(request).toHaveBeenCalledWith(
      'file.info.abc',
      expect.anything(),
      expect.objectContaining({ timeout: 5000 }),
    );
  });
});
