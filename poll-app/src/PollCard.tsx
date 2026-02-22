import type { Poll, PollResults } from './types';

interface Props {
  poll: Poll;
  results?: PollResults;
  username: string;
  onVote: (pollId: string, optionIdx: number) => void;
  onClose: (pollId: string) => void;
}

export function PollCard({ poll, results, username, onVote, onClose }: Props) {
  if (!results) return null;

  const { totalVotes, votes, userVote } = results;
  const hasVoted = userVote != null;

  return (
    <div className="poll-card">
      <div className="poll-question">
        {poll.question}
        {poll.closed && <span className="closed-badge">CLOSED</span>}
      </div>
      <div className="poll-meta">
        by {poll.createdBy} &middot; {totalVotes} vote
        {totalVotes !== 1 ? 's' : ''}
      </div>
      {poll.options.map((option, i) => {
        const pct =
          totalVotes > 0
            ? Math.round((votes[i].count / totalVotes) * 100)
            : 0;
        const isSelected = userVote === i;
        const canVote = !poll.closed && !hasVoted;

        return (
          <div
            key={i}
            className={`option${hasVoted ? ' voted' : ''}`}
            style={canVote ? { cursor: 'pointer' } : undefined}
            onClick={canVote ? () => onVote(poll.id, i) : undefined}
          >
            <div className="option-bar">
              <div className="bar-bg">
                <div
                  className={`bar-fill ${isSelected ? 'selected' : 'other'}`}
                  style={{ width: `${Math.max(pct, 0)}%` }}
                >
                  {option}
                </div>
              </div>
              <span className="vote-count">{pct}%</span>
            </div>
          </div>
        );
      })}
      {!poll.closed && poll.createdBy === username && (
        <button
          className="btn-secondary"
          style={{ marginTop: 8 }}
          onClick={() => onClose(poll.id)}
        >
          Close Poll
        </button>
      )}
    </div>
  );
}
