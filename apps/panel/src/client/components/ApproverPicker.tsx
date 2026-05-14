// ApproverPicker — placeholder for the 2-person approval flow. Phase I will
// load admin users via /api/admins and let the requester pick the approver.
import { useState } from 'react';
import { Input } from './ui/input.js';
import { Button } from './ui/button.js';

export function ApproverPicker({ onPick }: { onPick: (email: string) => void }) {
  const [email, setEmail] = useState('');
  return (
    <div className="flex items-center gap-2">
      <Input placeholder="approver@…" value={email} onChange={(e) => setEmail(e.target.value)} />
      <Button onClick={() => onPick(email)} disabled={!email}>
        Request approval
      </Button>
    </div>
  );
}
