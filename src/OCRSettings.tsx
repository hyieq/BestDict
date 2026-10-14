import { useEffect, useState } from 'react';
import { Download, ScanLine, Trash2 } from 'lucide-react';
import type { OCRStatus } from './types';

export default function OCRSettings({ t }: { t: (text: string) => string }) {
  const [status, setStatus] = useState<OCRStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = () => void window.bestdict.getOCR().then(s => { if (active) setStatus(s); }).catch(e => { if (active) setError(String(e)); });
    refresh();
    const timer = setInterval(refresh, 600);
    return () => { active = false; clearInterval(timer); };
  }, []);
  async function action(remove = false) {
    setBusy(true); setError('');
    try { setStatus(await (remove ? window.bestdict.uninstallOCR() : window.bestdict.installOCR())); }
    catch (e) { setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, '')); }
    finally { setBusy(false); }
  }
  return <div className="engine-card" data-testid="ocr-settings">
    <div className="engine-heading"><div><strong>{t('截图翻译')}</strong><p>PP-OCRv6 small · ONNX · Apache-2.0</p></div><span className="engine-badge">{t(status?.ready ? '已安装' : '未安装')}</span></div>
    <p className="engine-purpose">{t('框选屏幕上的中英文，离线提取文字并翻译。截图仅在内存中处理，不自动保存。')}</p>
    <p className="engine-purpose">{t('OCR 模型约 31 MB；翻译复用已安装的 HY 或已启用的 Argos。')}</p>
    {status && !status.supported && <p>{t('截图翻译目前仅支持 Windows。')}</p>}
    <div className="engine-actions">
      {!status?.ready && <button className="small-download" disabled={busy || !!status?.progress || !status?.supported} onClick={() => void action()}><Download size={14} />{t('下载 OCR 模型')}</button>}
      {status?.ready && <><button className="secondary-button" disabled={busy} onClick={() => void window.bestdict.startCapture().catch(e => setError(String(e)))}><ScanLine size={14} />{t('开始截图')}</button><button className="secondary-button" disabled={busy || !!status.progress} onClick={() => void action(true)}><Trash2 size={14} />{t('卸载 OCR 模型')}</button></>}
      {status?.progress && <button className="secondary-button" onClick={() => void window.bestdict.cancelOCRDownload().catch(e => setError(String(e)))}>{t('取消')}</button>}
    </div>
    {status?.progress && <div className="download-status" role="status">{t('正在下载 OCR 模型…')} {Math.floor(status.progress.received / status.progress.total * 100)}%<progress value={status.progress.received} max={status.progress.total} /></div>}
    {error && <p className="error-banner" role="alert">{t(error)}</p>}
  </div>;
}
