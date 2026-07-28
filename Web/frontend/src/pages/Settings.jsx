import { Settings as SettingsIcon } from 'lucide-react';
import StatCard from '../components/StatCard';

function Settings() {
  return (
    <div>
      <h1 className="page-title">Platform Settings</h1>
      <p className="page-subtitle">Manage your account and platform preferences</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(1, 1fr)', gap: '14px', maxWidth: '600px' }}>
        <StatCard title="Account Settings" value="Coming Soon" icon={SettingsIcon} color="var(--text-secondary)" />
      </div>
    </div>
  );
}

export default Settings;
