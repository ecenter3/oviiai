import { useQuery } from '@tanstack/react-query';

interface Health {
  status: string;
  checks: Record<string, string>;
}

// 畫面依可操作原型（oviiai-monitor.html）逐頁實作：總覽、樓層監控、派工、告警、影像、設定
export function App() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async (): Promise<Health> => {
      const r = await fetch('/api/v1/health');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 5000,
  });

  return (
    <main style={{ fontFamily: 'system-ui, "Noto Sans TC", sans-serif', padding: 24 }}>
      <h1>OViiAI 監控平台</h1>
      <p>開發骨架。後端狀態：</p>
      {health.isLoading && <p>讀取中…</p>}
      {health.error && <p style={{ color: '#c62828' }}>連不到後端：{String(health.error)}</p>}
      {health.data && (
        <ul>
          {Object.entries(health.data.checks).map(([k, v]) => (
            <li key={k}>
              {k}：{v}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
