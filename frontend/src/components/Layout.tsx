import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { t, type MessageKey } from '../i18n';
import { connectRealtime, disconnectRealtime } from '../realtime/socket';
import { buildMenu } from '../routes';
import { useAuth } from '../stores/auth';
import { type Conn, useRealtime } from '../stores/realtime';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { Toaster } from './Toaster';

const CONN_TEXT: Record<Conn, MessageKey> = {
  connected: 'top.realtime.connected',
  connecting: 'top.realtime.connecting',
  disconnected: 'top.realtime.disconnected',
  forbidden: 'top.realtime.forbidden',
};

const SIDE_KEY = 'oviiai.side';
const readSide = () => {
  try {
    return localStorage.getItem(SIDE_KEY) !== 'collapsed';
  } catch {
    return true;
  }
};

/** 版面（原型）：頂欄（選單開關、系統名稱、統計、使用者、時鐘）＋左側分組選單＋內容區 */
export function Layout() {
  const { user, perms, logout } = useAuth();
  const conn = useRealtime((s) => s.conn);
  const stats = useRealtime((s) => s.stats);
  const location = useLocation();
  const menu = buildMenu(perms);
  const [sideOpen, setSideOpen] = useState(readSide);
  const [pwdOpen, setPwdOpen] = useState(false);
  // 分組展開狀態：預設只展開目前頁面所在的組（原型行為）
  const current = menu.find((g) => g.items.some((p) => matches(p.path, location.pathname)))?.group;
  const [open, setOpen] = useState<Set<MessageKey>>(() => new Set(current ? [current] : [menu[0]?.group]));

  useEffect(() => {
    connectRealtime();
    return () => disconnectRealtime();
  }, []);

  useEffect(() => {
    if (current) setOpen((s) => (s.has(current) ? s : new Set(s).add(current)));
  }, [current]);

  function toggleSide() {
    setSideOpen((v) => {
      try {
        localStorage.setItem(SIDE_KEY, v ? 'collapsed' : 'open');
      } catch {
        /* 不記住也沒關係 */
      }
      return !v;
    });
  }

  const toggle = (g: MessageKey) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(g)) n.delete(g);
      else n.add(g);
      return n;
    });

  return (
    <div className="app">
      <header className="topbar">
        <div className="tleft">
          <button type="button" className="hamb" onClick={toggleSide} aria-label={t('menu.toggle')} aria-expanded={sideOpen}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="brand">{t('app.name')}</div>
        </div>
        <div className="tstat" aria-live="polite">
          <span>
            {t('top.stat.online')}
            <b>{stats ? `${stats.online}/${stats.total}` : '—'}</b>
          </span>
          <span>
            {t('top.stat.working')}
            <b>{stats?.working ?? '—'}</b>
          </span>
          <span>
            {t('top.stat.charging')}
            <b>{stats?.charging ?? '—'}</b>
          </span>
          <span>
            {t('top.stat.fault')}
            <b className={stats?.fault ? 'alert' : ''}>{stats?.fault ?? '—'}</b>
          </span>
          <span>
            {t('top.stat.todayTasks')}
            <b>{stats?.todayTasks ?? '—'}</b>
          </span>
          <span>
            {t('top.stat.openAlarms')}
            <b className={stats?.openAlarms ? 'alert' : ''}>{stats?.openAlarms ?? '—'}</b>
          </span>
        </div>
        <div className="tright">
          {conn !== 'connected' && <span className={`conn conn-${conn}`}>{t(CONN_TEXT[conn])}</span>}
          <div className="ubtn">
            <span>{user?.displayName}</span>
            <small>{user?.role.name}</small>
          </div>
          <Clock />
        </div>
      </header>
      <div className="shell">
        <nav className={`side${sideOpen ? '' : ' collapsed'}`} aria-label={t('app.name')}>
          {menu.map((g) => (
            <div key={g.group}>
              <button type="button" className="grp" aria-expanded={open.has(g.group)} onClick={() => toggle(g.group)}>
                {t(g.group)}
                <i aria-hidden="true">▾</i>
              </button>
              {open.has(g.group) && (
                <div className="grp-items">
                  {g.items.map((p) => (
                    <NavLink key={p.path} to={p.path} end={p.path === '/'} className={({ isActive }) => `item${isActive ? ' active' : ''}`}>
                      {t(p.title)}
                    </NavLink>
                  ))}
                  {g.group === 'menu.group.user' && (
                    <>
                      <button type="button" className="item" onClick={() => setPwdOpen(true)}>
                        {t('menu.changePassword')}
                      </button>
                      <button type="button" className="item" onClick={() => void logout()}>
                        {t('menu.logout')}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </nav>
        <div className="views">
          <Outlet />
        </div>
      </div>
      {pwdOpen && <ChangePasswordDialog onClose={() => setPwdOpen(false)} />}
      <Toaster />
    </div>
  );
}

function matches(route: string, path: string) {
  return route === '/' ? path === '/' : path === route || path.startsWith(`${route}/`);
}

const clockFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** 頂欄時鐘：Asia/Taipei */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);
  return <div className="clock">{clockFmt.format(now)}</div>;
}
