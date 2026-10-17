import type { PermCode } from '@oviiai/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkImportDialog } from '../../components/BulkImportDialog';
import { useSetupAutoOpen } from '../../components/useSetupAutoOpen';
import { useAuth } from '../../stores/auth';
import { SetupPage } from './SetupPage';
import { SitePage } from './SitePage';

// 嵌入的管理頁各有自己的測試；這裡只確認嵌入了哪一頁
vi.mock('./MapsPage', () => ({ MapsPage: () => <div>地圖管理頁</div> }));
vi.mock('./RobotAdminPage', () => ({ RobotAdminPage: () => <div>機器人管理頁</div> }));
vi.mock('../settings/SettingsPage', () => ({ SettingsPage: () => <div>規則頁</div> }));

let calls: { url: string; method: string; body?: BodyInit | null }[];
type Handler = (url: string, init?: RequestInit) => Response | undefined;
function stub(h: Handler) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
      return h(url, init) ?? new Response('{}');
    }),
  );
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const wrap = (ui: ReactNode, path = '/') => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
  </QueryClientProvider>
);
const auth = (perms: PermCode[]) => useAuth.setState({ status: 'authed', perms, user: null });
const pick = (label: string, name: string) => fireEvent.change(screen.getByLabelText(label), { target: { files: [new File(['x'], name)] } });

beforeEach(() => {
  try {
    sessionStorage.clear();
  } catch {
    /* jsdom */
  }
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('批次匯入對話框（T-45）', () => {
  it('先檢查：逐列結果、錯誤原因；只匯入正確的列', async () => {
    const result = {
      total: 3,
      valid: 2,
      invalid: 1,
      imported: 0,
      rows: [
        { rowNo: 2, code: 'CAM-1', action: 'create', errors: [] },
        { rowNo: 3, code: 'CAM-2', action: 'update', errors: [] },
        { rowNo: 4, code: 'CAM-3', action: null, errors: [{ field: 'floorId', message: '樓層 9f 不存在' }] },
      ],
    };
    stub((url) => (url.includes('/cameras/import') ? json(url.includes('dryRun') ? result : { ...result, imported: 2 }) : undefined));
    const onDone = vi.fn();
    auth(['maps']);
    render(wrap(<BulkImportDialog kind="cameras" onClose={() => {}} onDone={onDone} />));
    expect((screen.getByRole('button', { name: '匯入正確的 0 列' }) as HTMLButtonElement).disabled).toBe(true);
    pick('匯入檔案', 'cams.xlsx');
    fireEvent.click(screen.getByRole('button', { name: '檢查' }));
    expect(await screen.findByText('共 3 列：正確 2 列、錯誤 1 列')).toBeTruthy();
    const bad = screen.getByText('樓層 9f 不存在').closest('tr')!;
    expect(within(bad).getByText('4')).toBeTruthy();
    expect(screen.getByText('更新')).toBeTruthy();
    const dry = calls.find((c) => c.url.endsWith('/cameras/import?dryRun=true'))!;
    expect(dry.body).toBeInstanceOf(FormData);
    expect(((dry.body as FormData).get('file') as File).name).toBe('cams.xlsx');
    fireEvent.click(screen.getByRole('button', { name: '匯入正確的 2 列' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(calls.some((c) => c.url === '/api/v1/cameras/import' && c.method === 'POST')).toBe(true);
  });

  it('下載範本帶權杖取檔；檔案錯誤顯示原因', async () => {
    stub((url) => {
      if (url.includes('/import/templates/')) return new Response(new Blob(['x']));
      if (url.includes('/robots/import')) return json({ error: { code: 'VALIDATION_FAILED', message: '標題列缺少欄位：品牌', details: {} } }, 400);
    });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    auth(['robotmgr']);
    render(wrap(<BulkImportDialog kind="robots" onClose={() => {}} onDone={() => {}} />));
    fireEvent.click(screen.getByRole('button', { name: 'Excel 範本' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/import/templates/robots?format=xlsx')).toBe(true));
    pick('匯入檔案', 'r.csv');
    fireEvent.click(screen.getByRole('button', { name: '檢查' }));
    expect((await screen.findByRole('alert')).textContent).toBe('標題列缺少欄位：品牌');
  });
});

describe('場域匯出／匯入（T-44）', () => {
  const preview = {
    version: 1,
    summary: { add: 2, update: 1, delete: 1, disable: 0, keep: 1 },
    sections: [
      { entity: 'robots', changes: [{ key: 'B2-009', action: 'add' }] },
      { entity: 'cameras', changes: [{ key: 'CAM-1F-01', action: 'update', fields: ['name', 'floorId'] }, { key: 'CAM-1F-99', action: 'delete' }] },
      { entity: 'floors', changes: [{ key: '2f', action: 'keep', note: '樓層不自動刪除' }] },
      { entity: 'pois', changes: [] },
    ],
    warnings: ['新增的 1 支攝影機沒有 RTSP 帳密，匯入後請到「地圖管理」重新輸入'],
    applied: false,
  };

  it('預覽差異表（依類別、動作、變更欄位）與提醒；確認後才套用', async () => {
    stub((url) => (url.includes('/site/import') ? json(url.includes('dryRun') ? preview : { ...preview, applied: true }) : undefined));
    auth(['settings', 'op.config']);
    render(wrap(<SitePage />));
    expect((screen.getByRole('button', { name: '套用匯入' }) as HTMLButtonElement).disabled).toBe(true);
    pick('場域設定包', 'site.zip');
    fireEvent.click(screen.getByRole('button', { name: '預覽差異' }));
    const diff = await screen.findByRole('region', { name: '差異預覽（尚未套用）' });
    expect(within(diff).getByText('名稱、樓層')).toBeTruthy();
    expect(within(diff).getByText('攝影機（2）')).toBeTruthy();
    expect(within(diff).queryByText(/興趣點/)).toBeNull(); // 沒變更的類別不顯示
    expect(within(diff).getByText(/沒有 RTSP 帳密/)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/v1/site/import?dryRun=true']);

    fireEvent.click(screen.getByRole('button', { name: '套用匯入' }));
    const dlg = screen.getByRole('alertdialog');
    expect(dlg.textContent).toContain('將新增 2、修改 1、刪除 1、停用 0 項');
    expect(dlg.textContent).toContain('會被刪除或停用');
    fireEvent.click(within(dlg).getByRole('button', { name: '套用匯入' }));
    expect(await screen.findByRole('region', { name: '已套用' })).toBeTruthy();
    expect(calls.some((c) => c.url === '/api/v1/site/import' && c.method === 'POST')).toBe(true);
  });

  it('沒有 op.config 只能預覽；匯出帶權杖下載 zip', async () => {
    stub((url) => (url.endsWith('/site/export') ? new Response(new Blob(['PK'])) : undefined));
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    auth(['settings']);
    render(wrap(<SitePage />));
    expect(screen.queryByRole('button', { name: '套用匯入' })).toBeNull();
    expect(screen.getByText(/套用需要「修改設定」權限/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下載場域設定包' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/site/export')).toBe(true));
  });
});

describe('新場域設定精靈（T-46）', () => {
  const status = (doneKeys: string[], blank = false) => ({
    blank,
    done: doneKeys.length,
    total: 7,
    steps: ['floors', 'plans', 'robots', 'chargers', 'cameras', 'calibration', 'rules'].map((key) => ({
      key,
      done: doneKeys.includes(key),
      missing: doneKeys.includes(key) ? [] : key === 'plans' ? ['1F 辦公室：沒有平面圖'] : ['x'],
    })),
  });

  it('左側步驟與完成勾選；預設停在第一個未完成的步驟；每步嵌入對應管理頁；上一步下一步', async () => {
    stub((url) => (url.endsWith('/site/setup-status') ? json(status(['floors', 'robots'])) : undefined));
    auth(['settings', 'maps', 'robotmgr']);
    render(wrap(<SetupPage />));
    expect(await screen.findByText('已完成 2／7')).toBeTruthy();
    const steps = screen.getAllByRole('listitem').filter((li) => li.querySelector('button'));
    expect(steps.map((s) => s.textContent)).toEqual([
      '✓樓層已完成',
      '2平面圖與尺寸還有 1 項',
      '✓機器人已完成',
      '4充電樁還有 1 項',
      '5攝影機還有 1 項',
      '6座標校正還有 1 項',
      '7派工與充電規則還有 1 項',
    ]);
    expect(document.querySelector('.setup-main .title')!.textContent).toBe('第 2 步　平面圖與尺寸');
    expect(screen.getByText('1F 辦公室：沒有平面圖')).toBeTruthy();
    expect(screen.getByText('地圖管理頁')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.click(screen.getByRole('button', { name: '上一步' }));
    const stepBtn = (text: string) => screen.getAllByRole('button').find((b) => b.textContent === text)!;
    fireEvent.click(stepBtn('✓機器人已完成'));
    expect(screen.getByText('機器人管理頁')).toBeTruthy();
    expect(screen.getByRole('button', { name: '批次匯入' })).toBeTruthy();
    fireEvent.click(stepBtn('7派工與充電規則還有 1 項'));
    expect(screen.getByText('規則頁')).toBeTruthy();
  });

  it('沒有該步驟的管理權限：提示找有權限的人', async () => {
    stub((url) => (url.endsWith('/site/setup-status') ? json(status([])) : undefined));
    auth(['settings']);
    render(wrap(<SetupPage />));
    expect(await screen.findByText('這一步需要「地圖管理」權限，請找有權限的人完成')).toBeTruthy();
  });

  it('系統空白：登入後在首頁自動開啟精靈（每個分頁一次）；不是空白不開', async () => {
    function Probe() {
      useSetupAutoOpen();
      return (
        <Routes>
          <Route path="/" element={<p>首頁</p>} />
          <Route path="/setup" element={<p>精靈</p>} />
        </Routes>
      );
    }
    stub((url) => (url.endsWith('/site/setup-status') ? json(status([], true)) : undefined));
    auth(['settings']);
    render(wrap(<Probe />));
    expect(await screen.findByText('精靈')).toBeTruthy();
    cleanup();
    render(wrap(<Probe />));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText('首頁')).toBeTruthy(); // 同一個分頁不再自動開

    cleanup();
    sessionStorage.clear();
    stub((url) => (url.endsWith('/site/setup-status') ? json(status(['floors'], false)) : undefined));
    render(wrap(<Probe />));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText('首頁')).toBeTruthy();
    cleanup();
    auth(['monitor']);
    render(wrap(<Probe />));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c.url.endsWith('/setup-status'))).toHaveLength(1); // 沒有 settings 不查
  });
});
