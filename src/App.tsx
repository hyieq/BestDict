import AIStylePicker from './AIStylePicker';
import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeftRight, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronDown, Copy, Github, Globe2, Keyboard, LoaderCircle, Minus, Search, Settings2, Sparkles, X } from 'lucide-react';
import SettingsDialog from './SettingsDialog';
import appIcon from './assets/app-icon.png';
import { createTranslator } from './i18n';
import type { Direction, LookupResult, Mode, Settings, Status, Translation, ResourceCatalog, AIOptions } from './types';
import { isSentence } from '../electron/query-policy.mjs';
import { useSpeech } from './useSpeech';
import SpeechButton from './SpeechButton';
import MiniDictionary from './MiniDictionary';
import { PanelTop, ScanLine } from 'lucide-react';

const api = window.bestdict;
const emptyLookup: LookupResult = { entries: [], exact: false, corrected: false };
const tagNames: Record<string, string> = { cet4: 'CET-4', cet6: 'CET-6', ielts: 'IELTS', toefl: 'TOEFL', gre: 'GRE', gk: '高考', zk: '中考' };
const exchangeNames: Record<string, string> = { p: '过去式', d: '过去分词', i: '现在分词', '3': '第三人称', s: '复数', r: '比较级', t: '最高级', '0': '原形' };
const languageExamples: Record<string, string[]> = { es: ['hola', 'gracias', 'mañana'], ja: ['猫', 'ありがとう', '世界'], ko: ['사랑', '안녕하세요', '세계'], fr: ['bonjour', 'merci', 'liberté'] };
function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');
}
function prettyShortcut(value: string) { return value.replace(/Control/g, 'Ctrl').replace(/Command/g, '⌘').replace(/Super/g, 'Win').replace(/\+/g, ' + '); }

export default function App() {
  const [windowMode, setWindowMode] = useState({ mini: false, pinned: false });
  const mini = windowMode.mini;
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('auto');
  const [forcedQuery, setForcedQuery] = useState<string | null>(null);
  const [direction, setDirection] = useState<Direction>('auto');
  const [lookup, setLookup] = useState<LookupResult>(emptyLookup);
  const [selected, setSelected] = useState(0);
  const [translation, setTranslation] = useState<Translation | null>(null);
  const [resolvedMode, setResolvedMode] = useState<'dictionary' | 'translate'>('dictionary');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('general');
  const [catalog, setCatalog] = useState<ResourceCatalog | null>(null);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState('');
  const nextOptions = useRef<AIOptions>({});
  const [polishPrompt, setPolishPrompt] = useState('');
  useEffect(() => setPolishPrompt(''), [query]);
  const [composing, setComposing] = useState(false);
  const [runNonce, setRunNonce] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [systemDark, setSystemDark] = useState(window.matchMedia('(prefers-color-scheme: dark)').matches);
  const input = useRef<HTMLTextAreaElement>(null);
  const revision = useRef(0);
  const statusRevision = useRef(0);
  const immediateRun = useRef(false);
  const currentEntry = lookup.entries[selected];
  const activeStyle = settings?.aiStyles.find(s => s.id === settings.aiStyleId);
  const useHy = settings?.translationEngine === 'hy';
  const speech = useSpeech();
  useEffect(() => { speech.stop(); }, [query, selected, translation, busy, mode, direction, settingsOpen, settings?.dictionaryId, speech.stop]);
  const activeDictionary = catalog?.dictionaries.find(item => item.id === settings?.dictionaryId);
  const resultDictionary = catalog?.dictionaries.find(item => item.id === (currentEntry?.dictionaryId || lookup.dictionaryId || settings?.dictionaryId));
  const multilingualDictionary = !!settings?.dictionaryId && settings.dictionaryId !== 'ecdict';
  const sentenceEnabled = !!settings && settings.translationEngine !== 'none';
  const engineName = useHy ? '混元 AI' : '基础翻译';
  const t = createTranslator(settings?.locale || 'zh-CN');
  const dark = settings?.theme === 'dark' || (settings?.theme !== 'light' && systemDark);

  useEffect(() => {
    const remove = api.onCaptureOpen(data => {
      if (data.settings) { setSettingsTab(data.tab || 'capture'); setSettingsOpen(true); }
      else { setQuery(data.text); setMode('auto'); }
    });
    const removeError = api.onCaptureError(setError);
    return () => { remove(); removeError(); };
  }, []);

  useEffect(() => {
    if (!api) return;
    const update = (state: { mini: boolean; pinned: boolean }) => { setWindowMode(state); setSettingsOpen(false); };
    const unsubscribe = api.onWindowMode(update);
    void api.getWindowMode().then(update).catch(e => setError(errorText(e)));
    return unsubscribe;
  }, []);
  useEffect(() => { input.current?.focus(); input.current?.select(); speech.stop(); }, [mini]);

  function switchMini(value: boolean) {
    void api.setMiniMode(value).catch(e => setError(errorText(e)));
  }


  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  useEffect(() => { document.documentElement.lang = settings?.locale || 'zh-CN'; }, [settings?.locale]);

  useEffect(() => {
    if (!api) return;
    let active = true;
    const update = (appearance: Awaited<ReturnType<typeof api.getAppearance>>) => {
      if (active) document.documentElement.dataset.material = appearance.material;
    };
    const unsubscribe = api.onAppearance(update);
    void api.getAppearance().then(update).catch(() => {
      if (active) document.documentElement.dataset.material = 'fallback';
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!api) { setError(t("请通过 BestDict 桌面客户端打开。")); return; }
    refreshStatus();
    void api.getSettings().then(setSettings).catch(e => setError(errorText(e)));
    void api.getResources().then(setCatalog).catch(e => setError(errorText(e)));
    const unsubscribe = api.onFocus(() => { setSettingsOpen(false); input.current?.focus(); input.current?.select(); });
    const unsubscribeSettings = api.onOpenSettings(() => openSettings());
    const unsubscribeResources = api.onResourceProgress(progress => {
      if (['complete', 'cancelled', 'error'].includes(progress.phase)) void api.getResources().then(setCatalog).catch(e => setError(errorText(e)));
    });
    input.current?.focus();
    return () => { unsubscribe(); unsubscribeSettings(); unsubscribeResources(); };
  }, []);

  function invalidate(keepResult = false) {
    revision.current++;
    setBusy(false);
    if (!keepResult) setTranslation(null);
    nextOptions.current = {};
    setNotice('');
    setCopied(false);
    setError('');
    void api?.cancelTranslation().catch(() => {});
  }

  function changeQuery(value: string) {
    invalidate();
    if (mini) { setLookup(emptyLookup); setBusy(!!value.trim()); }
    immediateRun.current = false;
    setForcedQuery(null);
    if (!value.trim()) setMode('auto');
    if (!value.trim() || mode !== 'translate') setResolvedMode('dictionary');
    setQuery(value);
    setSelected(0);
    setExpanded(false);
  }

  function translateNow(options: AIOptions = {}) {
    if (!query.trim()) return;
    if (mini) { immediateRun.current = true; setRunNonce(n => n + 1); return; }
    const previousText = options.polishPrompt ? translation?.text : undefined;
    invalidate(!!translation);
    nextOptions.current = { ...options, previousText };
    immediateRun.current = true;
    setForcedQuery(query);
    setRunNonce(n => n + 1);
  }

  function changeMode(value: Mode) {
    invalidate();
    immediateRun.current = false;
    setForcedQuery(null);
    setMode(value);
  }

  useEffect(() => {
    if (!api || composing || !settings) return;
    const text = query.trim();
    const id = ++revision.current;
    let active = true;
    const immediate = immediateRun.current;
    immediateRun.current = false;
    const forceTranslation = forcedQuery === query;
    const delay = immediate ? 0 : mode === 'translate' ? 550 : 100;
    const timer = setTimeout(async () => {
      if (!text) { setLookup(emptyLookup); setTranslation(null); setResolvedMode('dictionary'); setBusy(false); return; }
      setError('');
      try {
        let result = emptyLookup;
        if ((mini || (!forceTranslation && mode !== 'translate')) && text.length <= 100 && !text.includes('\n')) result = await api.lookup(text);
        if (!active || id !== revision.current) return;
        setLookup(result);
        setSelected(index => Math.min(index, Math.max(0, result.entries.length - 1)));
        const useDictionary = mini || (!forceTranslation && (mode === 'dictionary' || (mode === 'auto' && (result.exact || !isSentence(text)))));
        setResolvedMode(useDictionary ? 'dictionary' : 'translate');
        if (useDictionary) { setBusy(false); return; }
        if (settings.translationEngine === 'none') { setBusy(false); return; }
        setBusy(true);
        if (mode !== 'translate' && !immediate) await new Promise(resolve => setTimeout(resolve, 450));
        if (!active || id !== revision.current) return;
        const options = nextOptions.current; nextOptions.current = {};
        const translated = await api.translate(text, direction, id, options);
        if (!active || id !== revision.current) return;
        if (options.forceRefresh && translation?.text === translated.text) setNotice('已重新生成，模型返回了相同译文。可尝试更具体的用词或句式要求。');
        setTranslation({ ...translated, styleName: useHy ? activeStyle?.name : undefined, polished: !!options.polishPrompt });
      } catch (e) {
        if (active && id === revision.current) setError(errorText(e));
      } finally {
        if (active && id === revision.current) setBusy(false);
      }
    }, delay);
    return () => { active = false; clearTimeout(timer); void api.cancelTranslation().catch(() => {}); };
  }, [query, mini, mode, forcedQuery, direction, composing, runNonce, settings?.dictionaryId, settings?.autoDictionary, settings?.translationEngine, activeStyle?.id, activeStyle?.prompt]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing || composing) return;
      if (mini && event.target === input.current && event.key === 'Enter') { event.preventDefault(); translateNow(); return; }
      if (event.key === 'Escape') {
        event.preventDefault();
        if (settingsOpen) { setSettingsOpen(false); input.current?.focus(); }
        else api?.hide();
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !settingsOpen) {
        event.preventDefault(); translateNow();
      }
      if (event.target === input.current && resolvedMode === 'dictionary' && lookup.entries.length) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + lookup.entries.length) % lookup.entries.length);
        }
        if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
          event.preventDefault();
          const word = lookup.entries[selected]?.word;
          if (word) changeQuery(word);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [query, mini, mode, composing, settingsOpen, resolvedMode, lookup, selected]);

  useEffect(() => {
    document.getElementById(`candidate-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  async function copyResult() {
    const text = resolvedMode === 'translate' ? translation?.text : currentEntry ? `${currentEntry.word}\n${currentEntry.translation}` : '';
    if (!text) return;
    try { await api.copy(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch (e) { setError(errorText(e)); }
  }

  function setQueryAndFocus(text: string) { changeQuery(text); input.current?.focus(); }

  function openSettings(tab = 'general') { refreshResources(); setSettingsTab(tab); setSettingsOpen(true); }
  function refreshResources() { void api.getResources().then(setCatalog).catch(e => setError(errorText(e))); }
  function refreshStatus() {
    const id = ++statusRevision.current;
    void api.status().then(value => { if (id === statusRevision.current) setStatus(value); }).catch(e => { if (id === statusRevision.current) setError(errorText(e)); });
  }
  function savedSettings(next: Settings) {
    if (next.dictionaryId !== settings?.dictionaryId || next.autoDictionary !== settings?.autoDictionary || next.translationEngine !== settings?.translationEngine) {
      invalidate();
      setLookup(emptyLookup);
    }
    setSettings(next);
    refreshStatus();
    refreshResources();
  }

  async function quickSettings(changes: Partial<Settings>) {
    invalidate();
    try { savedSettings(await api.setSettings(changes)); }
    catch (e) { setError(errorText(e)); }
  }

  function cancelTranslation() {
    revision.current++; setBusy(false); setNotice('已取消，可点击重新翻译。');
    void api.cancelTranslation().catch(() => {});
  }

  async function chooseEngine(value: string) {
    if (value === 'downloads' || (value === 'argos' && !catalog?.argos.ready) || (value === 'hy' && !catalog?.hy.ready)) { openSettings('resources'); return; }
    if (!useHy || value !== 'hy') setDirection('auto');
    await quickSettings({ translationEngine: value as Settings['translationEngine'] });
  }

  async function dismissTranslationNotice() {
    try { setSettings(await api.setSettings({ translationNoticeDismissed: true })); }
    catch (e) { setError(errorText(e)); }
  }

  if (mini) return <MiniDictionary query={query} entry={currentEntry} corrected={lookup.corrected} busy={busy} pinned={windowMode.pinned}
    copied={copied} error={error || speech.error || settings?.miniShortcutError || ''} input={input} t={t}
    onQuery={changeQuery} onSearch={translateNow} onCopy={() => void copyResult()} onComposition={setComposing}
    onExpand={() => switchMini(false)} onPin={() => void api.pinMini(!windowMode.pinned).catch(e => setError(errorText(e)))}
    speech={<SpeechButton active={speech.active === 'word'} loading={speech.loading} t={t} onClick={() => { if (currentEntry) void speech.toggle('word', {
      text: currentEntry.word, direction: resultDictionary?.id === 'ecdict' || !resultDictionary ? (/[\u3400-\u9fff]/.test(currentEntry.word) ? 'zh' : 'en') : resultDictionary.languageCode,
    }); }} />} />;

  return <div className="app-shell">
    <aside className="rail">
      <div className="brand-icon" title="BestDict"><img src={appIcon} alt="BestDict" /></div>
      <button className="rail-button active" title={t("词典")} aria-label={t("词典")} onClick={() => { setSettingsOpen(false); input.current?.focus(); }}><BookOpen size={21} /></button>
      <div className="rail-bottom"><span className="offline-dot" title={t("本地运行")} />
        <button className="rail-button" title={t("设置")} aria-label={t("设置")} onClick={() => openSettings()}><Settings2 size={20} /></button>
      </div>
    </aside>
    <main className="main-shell">
      <header className="titlebar">
        <div className="wordmark">Best<span>Dict</span></div>
        <div className="titlebar-actions"><span className="shortcut-pill"><Keyboard size={13} />{prettyShortcut(settings?.shortcut || 'Control+Shift+D')}</span>
          <button className="chrome-button" aria-label={t('迷你模式')} title={t('迷你模式') + ' · ' + prettyShortcut(settings?.miniShortcut || 'Alt+Shift+D')} onClick={() => switchMini(true)}><PanelTop size={18} /></button>
          {settings?.captureAvailable && <button className="chrome-button" aria-label={t('截图翻译')} title={t('截图翻译') + ' · ' + prettyShortcut(settings?.captureShortcut || 'Alt+Shift+S')} onClick={() => void api.startCapture().catch(e => setError(errorText(e)))}><ScanLine size={18} /></button>}
          <button className="chrome-button github-link" title={t("打开 GitHub 项目")} aria-label={t("打开 GitHub 项目")} onClick={() => void api.openSource('github').catch(e => setError(errorText(e)))}><Github size={19} aria-hidden="true" /><ArrowUpRight size={10} className="external-arrow" aria-hidden="true" /></button>
          <button className="chrome-button" aria-label={t("最小化")} onClick={() => api?.minimize()}><Minus size={17} /></button>
          <button className="chrome-button close" aria-label={t("隐藏窗口")} onClick={() => api?.hide()}><X size={17} /></button>
        </div>
      </header>
      <section className="workspace">
        <div className="search-row">
        <div className={`search-box ${mode === 'translate' || query.includes('\n') || query.length > 60 ? 'multiline' : ''}`}>
          <Search size={21} className="search-leading-icon" aria-hidden="true" />
          <textarea ref={input} aria-label={t("输入单词或句子")} placeholder={sentenceEnabled ? t("输入单词、词组，或粘贴一整句话…") : t("输入单词或词组，即时查词…")} value={query} maxLength={5000} rows={1}
            onChange={e => changeQuery(e.target.value)}
            onCompositionStart={() => { invalidate(); setComposing(true); }}
            onCompositionEnd={() => setComposing(false)} spellCheck={false} />
          <div className="search-actions">
            {query && <button className="icon-button clear-button" title={t("清空")} aria-label={t("清空")} onClick={() => setQueryAndFocus('')}><X size={16} /></button>}
          </div>
        </div>
        <div className="ai-button-group sentence-button-group"><button className="ai-trigger" aria-label={t(busy ? '取消翻译' : '翻译')} aria-keyshortcuts="Control+Enter" title="Ctrl + Enter" disabled={!query.trim() || composing} onClick={() => busy ? cancelTranslation() : translateNow({ forceRefresh: true })}>
          {busy ? <LoaderCircle size={24} className="spin" /> : useHy ? <Sparkles size={24} /> : <ArrowLeftRight size={24} />}{t(busy ? '取消翻译' : '翻译')}
        </button><div className="sentence-engine-picker"><select aria-label={t('句子翻译方案')} value={settings?.translationEngine || 'none'} onChange={e => void chooseEngine(e.target.value)}>
          <option value="none">{t('选择翻译方案')}</option><option value="argos">{t('基础翻译')}{!catalog?.argos.ready ? ' · ' + t('下载') : ''}</option><option value="hy">{t('混元 AI')}{!catalog?.hy.ready ? ' · ' + t('下载') : ''}</option><option value="downloads">{t('管理模型…')}</option>
        </select><ChevronDown size={12} /></div></div>
        </div>
        <div className="search-toolbar">
          <div className="segmented" aria-label={t("查询模式")}>{([['auto', t("自动")], ['dictionary', t("查词")], ['translate', t("句子翻译")]] as const).map(([value, label]) =>
            <button key={value} className={mode === value ? 'selected' : ''} aria-pressed={mode === value} onClick={() => changeMode(value)}>{label}</button>)}</div>
          {mode !== 'translate' && <div className="active-dictionary"><BookOpen size={12} /><select aria-label={t("选择当前词库")} value={settings?.dictionaryId || 'ecdict'} onChange={e => void quickSettings({ dictionaryId: e.target.value })}>
            {(catalog?.dictionaries || []).filter(item => item.installed).map(item => <option key={item.id} value={item.id}>{t('{language}词库', { language: t(item.languageName) })}</option>)}
          </select><ChevronDown size={11} /></div>}
          {(mode === 'translate' || resolvedMode === 'translate') && <div className="direction-picker"><ArrowLeftRight size={13} /><select aria-label={t("翻译方向")} value={direction} onChange={e => { invalidate(); setDirection(e.target.value as Direction); }}>
            {(['auto', 'en-zh', 'zh-en', ...(useHy ? ['es-zh', 'zh-es', 'ja-zh', 'zh-ja', 'ko-zh', 'zh-ko', 'fr-zh', 'zh-fr'] : [])]).map((value, index) => <option key={value} value={value}>{t(['自动识别语言', '英文 → 中文', '中文 → 英文', '西班牙语 → 中文', '中文 → 西班牙语', '日语 → 中文', '中文 → 日语', '韩语 → 中文', '中文 → 韩语', '法语 → 中文', '中文 → 法语'][index])}</option>)}
            </select><ChevronDown size={12} /></div>}
          {mode !== 'translate' && <label className="auto-dictionary" title={t("在已安装词库中自动匹配；关闭后只查当前词库。")}>{t("自动匹配词库")}<input type="checkbox" aria-label={t("自动匹配词库")} checked={settings?.autoDictionary ?? true} onChange={e => { void quickSettings({ autoDictionary: e.target.checked }); }} /></label>}
          {useHy && <div className="sentence-style"><AIStylePicker settings={settings} onSaved={next => {
            const style = next.aiStyles.find(item => item.id === next.aiStyleId);
            if (style?.id !== activeStyle?.id || style?.prompt !== activeStyle?.prompt) { invalidate(true); nextOptions.current = { forceRefresh: true }; }
            savedSettings(next);
          }} /></div>}
        </div>
        {settings && !settings.translationNoticeDismissed && <div className="translation-engine-notice" data-testid="translation-engine-notice">
          <button className={`translation-engine-status ${sentenceEnabled ? 'enabled' : ''}`} data-testid="translation-engine-status" onClick={() => openSettings('engines')}><ArrowLeftRight size={13} /><span>{t('句子翻译方案')}：{sentenceEnabled ? t(engineName) : t('未开启')}</span><span>{sentenceEnabled ? t('已启用') : t('设置')}<ChevronDown size={12} /></span></button>
          <button className="translation-notice-close" aria-label={t('关闭翻译状态提示')} title={t('关闭翻译状态提示')} onClick={() => void dismissTranslationNotice()}><X size={14} /></button>
        </div>}
        {(error || status?.error || status?.shortcutError) && <div className="error-banner" role="alert">{t(error || status?.error || status?.shortcutError || '')}</div>}
        {speech.error && <div className="error-banner" role="alert">{t(speech.error)}</div>}
        <div className="results-stack">
        <section className={`result-area ${!query.trim() ? 'empty-area' : ''}`} aria-live="polite" aria-busy={busy}>
          {!query.trim() ? <div className="welcome">
            <div className="welcome-art"><img src={appIcon} alt="" /></div>
            <p>{t("输入单词或词组开始查询。")}<br />{!sentenceEnabled && t("整句翻译可在设置中开启。")}</p>
            <div className="example-words">{(multilingualDictionary ? languageExamples[activeDictionary?.languageCode || ''] || [activeDictionary?.example || ''] : ['serendipity', 'resilience', '恰到好处']).filter(Boolean).map(word => <button key={word} onClick={() => setQueryAndFocus(word)}>{word}<ArrowRight size={12} /></button>)}</div>
            <button className="sentence-example" onClick={() => { if (!sentenceEnabled) { openSettings('engines'); return; } setMode('auto'); setQueryAndFocus('The best way to predict the future is to create it.'); }}>{sentenceEnabled ? t("试试整句翻译") : t("按需开启整句翻译")}<ArrowRight size={13} /></button>
          </div> : resolvedMode === 'translate' ? <div className="translation-panel">
            <div className="panel-heading"><span className="eyebrow">{translation?.direction === 'zh-en' ? t("英文译文") : t("整句翻译")}</span><span className="source-label"><Globe2 size={12} />{!sentenceEnabled ? t("按需启用") : t(engineName)}</span></div>
            {!sentenceEnabled ? <div className="no-results" data-testid="translation-disabled"><ArrowLeftRight size={25} /><h3>{t('句子翻译尚未开启')}</h3><button className="secondary-button" onClick={() => openSettings('resources')}>{t('选择或下载翻译模型')}<ArrowRight size={14} /></button></div> : <>
              {busy && <div className={translation ? 'ai-loading' : 'loading-state'}><LoaderCircle size={23} className="spin" /><span>{t('正在翻译…')}</span></div>}
              {translation && <>
                <p className="translation-text" data-testid="translation-result">{translation.text}</p>
                <div className="translation-meta"><span>{translation.engine}{useHy ? ' · ' + t(translation.styleName || '基本') : ''}{translation.polished ? ' · ' + t('已润色') : ''}{translation.cached ? t(' · 已缓存') : ''}</span><div className="result-actions"><SpeechButton active={speech.active === 'translation'} loading={speech.loading} t={t} onClick={() => void speech.toggle('translation', translation)} /><button className="copy-button" onClick={copyResult}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? t('已复制') : t('复制译文')}</button><button className="secondary-button" disabled={busy} onClick={() => translateNow({ forceRefresh: true })}>{t('重新翻译')}</button></div></div>
                {useHy && <details className="translation-more"><summary>{t('润色译文')}</summary><div className="ai-polish"><label htmlFor="polish-prompt">{t('自定义润色提示词')}</label><input type="text" id="polish-prompt" value={polishPrompt} maxLength={1000} placeholder={t('例如：更像日常聊天，简短一点，保留关键细节。')} onChange={e => setPolishPrompt(e.target.value)} /><button className="secondary-button" disabled={busy || !polishPrompt.trim()} onClick={() => translateNow({ polishPrompt: polishPrompt.trim(), forceRefresh: true })}>{t('润色并刷新')}</button></div></details>}
              </>}
              {notice && <p className="quality-note" role="status">{t(notice)}</p>}
              {!translation && !busy && !notice && !error && <div className="no-results"><ArrowLeftRight size={25} /><h3>{t('准备翻译')}</h3><p>{t('继续输入，或按 Ctrl + Enter 立即翻译。')}</p></div>}
            </>}

          </div> : <>
            <aside className="candidates"><div className="candidate-heading">{lookup.corrected ? t("相近拼写") : t("推荐词条")}<span>{lookup.entries.length ? t('{count} 条', { count: lookup.entries.length }) : ''}</span></div>
              <div className="candidate-list" role="listbox" aria-label={t("推荐词条")}>{lookup.entries.map((entry, index) => <button id={`candidate-${index}`} key={`${entry.dictionaryId}-${entry.id}`} role="option" aria-selected={index === selected} className={`candidate ${index === selected ? 'chosen' : ''}`} onClick={() => { setSelected(index); setExpanded(false); }}>
                <strong>{entry.word}{settings?.autoDictionary && <small className="candidate-language">{t(catalog?.dictionaries.find(item => item.id === entry.dictionaryId)?.languageName || '英语')}</small>}</strong><span>{entry.translation.split('\n')[0]}</span>{index === selected && <ArrowRight size={13} className="candidate-arrow" />}</button>)}</div>
              <div className="candidate-hint"><ArrowDown size={12} />{t("上下选择")}<span>{t("↵ 确认")}</span></div>
            </aside>
            <article className="entry-panel" key={`${currentEntry?.dictionaryId}-${currentEntry?.id}`}>
              {currentEntry ? <>
                <div className="panel-heading"><span className="eyebrow">{resultDictionary?.id !== 'ecdict' ? t(resultDictionary?.name || '中文释义') : /[\u3400-\u9fff]/.test(query) ? t("汉英词条") : t("英汉词条")}</span><button className="icon-button" title={t("复制释义")} aria-label={t("复制释义")} onClick={copyResult}>{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>
                <div className="entry-word-row"><h2 className="entry-word" data-testid="entry-word">{currentEntry.word}</h2><SpeechButton active={speech.active === 'word'} loading={speech.loading} t={t} onClick={() => void speech.toggle('word', {
                  text: currentEntry.word,
                  direction: resultDictionary?.id === 'ecdict' || !resultDictionary ? (/[\u3400-\u9fff]/.test(currentEntry.word) ? 'zh' : 'en') : resultDictionary.languageCode,
                })} /></div>
                {currentEntry.phonetic && <div className="phonetic">/{currentEntry.phonetic.replace(/^\/+|\/+$/g, '')}/</div>}
                <div className="entry-tags">{currentEntry.tags.split(' ').filter(tag => tagNames[tag]).slice(0, 4).map(tag => <span key={tag}>{t(tagNames[tag])}</span>)}</div>
                <div className="definition-list">{currentEntry.translation.split('\n').filter(Boolean).map((line, index) => {
                  const match = line.match(/^([a-z]+\.)\s*(.*)$/);
                  return <div className="definition-row" key={index}>{match ? <><span className="pos-label">{match[1]}</span><p>{match[2]}</p></> : <p>{line}</p>}</div>;
                })}</div>
                {currentEntry.exchange && <div className="word-forms"><div className="section-caption">{t("词形变化")}</div><div className="forms-grid">{currentEntry.exchange.split('/').map(item => {
                  const [type, word] = item.split(':');
                  return exchangeNames[type] && word ? <button key={type} onClick={() => setQueryAndFocus(word)}><span>{t(exchangeNames[type])}</span>{word}</button> : null;
                })}</div></div>}
                {currentEntry.definition && <div className="english-definition"><button onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{t("英文释义")}<ChevronDown size={14} className={expanded ? 'rotated' : ''} /></button>{expanded && <p>{currentEntry.definition}</p>}</div>}
                <button className="entry-source source-link" onClick={() => void api.openSource(resultDictionary?.id || 'ecdict').catch(e => setError(errorText(e)))}>{t("词库来源 ·")} {t(resultDictionary?.source || 'ECDICT')}</button>
              </> : <div className="no-results"><Search size={26} /><h3>{t("暂未找到这个词条")}</h3><p>{t("试试其他拼写，或切换到翻译。")}</p><button className="secondary-button" onClick={() => translateNow()}>{t("翻译这段内容")}<ArrowRight size={14} /></button></div>}
            </article>
          </>}
        </section>

        </div>
      </section>
      <footer className="statusbar"><span><i className={status?.dictionaryCount && (!sentenceEnabled || status.modelReady) ? 'ready' : ''} />{status?.dictionaryCount && (!sentenceEnabled || status.modelReady) ? t("离线资源已就绪") : status ? t("本地资源尚未就绪") : t("正在检查本地资源")}<span className="footer-divider">·</span>{status?.dictionaryCount ? t('{count} 词条', { count: status.dictionaryCount.toLocaleString(settings?.locale) }) : 'ECDICT'}<span className="footer-divider">·</span>{!sentenceEnabled ? t("仅查词") : t(engineName)}</span><span>{t("Esc 隐藏")}</span></footer>
    </main>
    {settingsOpen && settings && <SettingsDialog settings={settings} status={status} catalog={catalog} initialTab={settingsTab} onClose={() => { setSettingsOpen(false); input.current?.focus(); }} onSaved={savedSettings} onRefresh={refreshResources} />}
  </div>;
}
