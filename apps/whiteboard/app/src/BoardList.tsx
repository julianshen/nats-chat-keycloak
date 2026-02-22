import { useState, useEffect } from 'react';
import type { AppBridge, BoardSummary } from './types';

const styles = {
  container: {
    padding: '16px',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    color: '#e0e0e0',
    minHeight: '200px',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px',
  } as React.CSSProperties,
  title: {
    fontSize: '16px',
    fontWeight: 600,
    margin: 0,
    color: '#fff',
  } as React.CSSProperties,
  createBtn: {
    padding: '6px 14px',
    background: '#5b6eea',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
  } as React.CSSProperties,
  form: {
    display: 'flex',
    gap: '8px',
    marginBottom: '16px',
  } as React.CSSProperties,
  input: {
    flex: 1,
    padding: '8px 12px',
    background: '#2a2a3a',
    border: '1px solid #444',
    borderRadius: '6px',
    color: '#e0e0e0',
    fontSize: '13px',
    outline: 'none',
  } as React.CSSProperties,
  boardList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  } as React.CSSProperties,
  boardItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 14px',
    background: '#2a2a3a',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'background 0.15s',
  } as React.CSSProperties,
  boardName: {
    fontSize: '14px',
    fontWeight: 500,
    color: '#fff',
  } as React.CSSProperties,
  boardMeta: {
    fontSize: '12px',
    color: '#888',
  } as React.CSSProperties,
  deleteBtn: {
    padding: '4px 10px',
    background: 'transparent',
    color: '#f44',
    border: '1px solid #f44',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
  } as React.CSSProperties,
  empty: {
    textAlign: 'center',
    padding: '32px',
    color: '#666',
    fontSize: '14px',
  } as React.CSSProperties,
};

export function BoardList({
  bridge,
  onOpenBoard,
}: {
  bridge: AppBridge;
  onOpenBoard: (id: string, name: string) => void;
}) {
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(true);

  const loadBoards = async () => {
    try {
      const res = (await bridge.request('list')) as { boards: BoardSummary[] };
      setBoards(res.boards || []);
    } catch (err) {
      console.error('Failed to load boards:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBoards();
  }, []);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      await bridge.request('create', { name });
      setNewName('');
      setShowCreate(false);
      loadBoards();
    } catch (err) {
      console.error('Failed to create board:', err);
    }
  };

  const handleDelete = async (e: React.MouseEvent, boardId: string) => {
    e.stopPropagation();
    try {
      await bridge.request('delete', { boardId });
      loadBoards();
    } catch (err) {
      console.error('Failed to delete board:', err);
    }
  };

  if (loading) {
    return <div style={styles.container}>Loading boards...</div>;
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h3 style={styles.title}>Whiteboards</h3>
        <button
          style={styles.createBtn}
          onClick={() => setShowCreate(!showCreate)}
        >
          {showCreate ? 'Cancel' : '+ New Board'}
        </button>
      </div>

      {showCreate && (
        <div style={styles.form}>
          <input
            style={styles.input}
            placeholder="Board name..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            autoFocus
          />
          <button style={styles.createBtn} onClick={handleCreate}>
            Create
          </button>
        </div>
      )}

      <div style={styles.boardList}>
        {boards.length === 0 ? (
          <div style={styles.empty}>
            No whiteboards yet. Create one to get started!
          </div>
        ) : (
          boards.map((board) => (
            <div
              key={board.id}
              style={styles.boardItem}
              onClick={() => onOpenBoard(board.id, board.name)}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = '#333348';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = '#2a2a3a';
              }}
            >
              <div>
                <div style={styles.boardName}>{board.name}</div>
                <div style={styles.boardMeta}>
                  by {board.createdBy}
                </div>
              </div>
              <button
                style={styles.deleteBtn}
                onClick={(e) => handleDelete(e, board.id)}
              >
                Delete
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
