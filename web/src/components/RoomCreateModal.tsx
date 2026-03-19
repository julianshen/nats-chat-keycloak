import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface Props {
  onSubmit: (name: string, displayName: string) => void;
  onClose: () => void;
}

const RESERVED = ['general', 'random', 'help', '__admin__'];

export const RoomCreateModal: React.FC<Props> = ({ onSubmit, onClose }) => {
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!cleaned) {
      setError('Room name is required');
      return;
    }
    if (cleaned.startsWith('dm-')) {
      setError('Room name cannot start with "dm-"');
      return;
    }
    if (RESERVED.includes(cleaned)) {
      setError('This name is reserved');
      return;
    }
    onSubmit(cleaned, displayName.trim() || cleaned);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Create Private Room</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground">Room Name</label>
            <Input
              placeholder="e.g. project-alpha"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError('');
              }}
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground">Lowercase letters, numbers, and hyphens only</p>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground">Display Name (optional)</label>
            <Input
              placeholder="e.g. Project Alpha"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit">Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
