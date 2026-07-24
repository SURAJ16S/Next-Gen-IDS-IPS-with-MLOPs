import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

function ChartCard({ title, data = [], dataKey = 'value', xKey = 'name' }) {
  return (
    <div className="card">
      <h4 style={{ margin: '0 0 16px', fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{title}</h4>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
          <XAxis dataKey={xKey} stroke="var(--text-muted)" fontSize={11} />
          <YAxis stroke="var(--text-muted)" fontSize={11} />
          <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: '6px', fontSize: '12px' }} />
          <Line type="monotone" dataKey={dataKey} stroke="var(--accent-blue)" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default ChartCard;