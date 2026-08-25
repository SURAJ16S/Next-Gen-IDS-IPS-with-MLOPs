import { Outlet } from 'react-router-dom';
import AdminSidebar from '../components/AdminSidebar';
import Header from '../components/Header';
import '../styles/theme.css';

function AdminDashboardLayout() {
  return (
    <div style={{ display: 'flex', width: '100%', minHeight: '100vh', background: '#f3f4f6' }}>
      <AdminSidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Header />
        <main style={{ padding: '24px', flex: 1, overflowX: 'auto', background: '#f9fafb' }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default AdminDashboardLayout;
