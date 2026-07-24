import { Inbox } from 'lucide-react';

function EmptyState({ message = 'No data available' }) {
  return (
    <div className="empty-state">
      <Inbox size={28} style={{ marginBottom: '8px', opacity: 0.5 }} />
      <div>{message}</div>
    </div>
  );
}

export default EmptyState;