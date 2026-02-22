import { useState, useEffect, useCallback } from 'react';
import type { AppBridge, Poll, PollResults } from './types';
import { PollCard } from './PollCard';
import { CreateForm } from './CreateForm';

interface Props {
  bridge: AppBridge;
}

export function App({ bridge }: Props) {
  const [polls, setPolls] = useState<Poll[]>([]);
  const [results, setResults] = useState<Record<string, PollResults>>({});

  const loadPolls = useCallback(async () => {
    try {
      const pollList = (await bridge.request('list')) as Poll[] | null;
      const list = pollList || [];
      setPolls(list);
      const resultMap: Record<string, PollResults> = {};
      for (const p of list) {
        const r = (await bridge.request('results', { pollId: p.id })) as PollResults;
        resultMap[p.id] = r;
      }
      setResults(resultMap);
    } catch (e) {
      console.error('[PollApp] Failed to load polls:', e);
    }
  }, [bridge]);

  useEffect(() => {
    loadPolls();

    const unsub = bridge.subscribe('updated', async (data: unknown) => {
      const d = data as { pollId?: string } | null;
      if (d?.pollId) {
        try {
          const r = (await bridge.request('results', {
            pollId: d.pollId,
          })) as PollResults;
          setResults((prev) => ({ ...prev, [d.pollId!]: r }));
        } catch (e) {
          console.error('[PollApp] Failed to refresh results:', e);
        }
      } else {
        loadPolls();
      }
    });

    return unsub;
  }, [bridge, loadPolls]);

  const handleVote = async (pollId: string, optionIdx: number) => {
    try {
      await bridge.request('vote', { pollId, optionIdx });
      const r = (await bridge.request('results', { pollId })) as PollResults;
      setResults((prev) => ({ ...prev, [pollId]: r }));
    } catch (e) {
      console.error('[PollApp] Vote failed:', e);
    }
  };

  const handleClose = async (pollId: string) => {
    try {
      await bridge.request('close', { pollId });
      loadPolls();
    } catch (e) {
      console.error('[PollApp] Close failed:', e);
    }
  };

  const handleCreate = async (question: string, options: string[]) => {
    await bridge.request('create', { question, options });
    loadPolls();
  };

  return (
    <>
      <div className="container">
        {polls.length === 0 ? (
          <div className="empty">No polls yet. Create one below!</div>
        ) : (
          polls.map((poll) => (
            <PollCard
              key={poll.id}
              poll={poll}
              results={results[poll.id]}
              username={bridge.user.username}
              onVote={handleVote}
              onClose={handleClose}
            />
          ))
        )}
      </div>
      <CreateForm onSubmit={handleCreate} />
    </>
  );
}
