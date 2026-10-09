import { Route, Routes } from 'react-router';
import { AdminLayout } from './components/AdminLayout';
import { ApplyPage } from './pages/ApplyPage';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ApplicationDetailPage } from './pages/admin/ApplicationDetailPage';
import { ApplicationsPage } from './pages/admin/ApplicationsPage';
import { JobFormPage } from './pages/admin/JobFormPage';
import { LoginPage } from './pages/admin/LoginPage';
import { OverviewPage } from './pages/admin/OverviewPage';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/apply/:jobId" element={<ApplyPage />} />
      <Route path="/admin/login" element={<LoginPage />} />
      {/* AdminLayout checks the session; the server enforces it again on every request. */}
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<OverviewPage />} />
        <Route path="jobs/new" element={<JobFormPage />} />
        <Route path="jobs/:jobId/edit" element={<JobFormPage />} />
        <Route path="applications" element={<ApplicationsPage />} />
        <Route path="applications/:id" element={<ApplicationDetailPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
