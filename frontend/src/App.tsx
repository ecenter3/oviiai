import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RequireLogin, RequirePage } from './components/RequirePage';
import { LoginPage } from './pages/LoginPage';
import { MonitorPage } from './pages/monitor/MonitorPage';
import { ForbiddenPage, NotFoundPage, PlaceholderPage } from './pages/StatusPages';
import { PAGES } from './routes';
import { useAuth } from './stores/auth';

/** 已實作的頁面；其餘顯示佔位頁 */
const IMPLEMENTED: Record<string, () => JSX.Element> = {
  '/': MonitorPage,
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
