import { formatTime, t, type MessageKey } from '../i18n';
import { useRealtime } from '../stores/realtime';

/** 實時監控（T-14 會換成平面圖）。骨架先以表格顯示 WebSocket 推來的即時狀態，驗證連線與訂閱 */
export function MonitorPage() {
  const robots = Object.values(useRealtime((s) => s.robots)).sort((a, b) => a.code.localeCompare(b.code));
  return (
    <div>
      <h1>{t('page.monitor')}</h1>
      {robots.length === 0 ? (
        <p className="muted">{t('robot.empty')}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('robot.code')}</th>
              <th>{t('robot.floor')}</th>
              <th>{t('robot.state')}</th>
              <th>{t('robot.battery')}</th>
              <th>{t('robot.position')}</th>
              <th>{t('robot.updated')}</th>
            </tr>
          </thead>
          <tbody>
            {robots.map((r) => (
              <tr key={r.code} className={r.online ? '' : 'offline'}>
                <td className="mono">{r.code}</td>
                <td>{r.floor}</td>
                <td>
                  <span className={`state state-${r.state}`}>{t(`state.${r.state}` as MessageKey)}</span>
                </td>
                <td className="mono">{r.battery.toFixed(0)}%</td>
                <td className="mono">
                  ({r.x.toFixed(1)}, {r.y.toFixed(1)})
                </td>
                <td className="mono">{formatTime(r.ts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
