import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Command, Copy, Download, ExternalLink, Leaf, LoaderCircle, Moon, Settings2, Sun, Trash2, Volume2, X } from 'lucide-react';
import type { ResourceCatalog, Settings, Status, SpeechCatalog, SpeechCacheStatus, UpdateStatus } from './types';
import { createTranslator } from './i18n';
import { useSpeech } from './useSpeech';
import SpeechButton from './SpeechButton';
import OCRSettings from './OCRSettings';
import ResourceCenter from './ResourceCenter';

const api = window.bestdict;
const prettyShortcut = (value: string) => value.replace(/Control/g, 'Ctrl').replace(/Command/g, '⌘').replace(/Super/g, 'Win').replace(/\+/g, ' + ');
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');

export default function SettingsDialog({ settings, status, catalog, initialTab, onClose, onSaved, onRefresh }: {
  settings: Settings; status: Status | null; catalog: ResourceCatalog | null; initialTab: string;
  onClose(): void; onSaved(settings: Settings): void; onRefresh(): void;
}) {
  const [draft, setDraft] = useState(settings);
  const t = createTranslator(draft.locale);
  const [tab, setTab] = useState(['engines', 'dictionaries'].includes(initialTab) ? 'resources' : initialTab);
  useEffect(() => { setTab(['engines', 'dictionaries'].includes(initialTab) ? 'resources' : initialTab); }, [initialTab]);
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { mounted.current = false; };
  }, []);
  async function resourcesChanged() {
    onRefresh();
    const current = await api.getSettings();
    if (!mounted.current) return;
    setDraft(previous => ({ ...previous,
      translationEngine: previous.translationEngine === settings.translationEngine ? current.translationEngine : previous.translationEngine,
      dictionaryId: previous.dictionaryId === settings.dictionaryId ? current.dictionaryId : previous.dictionaryId,
      speech: { ...previous.speech, engine: previous.speech.engine === settings.speech.engine ? current.speech.engine : previous.speech.engine },
    }));
    onSaved(current);
  }

  async function save() {
    if (saving) return;
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
        ['general', t("通用"), Settings2], ['resources', t('模型与词库'), BookOpen], ['speech', t('发音'), Volume2], ['capture', t('截图翻译'), Copy],
      ].map(([value, label, Icon]) => { const TabIcon = Icon as typeof Settings2; return <button key={value as string} role="tab" aria-selected={tab === value} onClick={() => setTab(value as string)}><TabIcon size={14} />{label as string}</button>; })}</div>
      <div className="settings-body">
        {tab === 'capture' && <OCRSettings t={t} onDownload={() => setTab('resources')} />}
        {tab === 'speech' && <>
          <div className="setting-row"><label htmlFor="speech-engine">{t('发音引擎')}</label><select id="speech-engine" value={draft.speech.engine} onChange={e => setDraft({ ...draft, speech: { ...draft.speech, engine: e.target.value as Settings['speech']['engine'] } })}>
            <option value="auto">{t('自动（优先 Kokoro）')}</option><option value="system">{t('系统语音')}</option><option value="kokoro" disabled={!catalog?.kokoro?.ready}>Kokoro</option>
          </select></div>
          <div className="setting-row"><label htmlFor="speech-rate">{t('语速')} <span>{draft.speech.rate.toFixed(1)}×</span></label><input id="speech-rate" className="speech-rate" type="range" min="0.5" max="2" step="0.1" value={draft.speech.rate} onChange={e => setDraft({ ...draft, speech: { ...draft.speech, rate: Number(e.target.value) } })} /></div>
          <div className="speech-previews">{(['zh', 'en'] as const).map(language => <div key={language} className="speech-preview" role="group" aria-label={t(language === 'zh' ? '试听中文' : '试听英文')}>
            <span>{t(language === 'zh' ? '试听中文' : '试听英文')}</span><SpeechButton active={preview.active === language} loading={preview.loading} t={t} onClick={() => void preview.toggle(language, { text: '', direction: language }, draft.speech)} />
          </div>)}</div>
          {preview.error && <div className="error-banner" role="alert">{t(preview.error)}</div>}
          {catalog?.kokoro?.ready && (draft.speech.engine === 'kokoro' || draft.speech.engine === 'auto') && (['zh', 'en'] as const).map(language => <div className="setting-row speech-voice" key={language}><label htmlFor={`kokoro-${language}`}>{t(language === 'zh' ? '中文音色' : '英文音色')}</label><select id={`kokoro-${language}`} disabled={!voices} value={draft.speech.kokoroVoices[language]} onChange={e => setDraft({ ...draft, speech: { ...draft.speech, kokoroVoices: { ...draft.speech.kokoroVoices, [language]: Number(e.target.value) } } })}>
            {voices ? voices.kokoro.filter(v => v.language === language).map(v => <option key={v.id} value={v.id}>{t(v.name)}</option>) : <option>{t('正在读取音色…')}</option>}
          </select></div>)}
          <details className="resource-details" open={draft.speech.engine === 'system' || (draft.speech.engine === 'auto' && !catalog?.kokoro?.ready)}><summary>{t('系统音色')}</summary>
            {(voiceError || voices?.systemError) && <p role="status">{t(voiceError || voices?.systemError || '')}</p>}
            {!voices && !voiceError && <p>{t('正在读取音色…')}</p>}
            {voices && [...new Set(['zh', 'en', ...voices.system.map(v => v.language.split(/[-_]/)[0])])].map(language => <div className="setting-row speech-voice" key={language}><label htmlFor={`system-${language}`}>{t(language === 'zh' ? '中文音色' : language === 'en' ? '英文音色' : language)}</label><select id={`system-${language}`} value={draft.speech.systemVoices[language] || ''} onChange={e => setDraft({ ...draft, speech: { ...draft.speech, systemVoices: { ...draft.speech.systemVoices, [language]: e.target.value } } })}>
              <option value="">{t(voices.system.some(v => v.language.split(/[-_]/)[0] === language) ? '自动选择' : '未安装该语言音色')}</option>{voices.system.filter(v => v.language.split(/[-_]/)[0] === language).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select></div>)}
          </details>
          {!catalog?.kokoro?.ready && <div className="setting-row"><span>{t('Kokoro 尚未安装')}</span><button className="secondary-button" onClick={() => setTab('resources')}>{t('前往下载')}</button></div>}
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
          <details className="resource-details"><summary>{t("本地资源信息")}</summary><div className="resource-card"><Leaf size={19} /><div><strong>{t(status?.dictionaryName || '英语 ↔ 中文')}</strong><p>{t('{count} 词条', { count: status?.dictionaryCount?.toLocaleString(draft.locale) || '—' })}<br />{t("句子翻译方案")} {settings.translationEngine === 'none' ? t("未开启") : settings.translationEngine === 'hy' ? t('混元 AI') : t('基础翻译')}</p></div></div></details>
        </>}
        {tab === 'resources' && <ResourceCenter t={t} translationEngine={draft.translationEngine}
          onTranslationChange={value => setDraft(previous => ({ ...previous, translationEngine: value }))}
          onChanged={() => void resourcesChanged().catch(e => setError(errorText(e)))} />}
        {error && <div className="error-banner" role="alert">{t(error)}</div>}

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
        <button className="save-button" disabled={saving} onClick={save}>{saving ? t("正在保存…") : t("保存设置")}<Check size={15} /></button></div>
    </div>
  </div>;
}
