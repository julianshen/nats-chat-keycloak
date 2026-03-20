import React, { useEffect, useState } from 'react';
import type { ChatClient } from '../lib/chat-client';
import { FileIcon, Download, Loader2 } from 'lucide-react';
import { ImageViewer } from './ImageViewer';
import type { ImageItem } from './ImageViewer';

interface Props {
  fileId: string;
  client: ChatClient | null;
  /** All images in the parent message for prev/next navigation */
  allImages?: ImageItem[];
  /** Index of this image in allImages */
  imageIndex?: number;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const FileAttachment: React.FC<Props> = ({ fileId, client, allImages, imageIndex }) => {
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [fileInfo, setFileInfo] = useState<{ filename: string; size: number; contentType: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewerOpen, setViewerOpen] = useState(false);

  useEffect(() => {
    if (!client || !fileId) return;
    let cancelled = false;

    (async () => {
      try {
        const [info, dl] = await Promise.all([
          client.files.getFileInfo(fileId),
          client.files.requestDownload(fileId),
        ]);
        if (cancelled) return;
        setFileInfo({ filename: info.filename, size: info.size, contentType: info.contentType });
        setDownloadUrl(dl.downloadUrl);
      } catch (err) {
        if (!cancelled) setError('Failed to load attachment');
        console.warn('[FileAttachment] Failed to load:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [fileId, client]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading attachment...
      </div>
    );
  }

  if (error || !fileInfo || !downloadUrl) {
    return (
      <div className="text-xs text-destructive py-1">{error || 'Attachment unavailable'}</div>
    );
  }

  const isImage = fileInfo.contentType.startsWith('image/');

  if (isImage) {
    const viewerImages = allImages && allImages.length > 0
      ? allImages
      : [{ src: downloadUrl, alt: fileInfo.filename }];
    const viewerStartIndex = imageIndex ?? 0;

    return (
      <>
        <button
          type="button"
          className="block mt-1 text-left cursor-pointer"
          onClick={() => setViewerOpen(true)}
        >
          <img
            src={downloadUrl}
            alt={fileInfo.filename}
            className="max-w-[400px] max-h-[300px] rounded-lg border border-border object-contain hover:opacity-90 transition-opacity"
          />
          <div className="text-[10px] text-muted-foreground mt-0.5">
            {fileInfo.filename} ({formatFileSize(fileInfo.size)})
          </div>
        </button>
        {viewerOpen && (
          <ImageViewer
            images={viewerImages}
            startIndex={viewerStartIndex}
            onClose={() => setViewerOpen(false)}
          />
        )}
      </>
    );
  }

  return (
    <a
      href={downloadUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 mt-1 px-3 py-2 rounded-lg border border-border bg-muted/50 hover:bg-muted transition-colors max-w-[300px]"
    >
      <FileIcon className="h-5 w-5 text-primary shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-foreground truncate">{fileInfo.filename}</div>
        <div className="text-[10px] text-muted-foreground">{formatFileSize(fileInfo.size)}</div>
      </div>
      <Download className="h-4 w-4 text-muted-foreground shrink-0" />
    </a>
  );
};
