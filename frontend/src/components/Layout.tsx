import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { api } from '../api/client';
import { t, type MessageKey } from '../i18n';
import { connectRealtime, disconnectRealtime, resubscribe } from '../realtime/socket';
import { buildMenu } from '../routes';
import { useAuth } from '../stores/auth';
import { type Conn, useRealtime } from '../stores/realtime';

export interface Floor {
  id: string;
  name: string;
  sort: number;
}

const CONN_TEXT: Record<Conn, MessageKey> = {
  connected: 'top.realtime.connected',
  connecting: 'top.realtime.connecting',
  disconnected: 'top.realtime.disconnected',
  forbidden: 'top.realtime.forbidden',
};

/** 版面：左側分組選單＋上方列（樓層、連線狀態、使用者）＋內容區 */
export function Layout() {
  const { user, perms, logout } = useAuth();
  const { conn, floor, setFloor } = useRealtime();
  const floors = useQuery({ queryKey: ['floors'], queryFn: () => api<Floor[]>('/floors') });
  const menu = buildMenu(perms);
  const floorIds = useRef<string[]>([]);
  floorIds.current = (floors.data ?? []).map((x) => x.id);

  // 進入登入後版面時連線一次；訂閱的樓層每次都讀最新值
  useEffect(() => {
    connectRealtime(() => {
      const f = useRealtime.getState().floor;
      return f === 'all' ? floorIds.current : [f];
    });
    return () => disconnectRealtime();
  }, []);

  useEffect(() => {
    void resubscribe();
  }, [floor, floors.data]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">{t('app.name')}</div>
        <nav>
          {menu.map((g) => (
            <section key={g.group}>
              <h2>{t(g.group)}</h2>
              {g.items.map((p) => (
                <NavLink key={p.path} to={p.path} end={p.path === '/'}>
                  {t(p.title)}
                </NavLink>
              ))}
            </section>
          ))}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <label>
            {t('top.floor')}
            <select value={floor} onChange={(e) => setFloor(e.target.value)}>
              <option value="all">{t('top.floor.all')}</option>
              {(floors.data ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          {conn !== 'connected' && <span className={`conn conn-${conn}`}>{t(CONN_TEXT[conn])}</span>}
          <span className="spacer" />
          <span className="who">
            {user?.displayName}（{user?.role.name}）
          </span>
          <button type="button" onClick={() => void logout()}>
            {t('top.logout')}
          </button>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
