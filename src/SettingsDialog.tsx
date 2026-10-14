import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Command, Copy, Download, ExternalLink, Leaf, LoaderCircle, Moon, Settings2, Sparkles, Sun, Trash2, Upload, Volume2, X } from 'lucide-react';
import type { ResourceCatalog, ResourceProgress, Settings, Status, SpeechCatalog, SpeechCacheStatus, UpdateStatus } from './types';
import { createTranslator } from './i18n';
import { useSpeech } from './useSpeech';
import SpeechButton from './SpeechButton';
import OCRSettings from './OCRSettings';

const api = window.bestdict;
const terminal = new Set(['complete', 'cancelled', 'error']);
const prettyShortcut = (value: string) => value.replace(/Control/g, 'Ctrl').replace(/Command/g, '⌘').replace(/Super/g, 'Win').replace(/\+/g, ' + ');
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');

export default function SettingsDialog({ settings, status, catalog, initialTab, onClose, onSaved, onRefresh }: {
  settings: Settings; status: Status | null; catalog: ResourceCatalog | null; initialTab: string;
  onClose(): void; onSaved(settings: Settings): void; onRefresh(): void;
}) {
  const [draft, setDraft] = useState(settings);
  const t = createTranslator(draft.locale);
  const [tab, setTab] = useState(initialTab);
  const preview = useSpeech();
  useEffect(() => { preview.stop(); }, [draft.speech, tab, preview.stop]);
  const [voices, setVoices] = useState<SpeechCatalog | null>(null);
  const [voiceError, setVoiceError] = useState('');
  const [audioCache, setAudioCache] = useState<SpeechCacheStatus | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheError, setCacheError] = useState('');
  const [cacheNotice, setCacheNotice] = useState('');
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateStatus | null>(null);
  const [updateError, setUpdateError] = useState('');
  useEffect(() => {
    if (tab !== 'speech' || cacheBusy) return;
    let active = true;
    void api.getSpeechCache().then(value => { if (active) { setAudioCache(value); setCacheError(''); } })
      .catch(() => { if (active) setCacheError('无法读取音频缓存，请重试。'); });
    return () => { active = false; };
  }, [tab, preview.loading, cacheBusy]);
  useEffect(() => {
    if (tab !== 'speech') return;
    let active = true;
    void api.getSpeechCatalog().then(value => { if (active) setVoices(value); }).catch(e => { if (active) setVoiceError(errorText(e)); });
    return () => { active = false; };
  }, [tab]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [installPending, setInstallPending] = useState(false);
  const installing = useRef(false);
  const [copiedLinks, setCopiedLinks] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [progress, setProgress] = useState<ResourceProgress | null>(catalog?.progress || null);
  const [job, setJob] = useState<string | null>(catalog?.progress && !terminal.has(catalog.progress.phase) ? catalog.progress.id : null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    if (catalog?.progress) {
      setProgress(catalog.progress);
      setJob(terminal.has(catalog.progress.phase) ? null : catalog.progress.id);
    }
  }, [catalog?.progress]);
  useEffect(() => {
    mounted.current = true;
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const remove = api.onResourceProgress(update => {
      setProgress(update);
      if (!terminal.has(update.phase)) setJob(update.id);
      else { setJob(null); onRefresh(); }
    });
    return () => { mounted.current = false; remove(); if (copyTimer.current) clearTimeout(copyTimer.current); };
  }, []);

  async function save() {
    if (installing.current || job || saving) return;
    setSaving(true); setError('');
    try { onSaved(await api.setSettings({ theme: draft.theme, locale: draft.locale, startup: draft.startup, shortcut: draft.shortcut,
      captureShortcut: draft.captureShortcut, miniShortcut: draft.miniShortcut, miniHideOnBlur: draft.miniHideOnBlur, miniRememberPosition: draft.miniRememberPosition,
      dictionaryId: draft.dictionaryId, translationEngine: draft.translationEngine, speech: draft.speech })); onClose(); }
    catch (e) { setError(errorText(e)); }
    finally { setSaving(false); }
  }

  async function clearAudioCache() {
    setCacheBusy(true); setCacheError(''); setCacheNotice('');
    try {
      const value = await api.clearSpeechCache();
      if (mounted.current) { setAudioCache(value); setCacheNotice('音频缓存已清理。'); }
    } catch { if (mounted.current) setCacheError('清理音频缓存失败，请重试。'); }
    finally { if (mounted.current) setCacheBusy(false); }
  }

  async function checkUpdate() {
    if (updateBusy) return;
    setUpdateBusy(true); setUpdateError(''); setUpdateResult(null);
    try {
      const result = await api.checkForUpdates();
      if (mounted.current) setUpdateResult(result);
    } catch (e) { if (mounted.current) setUpdateError(errorText(e)); }
    finally { if (mounted.current) setUpdateBusy(false); }
  }

  async function openUpdate(target: 'release' | 'download') {
    try { await api.openUpdatePage(target); }
    catch (e) { if (mounted.current) setUpdateError(errorText(e)); }
  }

  async function install(id: string, local: boolean) {
    installing.current = true;
    setInstallPending(true);
    setError('');
    setJob(id);
    try {
      const result = local ? await api.importResource(id) : await api.downloadResource(id);
      onRefresh();
      if (result && mounted.current) {
        if (id === 'argos' || id === 'hy-mt2' || id === 'kokoro') {
          const current = await api.getSettings();
          if (mounted.current) { setDraft(previous => ({ ...previous, translationEngine: current.translationEngine })); onSaved(current); }
        } else setDraft(previous => ({ ...previous, dictionaryId: id }));
      }
    } catch (e) { if (mounted.current) setError(errorText(e)); }
    finally { installing.current = false; if (mounted.current) { setJob(null); setInstallPending(false); } }
  }

  function engineState(engine: Settings['translationEngine']) {
    if (draft.translationEngine === engine && settings.translationEngine !== engine) return t('待保存启用');
    if (settings.translationEngine === engine) return draft.translationEngine === engine ? t('已启用') : t('待保存关闭');
    return t('已安装 · 未启用');
  }

  async function copyLinks(id: 'argos' | 'hy-mt2' | 'kokoro') {
    setError('');
    try {
      await api.copyDownloadLinks(id);
      if (!mounted.current) return;
      setCopiedLinks(id);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedLinks(null), 2500);
    } catch (e) { if (mounted.current) setError(errorText(e)); }
  }

  function copyButton(id: 'argos' | 'hy-mt2' | 'kokoro') {
    return <button className="secondary-button" onClick={() => void copyLinks(id)}>
      {copiedLinks === id ? <Check size={13} /> : <Copy size={13} />}
      {copiedLinks === id ? t(id === 'argos' ? '已复制两个链接' : '已复制') : t('复制下载链接')}
    </button>;
  }

  function downloadStatus(id: string) {
    if (progress?.id !== id) return null;
    const percent = progress.total && progress.received ? Math.min(100, progress.received / progress.total * 100) : null;
    return <div className={`download-status ${progress.phase === 'error' ? 'failed' : ''}`} role="status">
      <span>{!terminal.has(progress.phase) && <LoaderCircle size={13} className="spin" />}{t(progress.message)}{percent !== null && ` · ${percent.toFixed(0)}%`}</span>
      {percent !== null && !terminal.has(progress.phase) && <progress max={100} value={percent} aria-label={t("下载进度")} />}
      {job === id && <button onClick={() => void api.cancelDownload().catch(e => setError(errorText(e)))}>{t("取消")}</button>}
    </div>;
  }

  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="settings-dialog" data-tab={tab} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={e => {
      if (e.key !== 'Tab') return;
      const nodes = Array.from(dialogRef.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select, summary')).filter(node => node.getClientRects().length > 0);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }}>
      <div className="dialog-heading"><h2 id="settings-title">{t("设置")}</h2><button className="icon-button" aria-label={t("关闭设置")} onClick={onClose}><X size={19} /></button></div>
      <div className="settings-tabs" role="tablist" aria-label={t("设置分类")}>{[
        ['general', t("通用"), Settings2], ['dictionaries', t("词库"), BookOpen], ['engines', t("翻译引擎"), Sparkles], ['speech', t('发音'), Volume2], ['capture', t('截图翻译'), Copy],
      ].map(([value, label, Icon]) => { const TabIcon = Icon as typeof Settings2; return <button key={value as string} role="tab" aria-selected={tab === value} onClick={() => setTab(value as string)}><TabIcon size={14} />{label as string}</button>; })}</div>
      <div className="settings-body">
        {tab === 'capture' && <OCRSettings t={t} />}
        {tab === 'speech' && <>
          <div className="setting-row"><label htmlFor="speech-engine">{t('发音引擎')}</label><select id="speech-engine" value={draft.speech.engine} onChange={e => setDraft({ ...draft, speech: { ...draft.speech, engine: e.target.value as Settings['speech']['engine'] } })}>
            <option value="auto">{t('自动（优先 Kokoro）')}</option><option value="system">{t('系统语音')}</option><option value="kokoro">Kokoro</option>
          </select></div>
          <div className="setting-row"><label htmlFor="speech-rate">{t('语速')} <span>{draft.speech.rate.toFixed(1)}×</span></label><input id="speech-rate" className="speech-rate" type="range" min="0.5" max="2" step="0.1" value={draft.speech.rate} onChange={e => setDraft({ ...draft, speech: { ...draft.speech, rate: Number(e.target.value) } })} /></div>
          <div className="speech-previews">{(['zh', 'en'] as const).map(language => <div key={language} className="speech-preview" role="group" aria-label={t(language === 'zh' ? '试听中文' : '试听英文')}>
            <span>{t(language === 'zh' ? '试听中文' : '试听英文')}</span><SpeechButton active={preview.active === language} loading={preview.loading} t={t} onClick={() => void preview.toggle(language, { text: '', direction: language }, draft.speech)} />
          </div>)}</div>
          {preview.error && <div className="error-banner" role="alert">{t(preview.error)}</div>}
          {(draft.speech.engine === 'kokoro' || (draft.speech.engine === 'auto' && catalog?.kokoro?.ready)) && (['zh', 'en'] as const).map(language => <div className="setting-row speech-voice" key={language}><label htmlFor={`kokoro-${language}`}>{t(language === 'zh' ? '中文音色' : '英文音色')}</label><select id={`kokoro-${language}`} disabled={!voices} value={draft.speech.kokoroVoices[language]} onChange={e => setDraft({ ...draft, speech: { ...draft.speech, kokoroVoices: { ...draft.speech.kokoroVoices, [language]: Number(e.target.value) } } })}>
            {voices ? voices.kokoro.filter(v => v.language === language).map(v => <option key={v.id} value={v.id}>{t(v.name)}</option>) : <option>{t('正在读取音色…')}</option>}
          </select></div>)}
          <details className="resource-details" open={draft.speech.engine === 'system' || (draft.speech.engine === 'auto' && !catalog?.kokoro?.ready)}><summary>{t('系统音色')}</summary>
            {(voiceError || voices?.systemError) && <p role="status">{t(voiceError || voices?.systemError || '')}</p>}
            {!voices && !voiceError && <p>{t('正在读取音色…')}</p>}
            {voices && [...new Set(['zh', 'en', ...voices.system.map(v => v.language.split(/[-_]/)[0])])].map(language => <div className="setting-row speech-voice" key={language}><label htmlFor={`system-${language}`}>{t(language === 'zh' ? '中文音色' : language === 'en' ? '英文音色' : language)}</label><select id={`system-${language}`} value={draft.speech.systemVoices[language] || ''} onChange={e => setDraft({ ...draft, speech: { ...draft.speech, systemVoices: { ...draft.speech.systemVoices, [language]: e.target.value } } })}>
              <option value="">{t(voices.system.some(v => v.language.split(/[-_]/)[0] === language) ? '自动选择' : '未安装该语言音色')}</option>{voices.system.filter(v => v.language.split(/[-_]/)[0] === language).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select></div>)}
          </details>
          <div className="engine-card" data-testid="engine-kokoro"><div className="engine-heading"><div><strong>{t('中英离线语音包')}</strong><p>Kokoro v1.1 · INT8 · Apache-2.0</p></div><span className="engine-badge">{t(catalog?.kokoro?.ready ? '已安装' : '未安装')}</span></div>
            {!catalog?.kokoro?.ready && <button className="small-download" disabled={!!job || installPending} onClick={() => void install('kokoro', false)}><Download size={13} />{t('下载语音包')}<span>147 MB</span></button>}
            {downloadStatus('kokoro')}
            <details className="resource-details"><summary>{t('下载选项与模型说明')}</summary><p>{t('Windows 与 macOS 共用模型和音色，下载约 147 MB，安装后离线使用。')}</p><div className="engine-actions"><button className="secondary-button" disabled={!!job || installPending} onClick={() => void install('kokoro', true)}><Upload size={13} />{t('导入语音包')}</button>{copyButton('kokoro')}<button className="source-link" onClick={() => void api.openSource('kokoro').catch(e => setError(errorText(e)))}><ExternalLink size={12} />{t('官方来源')}</button></div></details>
          </div>
          <div className="speech-cache" data-testid="speech-cache">
            <div className="speech-cache-summary"><div><label>{t('音频缓存')}</label><p aria-live="polite">{audioCache ? t('{count} 条 · {size} MiB', { count: audioCache.count.toLocaleString(draft.locale), size: (audioCache.bytes / 1024 / 1024).toFixed(1) }) : t('正在读取缓存…')}</p></div>
              <button className="secondary-button" disabled={cacheBusy || !audioCache?.count} onClick={() => void clearAudioCache()}>{cacheBusy ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />}{t(cacheBusy ? '正在清理…' : '清理音频缓存')}</button>
            </div>
            <details className="resource-details"><summary>{t('发音与缓存说明')}</summary>
              <p>{t('点击译文旁的发音按钮播放，再点一次停止。语音在本机生成。')}</p>
              <p>{t('试听使用当前音色和语速，无需先保存。再次点击可停止。')}</p>
              <p>{t('未安装语音包时使用系统语音；其他语言始终使用对应系统音色。')}</p>
              <p>{t('首次播放后保存在本机，重复播放直接复用。更改音色或语速后重新生成。')}</p>
              {audioCache && <p>{t('最多 {size} MiB 或 {count} 条，超出后自动清理最久未使用的音频。', { size: audioCache.maxBytes / 1024 / 1024, count: audioCache.maxEntries.toLocaleString(draft.locale) })}</p>}
              <p>{t('清理只删除音频，保留语音模型。')}</p>
            </details>
            {cacheNotice && <p role="status">{t(cacheNotice)}</p>}{cacheError && <p role="alert">{t(cacheError)}</p>}
          </div>
        </>}
        {(error || settings.shortcutError || settings.miniShortcutError || settings.captureShortcutError) && <div className="error-banner" role="alert">{t(error || settings.shortcutError || settings.miniShortcutError || settings.captureShortcutError)}</div>}
        {tab === 'general' && <>
          <div className="setting-row"><label htmlFor="interface-language">{t("界面语言")}</label><select id="interface-language" className="language-select" value={draft.locale} onChange={e => setDraft({ ...draft, locale: e.target.value as Settings['locale'] })}><option value="zh-CN">{t("简体中文")}</option><option value="en">English</option></select></div>
          <div className="setting-row theme-setting"><label>{t("外观主题")}</label><div className="theme-options">{([['light', t("浅色"), Sun], ['dark', t("深色"), Moon], ['system', t("跟随系统"), Command]] as const).map(([value, label, Icon]) => <button key={value} aria-pressed={draft.theme === value} className={draft.theme === value ? 'picked' : ''} onClick={() => setDraft({ ...draft, theme: value })}><Icon size={15} />{label}</button>)}</div></div>
          <div className="setting-row"><label htmlFor="startup">{t("开机自动启动")}</label><input id="startup" type="checkbox" className="switch" disabled={!settings.startupAvailable} checked={draft.startup} onChange={e => setDraft({ ...draft, startup: e.target.checked })} /></div>
          {(['shortcut', 'miniShortcut', 'captureShortcut'] as const).filter(key => key !== 'captureShortcut' || settings.captureAvailable).map(key => <div className="setting-row shortcut-row" key={key}><label htmlFor={key}>{t(key === 'shortcut' ? "全局快捷键" : key === 'miniShortcut' ? '迷你模式快捷键' : '截图翻译快捷键')}</label><input id={key} className="shortcut-input" readOnly value={prettyShortcut(draft[key])} onKeyDown={e => {
            if (e.key === 'Tab' || e.key === 'Escape') return;
            e.preventDefault();
            if (!/^[a-z0-9]$/i.test(e.key) && !/^F\d{1,2}$/.test(e.key)) return;
            const modifiers = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
            if (modifiers.length) setDraft({ ...draft, [key]: [...modifiers, e.key.toUpperCase()].join('+') });
          }} /></div>)}
          <div className="setting-row"><label htmlFor="mini-hide">{t('迷你窗失焦后隐藏')}</label><input id="mini-hide" className="switch" type="checkbox" checked={draft.miniHideOnBlur} onChange={e => setDraft({ ...draft, miniHideOnBlur: e.target.checked })} /></div>
          <div className="setting-row"><label htmlFor="mini-position">{t('记住迷你窗位置')}</label><input id="mini-position" className="switch" type="checkbox" checked={draft.miniRememberPosition} onChange={e => setDraft({ ...draft, miniRememberPosition: e.target.checked })} /></div>
          <div className="setting-row"><label>{t("系统托盘")}</label>{settings.traySettingsAvailable && <button className="tray-settings-button" onClick={() => void api.openTraySettings().catch(e => setError(errorText(e)))}>{t("系统设置")}<ExternalLink size={12} /></button>}</div>
          <details className="resource-details"><summary>{t('使用说明')}</summary><p>{t('点击快捷键输入框，再按组合键。')}</p><p>{settings.startupAvailable ? t("登录系统后常驻托盘，不打扰工作。") : t("安装正式版本后可启用。")}</p><p>{t("点击图标打开窗口，右键查看菜单。")}</p></details>
          <details className="resource-details"><summary>{t("本地资源信息")}</summary><div className="resource-card"><Leaf size={19} /><div><strong>{t(status?.dictionaryName || '英语 ↔ 中文')}</strong><p>{t('{count} 词条', { count: status?.dictionaryCount?.toLocaleString(draft.locale) || '—' })}<br />{t("基础句子翻译：")} {settings.translationEngine === 'none' ? t("未开启") : 'Argos Translate'}</p></div></div></details>
        </>}
        {tab === 'dictionaries' && <>
          <div className="dictionary-catalog">{catalog?.dictionaries.map(item => <div className={`dictionary-card ${draft.dictionaryId === item.id ? 'picked' : ''}`} key={item.id} data-testid={`dictionary-${item.id}`}>
            <div className="dictionary-card-top"><div><strong>{t(item.name)}</strong><p>{item.installed ? t('{count} 词条', { count: item.count.toLocaleString(draft.locale) }) : t("尚未下载")} · {item.builtIn ? t("内置") : t("可选")}</p></div>
              {item.installed ? <button className={`dictionary-use ${draft.dictionaryId === item.id ? 'selected' : ''}`} aria-pressed={draft.dictionaryId === item.id} onClick={() => setDraft({ ...draft, dictionaryId: item.id })}>{draft.dictionaryId === item.id ? <><Check size={13} />{t("已选择")}</> : t("选择词库")}</button> : <button className="small-download" disabled={!!job || installPending} onClick={() => void install(item.id, false)}><Download size={13} />{t("下载")}</button>}
            </div>
            <div className="dictionary-card-bottom"><span>{t(item.source)}<span className="license-label">{t(item.license)}</span></span><div>{!item.installed && <button disabled={!!job || installPending} onClick={() => void install(item.id, true)}><Upload size={11} />{t("导入")}</button>}<button aria-label={t('查看{language}词库来源', { language: t(item.languageName) })} onClick={() => void api.openSource(item.id).catch(e => setError(errorText(e)))}><ExternalLink size={11} />{t("来源")}</button></div></div>
            {downloadStatus(item.id)}
          </div>)}</div>
          <details className="resource-details"><summary>{t('词库下载与数据说明')}</summary><p>{t("四种扩展词库共享中文版维基词典数据，首次下载约 224 MB，后续复用缓存，仅建立所选语言的索引。中文释义可能混用简繁体，覆盖率取决于社区词条。")}</p></details>
        </>}
        {tab === 'engines' && <>
          <div className={`engine-card ${draft.translationEngine === 'argos' ? 'picked' : ''}`} data-testid="engine-argos">
            <div className="engine-heading"><div><strong>{t('基础句子翻译')}</strong><p>Argos Translate · {t('中英双向')}</p></div><span className="engine-badge">{catalog?.argos.ready ? engineState('argos') : t('未安装')}</span></div>
            <div className="engine-primary">
              {catalog?.argos.ready ? <label className="engine-toggle" htmlFor="basic-sentence"><span>{t('自动翻译中英句子')}</span><input id="basic-sentence" type="checkbox" className="switch" checked={draft.translationEngine === 'argos'} onChange={e => setDraft(previous => ({ ...previous, translationEngine: e.target.checked ? 'argos' : 'none' }))} /></label> : <button className="small-download" disabled={!!job || installPending} onClick={() => void install('argos', false)}><Download size={13} />{t('下载中英模型')}<span>145 MB</span></button>}
            </div>
            {downloadStatus('argos')}
            <details className="resource-details"><summary>{t('下载选项与模型说明')}</summary>
              <p>{t('首次安装后默认开启；关闭后仍可查词，模型文件会保留。')}</p>
              <div className="engine-actions"><button className="secondary-button" disabled={!!job || installPending} onClick={() => void install('argos', true)}><Upload size={13} />{t('导入模型包')}</button>{copyButton('argos')}<button className="source-link" onClick={() => void api.openSource('argos').catch(e => setError(errorText(e)))}><ExternalLink size={12} />{t('官方来源')}</button></div>
              <p>{t('自行下载时需获取中英两个方向的模型包，导入时同时选择两个文件。')}</p>
            </details>
          </div>
          <div className="engine-card" data-testid="engine-hy">
            <div className="engine-heading"><div><strong>{t('AI 翻译')}</strong><p>Hy-MT2 · 1.8B · {t('多语言')}</p></div><span className="engine-badge">{catalog?.hy.ready ? t('已安装') : t('未安装')}</span></div>
            <div className="engine-primary">{catalog?.hy.ready ? <span className="installed-label"><Check size={13} />{t('可通过 AI 翻译按钮使用')}</span> : <button className="small-download" disabled={!!job || installPending} onClick={() => void install('hy-mt2', false)}><Download size={13} />{t('下载模型')}<span>1.13 GB</span></button>}</div>
            {downloadStatus('hy-mt2')}
            <details className="resource-details"><summary>{t('下载选项、运行要求与许可')}</summary>
              <p>{t('点击输入框右侧的 AI 翻译时运行，不替代 Argos。')}</p>
              <p>{t('CPU 本地运行，推荐至少 8 GB 内存。模型约 1.13 GB，首次使用需要下载或导入官方 GGUF 文件。')}</p>
              <div className="engine-actions"><button className="secondary-button" disabled={!!job || installPending} onClick={() => void install('hy-mt2', true)}><Upload size={13} />{t('导入 GGUF')}</button>{copyButton('hy-mt2')}<button className="source-link" onClick={() => void api.openSource('hy-mt2').catch(e => setError(errorText(e)))}><ExternalLink size={12} />{t('官方来源')}</button></div>
              <div className="model-license">{t('模型采用 Apache-2.0 许可，详情请阅读')}<button onClick={() => void api.openSource('hy-license').catch(e => setError(errorText(e)))}>{t('模型许可')}</button>。<span>Built with Tencent Hunyuan</span></div>
            </details>
          </div>
          <details className="resource-details"><summary>{t('离线运行与资源管理')}</summary><p>{t('两个模型可同时安装，均不会自动下载。AI 仅手动运行，空闲后释放模型内存；关闭基础翻译会保留已下载文件。')}</p></details>
        </>}

      </div>
      {(updateResult || updateError) && <div className="update-result" data-testid="update-result" role={updateError ? 'alert' : 'status'}>
        <span>{updateError ? t(updateError) : updateResult?.state === 'latest' ? t('未发现更新，当前版本 v{version}。', { version: updateResult.currentVersion }) :
          updateResult?.state === 'unpublished' ? t('暂未发布正式版本。') : <>{t('发现新版本 v{version}', { version: updateResult?.latestVersion || '' })}
            {updateResult?.state === 'unavailable' && <small>{t('此版本暂无适用于当前系统的安装包。')}</small>}</>}</span>
        <div>{!updateError && updateResult?.state === 'available' && <button onClick={() => void openUpdate('download')}><Download size={12} />{t('下载更新')}</button>}
          {(updateError || updateResult?.state !== 'latest') && <button onClick={() => void openUpdate('release')}><ExternalLink size={12} />{t(updateResult?.state === 'available' && !updateError ? '更新内容' : '打开发布页')}</button>}</div>
      </div>}
      <div className="dialog-footer"><button className="quit-button" onClick={() => api.quit()}>{t("退出 BestDict")}</button><span>v{status?.version || '0.4.3'}</span>
        <button className="update-check-button" disabled={updateBusy} onClick={() => void checkUpdate()}>{updateBusy && <LoaderCircle size={12} className="spin" />}{t(updateBusy ? '正在检查更新…' : '检查更新')}</button>
        <button className="save-button" disabled={saving || !!job || installPending} onClick={save}>{saving ? t("正在保存…") : t("保存设置")}<Check size={15} /></button></div>
    </div>
  </div>;
}
