import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RequireLogin, RequirePage } from './components/RequirePage';
import { LoginPage } from './pages/LoginPage';
import { MapsPage } from './pages/admin/MapsPage';
import { ParamsPage } from './pages/admin/ParamsPage';
import { SetupPage } from './pages/admin/SetupPage';
import { SitePage } from './pages/admin/SitePage';
import { RobotAdminPage } from './pages/admin/RobotAdminPage';
import { RolesPage } from './pages/admin/RolesPage';
import { CapturesPage, RecordsPage } from './pages/media/MediaPages';
import { NavPage } from './pages/nav/NavPage';
import { AlarmSettingsPage } from './pages/alarms/AlarmSettingsPage';
import { AlarmsPage } from './pages/alarms/AlarmsPage';
import { DispatchPage } from './pages/dispatch/DispatchPage';
import { MonitorPage } from './pages/monitor/MonitorPage';
import { RemotePage } from './pages/remote/RemotePage';
import { RobotsPage } from './pages/robots/RobotsPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { ForbiddenPage, NotFoundPage, PlaceholderPage } from './pages/StatusPages';
import { PAGES } from './routes';
import { useAuth } from './stores/auth';

/** 已實作的頁面；其餘顯示佔位頁 */
const IMPLEMENTED: Record<string, () => JSX.Element> = {
  '/': MonitorPage,
  '/robots': RobotsPage,
  '/dispatch': DispatchPage,
  '/settings': SettingsPage,
  '/alarms/system': () => <AlarmsPage key="system" category="system" />,
  '/alarms/business': () => <AlarmsPage key="business" category="business" />,
  '/alarms/settings': AlarmSettingsPage,
  '/robot-admin': RobotAdminPage,
  '/roles': RolesPage,
  '/maps': MapsPage,
  '/nav': NavPage,
  '/captures': CapturesPage,
  '/records': RecordsPage,
  '/params': ParamsPage,
  '/site': SitePage,
  '/setup': SetupPage,
  '/remote': RemotePage,
  '/remote/:id': RemotePage,
};

export function App() {
  const init = useAuth((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireLogin>
            <Layout />
          </RequireLogin>
        }
      >
        {PAGES.map((p) => {
          const Page = IMPLEMENTED[p.path];
          return (
            <Route
              key={p.path}
              path={p.path}
              element={<RequirePage page={p}>{Page ? <Page /> : <PlaceholderPage page={p} />}</RequirePage>}
            />
          );
        })}
        <Route path="/forbidden" element={<ForbiddenPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
