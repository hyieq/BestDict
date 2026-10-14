import { useEffect, useState } from 'react';
import { ScanLine } from 'lucide-react';
import type { OCRStatus } from './types';

export default function OCRSettings({ t, onDownload }: { t: (text: string) => string; onDownload(): void }) {
  const [status, setStatus] = useState<OCRStatus | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = () => void window.bestdict.getOCR().then(s => { if (active) setStatus(s); }).catch(e => { if (active) setError(String(e)); });
    refresh();
    const timer = setInterval(refresh, 600);
    return () => { active = false; clearInterval(timer); };
  }, []);
  return <div className="engine-card" data-testid="ocr-settings">
    <div className="engine-heading"><div><strong>{t('截图翻译')}</strong></div><span className="engine-badge">{t(status?.ready ? '已安装' : '未安装')}</span></div>
    {status && !status.supported && <p>{t('截图翻译目前仅支持 Windows。')}</p>}
    <div className="engine-actions">
      {!status?.ready && status?.supported && <button className="secondary-button" onClick={onDownload}>{t('前往下载')}</button>}
      {status?.ready && <button className="secondary-button" onClick={() => void window.bestdict.startCapture().catch(e => setError(String(e)))}><ScanLine size={14} />{t('开始截图')}</button>}
    </div>
    {error && <p className="error-banner" role="alert">{t(error)}</p>}
    <details className="resource-details"><summary>{t('截图翻译说明')}</summary>
      <p>{t('框选屏幕上的中英文，离线提取文字并翻译。截图仅在内存中处理，不自动保存。')}</p>
      <p>{t('OCR 模型约 31 MB；翻译复用已安装的 HY 或已启用的 Argos。')}</p>
    </details>
  </div>;
}
