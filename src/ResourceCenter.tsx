import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, ExternalLink, LoaderCircle, Pause, Trash2, Upload } from 'lucide-react';
import type { DownloadCatalog, DownloadOptions, DownloadEntry, Settings } from './types';

const api = window.bestdict;
const size = (bytes: number) => bytes >= 1024 ** 3 ? (bytes / 1024 ** 3).toFixed(2) + ' GiB' : Math.round(bytes / 1024 ** 2) + ' MiB';
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');

export default function ResourceCenter({ t, translationEngine, onTranslationChange, onChanged }: {
  t: (text: string) => string; translationEngine: Settings['translationEngine'];
  onTranslationChange(value: Settings['translationEngine']): void; onChanged(): void;
}) {
  const [catalog, setCatalog] = useState<DownloadCatalog | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [options, setOptions] = useState<Record<string, DownloadOptions>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changed = useRef(onChanged); changed.current = onChanged;
  const signature = useRef('');
  useEffect(() => {
    let active = true, pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await api.getDownloads();
        if (!active) return;
        setCatalog(value);
        const next = value.entries.map(entry => entry.id + ':' + entry.ready + ':' + entry.count).join('|');
        if (signature.current && next !== signature.current) changed.current();
        signature.current = next;
      } catch (e) { if (active) setError(errorText(e)); }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 500);
    return () => { active = false; clearInterval(timer); if (copyTimer.current) clearTimeout(copyTimer.current); };
  }, []);
  function choice(entry: DownloadEntry): DownloadOptions {
    return options[entry.id] || catalog?.jobs.find(job => job.id === entry.id)?.options || { source: 'auto' };
  }
  async function perform(id: string, action: () => Promise<unknown>) {
    setError(''); setBusy(id);
    try { await action(); setCatalog(await api.getDownloads()); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  }
  async function enqueue(ids: string[]) {
    const choices = Object.fromEntries((catalog?.entries || []).filter(entry => ids.includes(entry.id)).map(entry => [entry.id, choice(entry)]));
    await perform('queue', () => api.queueDownloads(ids, choices));
    setSelected([]);
  }
  return <section className="resource-center" data-testid="resource-center">
    {!!catalog?.entries.some(entry => ['argos', 'hy-mt2'].includes(entry.id) && entry.ready) && <label className="resource-activation sentence-preference"><input type="radio" name="sentence-engine" checked={translationEngine === 'none'} onChange={() => onTranslationChange('none')} />{t('不开启句子翻译')}</label>}
    <div className="resource-toolbar">
      <span>{t('勾选可批量下载')}</span>
      {!!selected.length && <button className="small-download" disabled={!!busy} onClick={() => void enqueue(selected)}><Download size={13} />{t('下载所选')} ({selected.length} · {size((catalog?.entries || []).filter(entry => selected.includes(entry.id)).reduce((sum, entry) => sum + entry.bytes, 0))})</button>}
    </div>
    <div className="resource-row builtin"><div><strong>{t('英汉词库')}</strong><span>{t('内置 · 无需下载')}</span></div><Check size={16} /></div>
    {!catalog && <LoaderCircle size={18} className="spin" />}
    {catalog?.entries.map(entry => {
      const job = catalog.jobs.find(item => item.id === entry.id);
      const running = job?.state === 'running', queued = job?.state === 'queued';
      const paused = job?.state === 'paused' || job?.state === 'error' || entry.partialBytes > 0;
      const unsupported = entry.supported === false;
      const option = choice(entry);
      const percent = job?.total ? Math.min(100, (job.received || 0) / job.total * 100) : null;
      const status = unsupported ? '仅支持 Windows' : entry.ready ? '已安装' : queued ? '等待下载' : running ? job.phase === 'verifying' ? '正在验证文件…' : ['indexing', 'extracting'].includes(job.phase || '') ? '正在安装…' : '正在下载…' : paused ? '已暂停 · 可继续' : '未安装';
      const locked = !!busy || running || queued;
      return <div className="resource-item" key={entry.id} data-testid={'resource-' + entry.id}>
        <div className="resource-row">
          {!entry.ready && !unsupported && <input type="checkbox" aria-label={t('选择') + ' ' + t(entry.title)} disabled={locked}
            checked={selected.includes(entry.id)} onChange={e => setSelected(previous => e.target.checked ? [...previous, entry.id] : previous.filter(id => id !== entry.id))} />}
          <div className="resource-info"><strong>{t(entry.title)}</strong><span>{t(status)}{!unsupported && ' · ' + size(entry.bytes)}{entry.id === 'multi-dictionaries' && entry.ready && ' · ' + entry.count + '/4'}</span></div>
          {(running || queued) ? <button className="secondary-button" disabled={!!busy} onClick={() => void perform(entry.id, () => api.pauseDownload(entry.id))}><Pause size={13} />{t('暂停')}</button> :
            !entry.ready && !unsupported ? <button className="small-download" disabled={!!busy} onClick={() => void enqueue([entry.id])}><Download size={13} />{t(paused ? '继续下载' : '下载')}</button> :
              entry.ready && <Check size={16} className="resource-ready" />}
        </div>
        {entry.id === 'multi-dictionaries' && <p className="resource-languages">{t('西班牙语、日语、韩语、法语 → 中文')}</p>}
        {['argos', 'hy-mt2'].includes(entry.id) && entry.ready && <label className="resource-activation"><input type="radio" name="sentence-engine" checked={translationEngine === (entry.id === 'argos' ? 'argos' : 'hy')} onChange={() => onTranslationChange(entry.id === 'argos' ? 'argos' : 'hy')} />{t(translationEngine === (entry.id === 'argos' ? 'argos' : 'hy') ? '当前句子翻译方案' : '用作句子翻译')}</label>}
        {running && <div className="download-status" role="status"><span>{t(job.message || '正在下载…')}{percent !== null && job.phase === 'downloading' && ' · ' + percent.toFixed(0) + '%'}</span>{percent !== null && job.phase === 'downloading' && <progress value={percent} max={100} />}</div>}
        {job?.state === 'error' && <p className="error-banner" role="alert">{t(job.message || '下载失败，请重试。')}</p>}
        {!unsupported && <details className="resource-details"><summary>{t(entry.ready ? '管理与详情' : '下载选项与详情')}</summary>
          <div className="setting-row"><label htmlFor={'source-' + entry.id}>{t('下载来源')}</label><select id={'source-' + entry.id} disabled={locked} value={option.source || 'auto'}
            onChange={e => setOptions(previous => ({ ...previous, [entry.id]: { ...option, source: e.target.value,
              urls: option.urls || entry.sources[0].urls } }))}>
            <option value="auto">{t('自动（失败时换源）')}</option>{entry.sources.map(source => <option value={source.id} key={source.id}>{t(source.name)}</option>)}<option value="custom">{t('自定义地址')}</option>
          </select></div>
          {option.source === 'custom' && <label className="resource-custom">{t('下载地址（每行一个，顺序如下）')}<span>{entry.files.join(' · ')}</span><textarea rows={entry.files.length + 1} disabled={locked}
            value={(option.urls || entry.sources[0].urls).join('\n')} onChange={e => setOptions(previous => ({ ...previous, [entry.id]: { source: 'custom', urls: e.target.value.split('\n').map(value => value.trim()).filter(Boolean) } }))} /></label>}
          <div className="engine-actions">
            <button className="secondary-button" disabled={!!busy || catalog.jobs.some(item => item.state === 'running')} onClick={() => void perform(entry.id, async () => { await api.importResource(entry.id); changed.current(); })}><Upload size={13} />{t('导入本地文件')}</button>
            <button className="source-link" onClick={() => void perform(entry.id, () => api.openSource(entry.id))}><ExternalLink size={12} />{t('来源与许可')}</button>
            <button className="secondary-button" onClick={() => void perform(entry.id, async () => {
              const urls = option.source === 'custom' ? option.urls : entry.sources.find(source => source.id === option.source)?.urls || entry.sources[0].urls;
              await api.copy((urls || []).join('\n')); setCopied(entry.id);
              if (copyTimer.current) clearTimeout(copyTimer.current);
              copyTimer.current = setTimeout(() => setCopied(null), 2000);
            })}>{copied === entry.id ? <Check size={13} /> : <Copy size={13} />}{t(copied === entry.id ? '已复制' : '复制下载链接')}</button>
            {entry.ready && <button className="secondary-button" disabled={!!busy || catalog.jobs.some(item => item.state === 'running')} onClick={() => setRemoving(entry.id)}><Trash2 size={13} />{t('移除资源')}</button>}
            <button className="secondary-button" disabled={!!busy || catalog.jobs.some(item => item.state === 'running')} onClick={() => void perform(entry.id, () => api.clearDownloadCache(entry.id))}>{t('清理下载缓存')}</button>
          </div>
          <p>{entry.license}</p>
          {entry.id === 'hy-mt2' && <><p>{t('CPU 本地运行，推荐至少 8 GB 内存。')}</p><p>Built with Tencent Hunyuan</p></>}
          {entry.id === 'multi-dictionaries' && <p>{t('四种语言共享一次下载，统一建立索引。')}</p>}
          {removing === entry.id && <div className="resource-confirm"><span>{t('移除已安装文件及下载缓存？')}</span><button onClick={() => { setRemoving(null); void perform(entry.id, async () => { await api.removeResource(entry.id); changed.current(); }); }}>{t('确认移除')}</button><button onClick={() => setRemoving(null)}>{t('取消')}</button></div>}
        </details>}
      </div>;
    })}
    {error && <div className="error-banner" role="alert">{t(error)}</div>}
  </section>;
}
