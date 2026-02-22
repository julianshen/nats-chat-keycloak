import { useState, useEffect, useRef, useCallback } from 'react';
import { mergeElements } from './merge';
import type { AppBridge, ExcalidrawElement, SyncMessage } from './types';

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
  } as React.CSSProperties,
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '8px 12px',
    background: '#1e1e2e',
    borderBottom: '1px solid #333',
    flexShrink: 0,
  } as React.CSSProperties,
  backBtn: {
    padding: '4px 10px',
    background: 'transparent',
    color: '#aaa',
    border: '1px solid #555',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '13px',
  } as React.CSSProperties,
  boardTitle: {
    fontSize: '14px',
    fontWeight: 600,
    color: '#fff',
    margin: 0,
  } as React.CSSProperties,
  canvasWrap: {
    flex: 1,
    position: 'relative',
    minHeight: 0,
  } as React.CSSProperties,
  canvasInner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  } as React.CSSProperties,
};

// Dynamically import Excalidraw to work with IIFE bundling
let ExcalidrawComponent: any = null;
let excalidrawLoaded = false;
const loadExcalidraw = async () => {
  if (excalidrawLoaded) return;
  const mod = await import('@excalidraw/excalidraw');
  ExcalidrawComponent = mod.Excalidraw;
  excalidrawLoaded = true;
};

export function BoardView({
  bridge,
  boardId,
  boardName,
  onBack,
}: {
  bridge: AppBridge;
  boardId: string;
  boardName: string;
  onBack: () => void;
}) {
  const [ready, setReady] = useState(false);
  const [initialElements, setInitialElements] = useState<ExcalidrawElement[]>([]);
  const excalidrawAPIRef = useRef<any>(null);
  const localElementsRef = useRef<Map<string, number>>(new Map());
  const isSendingDeltaRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingChangesRef = useRef<ExcalidrawElement[]>([]);

  // Load Excalidraw module and board data
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadExcalidraw();
      try {
        const res = (await bridge.request('load', { boardId })) as {
          elements: ExcalidrawElement[];
        };
        if (cancelled) return;
        const elements = res.elements || [];
        // Seed local version tracker
        for (const el of elements) {
          localElementsRef.current.set(el.id, el.version);
        }
        setInitialElements(elements);
        setReady(true);
      } catch (err) {
        console.error('Failed to load board:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  // Subscribe to sync broadcasts from other clients
  useEffect(() => {
    if (!ready) return;
    const unsub = bridge.subscribe('sync', (data: unknown) => {
      const msg = data as SyncMessage;
      if (msg.boardId !== boardId) return;
      if (msg.sender === bridge.user.username) return;

      const api = excalidrawAPIRef.current;
      if (!api) return;

      isSendingDeltaRef.current = true;
      try {
        const currentElements = api.getSceneElements() as ExcalidrawElement[];
        const merged = mergeElements(currentElements, msg.elements);

        // Update local version tracker
        for (const el of msg.elements) {
          const cur = localElementsRef.current.get(el.id) || 0;
          if (el.version > cur) {
            localElementsRef.current.set(el.id, el.version);
          }
        }

        api.updateScene({ elements: merged }, { storeAction: 'NONE' });
      } finally {
        // Small delay to avoid the onChange re-triggering a delta
        setTimeout(() => {
          isSendingDeltaRef.current = false;
        }, 50);
      }
    });
    return unsub;
  }, [ready, boardId]);

  const flushDelta = useCallback(() => {
    const changes = pendingChangesRef.current;
    if (changes.length === 0) return;
    pendingChangesRef.current = [];

    bridge.request('delta', { boardId, elements: changes }).catch((err) => {
      console.error('Delta request failed:', err);
    });
  }, [boardId, bridge]);

  const handleChange = useCallback(
    (elements: readonly any[]) => {
      if (isSendingDeltaRef.current) return;

      // Detect changed elements by comparing versions
      const changed: ExcalidrawElement[] = [];
      for (const el of elements) {
        const knownVersion = localElementsRef.current.get(el.id) || 0;
        if (el.version > knownVersion) {
          localElementsRef.current.set(el.id, el.version);
          changed.push({
            ...el,
          } as ExcalidrawElement);
        }
      }

      if (changed.length === 0) return;

      // Accumulate pending changes
      const pending = pendingChangesRef.current;
      for (const el of changed) {
        const idx = pending.findIndex((p) => p.id === el.id);
        if (idx >= 0) {
          pending[idx] = el;
        } else {
          pending.push(el);
        }
      }

      // Debounce 300ms
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(flushDelta, 300);
    },
    [flushDelta]
  );

  if (!ready || !ExcalidrawComponent) {
    return (
      <div style={{ ...styles.container, justifyContent: 'center', alignItems: 'center', color: '#888' }}>
        Loading whiteboard...
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <button style={styles.backBtn} onClick={onBack}>
          ← Back
        </button>
        <span style={styles.boardTitle}>{boardName}</span>
      </div>
      <div style={styles.canvasWrap}>
        <div style={styles.canvasInner}>
          <ExcalidrawComponent
            excalidrawAPI={(api: any) => {
              excalidrawAPIRef.current = api;
            }}
            initialData={{ elements: initialElements }}
            onChange={handleChange}
            theme="dark"
            isCollaborating={true}
            UIOptions={{
              canvasActions: {
                loadScene: false,
                export: false,
              },
            }}
          />
        </div>
      </div>
    </div>
  );
}
