import { useState } from 'react';
import { BoardList } from './BoardList';
import { BoardView } from './BoardView';
import type { AppBridge } from './types';

export function App({ bridge }: { bridge: AppBridge }) {
  const [boardId, setBoardId] = useState<string | null>(null);
  const [boardName, setBoardName] = useState('');

  const openBoard = (id: string, name: string) => {
    setBoardId(id);
    setBoardName(name);
  };

  const goBack = () => {
    setBoardId(null);
    setBoardName('');
  };

  if (boardId) {
    return (
      <BoardView
        bridge={bridge}
        boardId={boardId}
        boardName={boardName}
        onBack={goBack}
      />
    );
  }

  return <BoardList bridge={bridge} onOpenBoard={openBoard} />;
}
