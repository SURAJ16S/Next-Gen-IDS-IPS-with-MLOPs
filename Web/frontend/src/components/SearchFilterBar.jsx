import { Search, Calendar, RefreshCw } from 'lucide-react';

function SearchFilterBar({ onRefresh, timeLabel = 'Last 24 hours' }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-sm)',
        padding: '8px 12px',
        marginBottom: '18px',
      }}
    >
      <Search size={16} color="var(--text-muted)" />
      <input
        type="text"
        placeholder="Search..."
        style={{
          flex: 1,
          border: 'none',
          outline: 'none',
          background: 'transparent',
          fontSize: '13px',
          color: 'var(--text-primary)',
        }}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '5px 10px',
          borderLeft: '1px solid var(--border-subtle)',
          color: 'var(--text-secondary)',
          fontSize: '12.5px',
        }}
      >
        <Calendar size={14} />
        {timeLabel}
      </div>
      <button
        onClick={onRefresh}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 12px',
          background: 'var(--accent-blue)',
          color: '#fff',
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          fontSize: '12.5px',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        <RefreshCw size={13} />
        Refresh
      </button>
    </div>
  );
}

export default SearchFilterBar;