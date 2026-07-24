import { Outlet } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Header from '../components/Header';
import '../styles/theme.css';

function DashboardLayout() {
  return (
    <div style={{ display: 'flex', width: '100%', minHeight: '100vh', background: 'var(--bg-primary)' }}>
      <Sidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Header />
        <main style={{ padding: '24px', flex: 1, overflowX: 'auto' }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default DashboardLayout;