import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeftRight, ArrowRight, BookOpen, Check, ChevronDown, Copy, Globe2, Keyboard, LoaderCircle, Minus, Search, Settings2, Sparkles, X } from 'lucide-react';
import SettingsDialog from './SettingsDialog';
import appIcon from './assets/app-icon.png';
import { createTranslator } from './i18n';
import type { Direction, LookupResult, Mode, Settings, Status, Translation, ResourceCatalog } from './types';
import { isSentence } from '../electron/query-policy.mjs';
import { useAITranslation } from './useAITranslation';

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
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('auto');
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
  const [aiCopied, setAICopied] = useState(false);
  const [composing, setComposing] = useState(false);
  const [runNonce, setRunNonce] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [systemDark, setSystemDark] = useState(window.matchMedia('(prefers-color-scheme: dark)').matches);
  const input = useRef<HTMLTextAreaElement>(null);
  const aiPanel = useRef<HTMLElement>(null);
  const revision = useRef(0);
  const statusRevision = useRef(0);
  const immediateRun = useRef(false);
  const currentEntry = lookup.entries[selected];
  const ai = useAITranslation(query);
  const activeDictionary = catalog?.dictionaries.find(item => item.id === settings?.dictionaryId);
  const resultDictionary = catalog?.dictionaries.find(item => item.id === (currentEntry?.dictionaryId || lookup.dictionaryId || settings?.dictionaryId));
  const multilingualDictionary = !!settings?.dictionaryId && settings.dictionaryId !== 'ecdict';
  const sentenceEnabled = settings?.translationEngine === 'argos';
  const aiReady = catalog?.hy.ready ?? false;
  const t = createTranslator(settings?.locale || 'zh-CN');
  const dark = settings?.theme === 'dark' || (settings?.theme !== 'light' && systemDark);

  useEffect(() => {
    if (ai.visible && ai.expanded) aiPanel.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [ai.visible, ai.expanded, ai.busy]);

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

  function invalidate() {
    revision.current++;
    setBusy(false);
    setTranslation(null);
    setCopied(false);
    setError('');
    void api?.cancelTranslation().catch(() => {});
  }

  function changeQuery(value: string) {
    invalidate();
    setQuery(value);
    setSelected(0);
    setExpanded(false);
  }

  function translateNow() {
    invalidate();
    immediateRun.current = true;
    setMode('translate');
    setRunNonce(n => n + 1);
  }

  useEffect(() => {
    if (!api || composing || !settings) return;
    const text = query.trim();
    const id = ++revision.current;
    let active = true;
    const immediate = immediateRun.current;
    immediateRun.current = false;
    const delay = immediate ? 0 : mode === 'translate' ? 550 : 100;
    const timer = setTimeout(async () => {
      if (!text) { setLookup(emptyLookup); setTranslation(null); setBusy(false); return; }
      setError('');
      try {
        let result = emptyLookup;
        if (mode !== 'translate' && text.length <= 100 && !text.includes('\n')) result = await api.lookup(text);
        if (!active || id !== revision.current) return;
        setLookup(result);
        setSelected(0);
        const useDictionary = mode === 'dictionary' || (mode === 'auto' && (result.exact || !isSentence(text)));
        setResolvedMode(useDictionary ? 'dictionary' : 'translate');
        if (useDictionary) { setBusy(false); return; }
        if (settings.translationEngine === 'none') { setBusy(false); return; }
        setBusy(true);
        if (mode !== 'translate' && !immediate) await new Promise(resolve => setTimeout(resolve, 450));
        if (!active || id !== revision.current) return;
        const translated = await api.translate(text, direction, id);
        if (!active || id !== revision.current) return;
        setTranslation(translated);
      } catch (e) {
        if (active && id === revision.current) setError(errorText(e));
      } finally {
        if (active && id === revision.current) setBusy(false);
      }
    }, delay);
    return () => { active = false; clearTimeout(timer); };
  }, [query, mode, direction, composing, runNonce, settings?.dictionaryId, settings?.autoDictionary, settings?.translationEngine]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing || composing) return;
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
  }, [composing, settingsOpen, resolvedMode, lookup, selected]);

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
          <button className="chrome-button" aria-label={t("最小化")} onClick={() => api?.minimize()}><Minus size={17} /></button>
          <button className="chrome-button close" aria-label={t("隐藏窗口")} onClick={() => api?.hide()}><X size={17} /></button>
        </div>
      </header>
      <section className="workspace">
        <div className="search-box">
          <Search size={21} className="search-icon" />
          <textarea ref={input} aria-label={t("输入单词或句子")} placeholder={sentenceEnabled ? t("输入单词、词组，或粘贴一整句话…") : t("输入单词或词组，即时查词…")} value={query} maxLength={5000} rows={2}
            onChange={e => changeQuery(e.target.value)}
            onCompositionStart={() => { invalidate(); setComposing(true); }}
            onCompositionEnd={() => setComposing(false)} spellCheck={false} />
          <div className="search-actions">
            <button className="ai-trigger" disabled={!query.trim() || composing} title={t(aiReady ? '手动调用 HY，不影响日常查词和句子翻译。' : '安装 HY 后可使用 AI 翻译。')} onClick={() => { setAICopied(false); if (ai.busy) ai.cancel(); else if (!aiReady) openSettings('engines'); else void ai.run(); }}>
              {ai.busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}{t(ai.busy ? '取消 AI 翻译' : 'AI 翻译')}
            </button>
            {query && <button className="icon-button clear-button" title={t("清空")} aria-label={t("清空")} onClick={() => setQueryAndFocus('')}><X size={16} /></button>}
          </div>
        </div>
        <div className="search-toolbar">
          <div className="segmented" aria-label={t("查询模式")}>{([['auto', t("自动")], ['dictionary', t("查词")], ['translate', t("句子翻译")]] as const).map(([value, label]) =>
            <button key={value} className={mode === value ? 'selected' : ''} aria-pressed={mode === value} onClick={() => { invalidate(); setMode(value); }}>{label}</button>)}</div>
          {mode !== 'translate' && <div className="active-dictionary"><BookOpen size={12} /><select aria-label={t("选择当前词库")} value={settings?.dictionaryId || 'ecdict'} onChange={e => void quickSettings({ dictionaryId: e.target.value })}>
            {(catalog?.dictionaries || []).filter(item => item.installed).map(item => <option key={item.id} value={item.id}>{t('{language}词库', { language: t(item.languageName) })}</option>)}
          </select><ChevronDown size={11} /></div>}
          {(mode === 'translate' || resolvedMode === 'translate') && <div className="direction-picker"><ArrowLeftRight size={13} /><select aria-label={t("翻译方向")} value={direction} onChange={e => { invalidate(); setDirection(e.target.value as Direction); }}>
            <option value="auto">{t("自动识别语言")}</option><option value="en-zh">{t("英文 → 中文")}</option><option value="zh-en">{t("中文 → 英文")}</option>
            </select><ChevronDown size={12} /></div>}
          {mode !== 'translate' && <label className="auto-dictionary" title={t("在已安装词库中自动匹配；关闭后只查当前词库。")}>{t("自动匹配词库")}<input type="checkbox" aria-label={t("自动匹配词库")} checked={settings?.autoDictionary ?? true} onChange={e => { void quickSettings({ autoDictionary: e.target.checked }); }} /></label>}
          <button className="translate-trigger" disabled={!query.trim() || busy} onClick={translateNow}>{busy ? <LoaderCircle size={14} className="spin" /> : <ArrowRight size={14} />}{t("翻译")}<span>Ctrl ↵</span></button>
        </div>
        <button className={`translation-engine-status ${sentenceEnabled ? 'enabled' : ''}`} data-testid="translation-engine-status" onClick={() => openSettings('engines')}><ArrowLeftRight size={13} /><span>{t('基础句子翻译：')}{sentenceEnabled ? 'Argos Translate' : t('未开启')}</span><span>{sentenceEnabled ? t('已启用') : t('设置')}<ChevronDown size={12} /></span></button>
        {(error || status?.error || status?.shortcutError) && <div className="error-banner" role="alert">{t(error || status?.error || status?.shortcutError || '')}</div>}
        <div className={`results-stack ${ai.visible ? 'has-ai' : ''}`}>
        <section className={`result-area ${!query.trim() ? 'empty-area' : ''}`} aria-live="polite" aria-busy={busy}>
          {!query.trim() ? <div className="welcome">
            <div className="welcome-art"><img src={appIcon} alt="" /></div>
            <p>{t("输入单词或词组开始查询。")}<br />{!sentenceEnabled && t("整句翻译可在设置中开启。")}</p>
            <div className="example-words">{(multilingualDictionary ? languageExamples[activeDictionary?.languageCode || ''] || [activeDictionary?.example || ''] : ['serendipity', 'resilience', '恰到好处']).filter(Boolean).map(word => <button key={word} onClick={() => setQueryAndFocus(word)}>{word}<ArrowRight size={12} /></button>)}</div>
            <button className="sentence-example" onClick={() => { if (!sentenceEnabled) { openSettings('engines'); return; } setMode('translate'); setQueryAndFocus('The best way to predict the future is to create it.'); }}>{sentenceEnabled ? t("试试整句翻译") : t("按需开启整句翻译")}<ArrowRight size={13} /></button>
          </div> : resolvedMode === 'translate' ? <div className="translation-panel">
            <div className="panel-heading"><span className="eyebrow">{translation?.direction === 'zh-en' ? t("英文译文") : t("整句翻译")}</span><span className="source-label"><Globe2 size={12} />{!sentenceEnabled ? t("按需启用") : 'Argos Translate'}</span></div>
            {!sentenceEnabled ? <div className="no-results" data-testid="translation-disabled"><ArrowLeftRight size={25} /><h3>{t("基础句子翻译尚未开启")}</h3><p>{t("安装 Argos 可自动翻译中英句子。")}<br />{t("也可以点击输入框右侧的 AI 翻译。")}</p><button className="secondary-button" onClick={() => openSettings('engines')}>{t("设置基础翻译")}<ArrowRight size={14} /></button></div> : busy ? <div className="loading-state"><LoaderCircle size={23} className="spin" /><h3>{t("正在翻译…")}</h3><p>{t("首次翻译需要加载本地模型，稍候即可。")}</p></div> : translation ? <>
              <p className="translation-text" data-testid="translation-result">{translation.text}</p>
              <div className="translation-meta"><span>{translation.engine} {t("· CPU 离线翻译")}{translation.cached ? t(" · 已缓存") : ''}</span><button className="copy-button" onClick={copyResult}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? t("已复制") : t("复制译文")}</button></div>
              <div className="quality-note">{t("需要 AI 译文时，点击输入框右侧的 AI 翻译。")}</div>
            </> : <div className="no-results"><ArrowLeftRight size={25} /><h3>{t("准备翻译")}</h3><p>{t("继续输入，或按 Ctrl + Enter 立即翻译。")}</p></div>}
          </div> : <>
            <aside className="candidates"><div className="candidate-heading">{lookup.corrected ? t("相近拼写") : t("推荐词条")}<span>{lookup.entries.length ? t('{count} 条', { count: lookup.entries.length }) : ''}</span></div>
              <div className="candidate-list" role="listbox" aria-label={t("推荐词条")}>{lookup.entries.map((entry, index) => <button id={`candidate-${index}`} key={`${entry.dictionaryId}-${entry.id}`} role="option" aria-selected={index === selected} className={`candidate ${index === selected ? 'chosen' : ''}`} onClick={() => { setSelected(index); setExpanded(false); }}>
                <strong>{entry.word}{settings?.autoDictionary && <small className="candidate-language">{t(catalog?.dictionaries.find(item => item.id === entry.dictionaryId)?.languageName || '英语')}</small>}</strong><span>{entry.translation.split('\n')[0]}</span>{index === selected && <ArrowRight size={13} className="candidate-arrow" />}</button>)}</div>
              <div className="candidate-hint"><ArrowDown size={12} />{t("上下选择")}<span>{t("↵ 确认")}</span></div>
            </aside>
            <article className="entry-panel">
              {currentEntry ? <>
                <div className="panel-heading"><span className="eyebrow">{resultDictionary?.id !== 'ecdict' ? t(resultDictionary?.name || '中文释义') : /[\u3400-\u9fff]/.test(query) ? t("汉英词条") : t("英汉词条")}</span><button className="icon-button" title={t("复制释义")} aria-label={t("复制释义")} onClick={copyResult}>{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>
                <h2 className="entry-word" data-testid="entry-word">{currentEntry.word}</h2>
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
              </> : <div className="no-results"><Search size={26} /><h3>{t("暂未找到这个词条")}</h3><p>{t("试试其他拼写，或切换到翻译。")}</p><button className="secondary-button" onClick={() => { invalidate(); setMode('translate'); }}>{t("翻译这段内容")}<ArrowRight size={14} /></button></div>}
            </article>
          </>}
        </section>
        {ai.visible && <section ref={aiPanel} className="ai-result" data-testid="ai-panel" aria-label={t('AI 译文')} aria-live="polite" aria-busy={ai.busy}>
          <div className="ai-result-heading"><button className="ai-collapse" aria-expanded={ai.expanded} onClick={() => ai.setExpanded(!ai.expanded)}><Sparkles size={15} />{t('AI 译文')}<ChevronDown size={14} className={ai.expanded ? 'rotated' : ''} /></button><span>HY-MT1.5</span></div>
          {ai.expanded && <div className="ai-result-body">
            <div className="ai-controls"><label>{t('AI 翻译方向')}<select aria-label={t('AI 翻译方向')} value={ai.direction} onChange={e => ai.setDirection(e.target.value as Direction)}>
              {(['auto', 'en-zh', 'zh-en', 'es-zh', 'zh-es', 'ja-zh', 'zh-ja', 'ko-zh', 'zh-ko', 'fr-zh', 'zh-fr'] as const).map((value, index) => <option key={value} value={value}>{t(['自动识别语言', '英文 → 中文', '中文 → 英文', '西班牙语 → 中文', '中文 → 西班牙语', '日语 → 中文', '中文 → 日语', '韩语 → 中文', '中文 → 韩语', '法语 → 中文', '中文 → 法语'][index])}</option>)}
            </select></label><button className="secondary-button" onClick={() => { setAICopied(false); if (ai.busy) ai.cancel(); else void ai.run(); }}>{t(ai.busy ? '取消' : '重新翻译')}</button></div>
            {ai.busy ? <div className="ai-loading"><LoaderCircle size={17} className="spin" />{t('AI 正在翻译，首次使用需要加载模型…')}</div> : ai.error ? <div className="error-banner" role="alert">{t(ai.error)}</div> : ai.result ? <><p className="ai-translation-text" data-testid="ai-translation-result">{ai.result.text}</p><div className="translation-meta"><span>{t('本地 AI 翻译')}{ai.result.cached ? t(' · 已缓存') : ''}</span><button className="copy-button" onClick={() => { if (ai.result) void api.copy(ai.result.text).then(() => setAICopied(true)).catch(e => setError(errorText(e))); }}>{aiCopied ? <Check size={14} /> : <Copy size={14} />}{t(aiCopied ? '已复制' : '复制 AI 译文')}</button></div></> : <p className="quality-note">{t('已取消，可点击重新翻译。')}</p>}
          </div>}
        </section>}
        </div>
      </section>
      <footer className="statusbar"><span><i className={status?.dictionaryCount && (!sentenceEnabled || status.modelReady) ? 'ready' : ''} />{status?.dictionaryCount && (!sentenceEnabled || status.modelReady) ? t("离线资源已就绪") : status ? t("本地资源尚未就绪") : t("正在检查本地资源")}<span className="footer-divider">·</span>{status?.dictionaryCount ? t('{count} 词条', { count: status.dictionaryCount.toLocaleString(settings?.locale) }) : 'ECDICT'}<span className="footer-divider">·</span>{!sentenceEnabled ? t("仅查词") : 'Argos'}</span><span>{t("Esc 隐藏")}</span></footer>
    </main>
    {settingsOpen && settings && <SettingsDialog settings={settings} status={status} catalog={catalog} initialTab={settingsTab} onClose={() => { setSettingsOpen(false); input.current?.focus(); }} onSaved={savedSettings} onRefresh={refreshResources} />}
  </div>;
}
