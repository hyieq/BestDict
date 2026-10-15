import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Copy, LoaderCircle, Pin, ScanLine, Settings2, Volume2, X } from 'lucide-react';
import { createTranslator } from './i18n';
import type { Translation, SpeechAudio, SpeechChunk } from './types';
import { useSpeech } from './useSpeech';
import './capture.css';

type Rect = { x: number; y: number; width: number; height: number };
type State = { mode?: 'select' | 'result'; locale?: 'zh-CN' | 'en'; dark?: boolean; image?: string; text?: string; phase?: string; error?: string; lowConfidence?: boolean; engines?: { hy: boolean; argos: boolean } };
declare global { interface Window { capture: {
  init(): Promise<State>; select(rect: Rect): Promise<void>; cancel(): Promise<void>; close(): Promise<void>; retry(): Promise<void>;
  translate(text: string, direction: string, engine: string): Promise<Translation>; cancelWork(): Promise<void>;
  copy(text: string): Promise<void>; pin(value: boolean): Promise<void>; open(text: string, settings?: boolean): Promise<void>;
  speech(text: string, language: string, requestId?: string): Promise<SpeechAudio>; stopSpeech(requestId?: string): Promise<void>;
  onSpeechChunk(callback: (chunk: SpeechChunk) => void): () => void;
  onStopSpeech(callback: () => void): () => void;
  onState(callback: (state: State) => void): () => void;
} } }
const api = window.capture;
const speechTransport = { synthesizeSpeech: api?.speech, cancelSpeech: api?.stopSpeech, onSpeechChunk: api?.onSpeechChunk, onStopSpeech: api?.onStopSpeech };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, '');

export default function Capture() {
  const [state, setState] = useState<State>({});
  const [error, setError] = useState('');
  const t = createTranslator(state.locale || 'zh-CN');
  useEffect(() => {
    let active = true;
    const update = (s: State) => { if (active) setState(old => ({ ...old, ...s })); };
    const off = api.onState(update);
    void api.init().then(update).catch(e => setError(message(e)));
    return () => { active = false; off(); };
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = state.dark ? 'dark' : 'light'; }, [state.dark]);
  if (!state.mode) return <div className="capture-loading">{error || t('正在准备…')}</div>;
  return state.mode === 'select' ? <Selection image={state.image!} t={t} /> : <Result state={state} t={t} />;
}

function Selection({ image, t }: { image: string; t: (s: string) => string }) {
  const [rect, setRect] = useState<Rect | null>(null);
  const [error, setError] = useState('');
  const start = useRef<{ x: number; y: number } | null>(null);
  const submitting = useRef(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') void api.cancel(); };
    addEventListener('keydown', key); return () => removeEventListener('keydown', key);
  }, []);
  function area(x: number, y: number) {
    x = Math.max(0, Math.min(innerWidth, x)); y = Math.max(0, Math.min(innerHeight, y));
    return { x: Math.min(start.current!.x, x), y: Math.min(start.current!.y, y), width: Math.abs(x - start.current!.x), height: Math.abs(y - start.current!.y) };
  }
  return <div className="capture-selection" data-testid="capture-selection" onContextMenu={e => { e.preventDefault(); void api.cancel(); }}
    onPointerDown={e => { if (e.button !== 0 || submitting.current) return; e.currentTarget.setPointerCapture(e.pointerId); start.current = { x: e.clientX, y: e.clientY }; setRect(null); setError(''); }}
    onPointerMove={e => { if (start.current) setRect(area(e.clientX, e.clientY)); }}
    onPointerUp={e => {
      if (!start.current || submitting.current) return;
      const selected = area(e.clientX, e.clientY); start.current = null;
      if (selected.width < 8 || selected.height < 8) { setRect(null); setError(t('选区太小，请重新框选。')); return; }
      submitting.current = true;
      void api.select({ x: selected.x / innerWidth, y: selected.y / innerHeight, width: selected.width / innerWidth, height: selected.height / innerHeight })
        .catch(e => { submitting.current = false; setError(message(e)); });
    }}>
    <img src={image} draggable={false} className="capture-desktop" />
    {rect ? <div className="capture-rectangle" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}><span>{Math.round(rect.width)} × {Math.round(rect.height)}</span></div> : <div className="capture-shade" />}
    <div className="capture-instruction"><ScanLine size={18} />{error || t('拖动框选文字 · 松开识别 · Esc / 右键取消')}</div>
  </div>;
}

function Result({ state, t }: { state: State; t: (s: string) => string }) {
  const [text, setText] = useState(state.text || '');
  const [translation, setTranslation] = useState<Translation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [direction, setDirection] = useState('auto');
  const [pinned, setPinned] = useState(true);
  const speech = useSpeech(speechTransport);
  const speaking = speech.active !== null;
  const revision = useRef(0);
  const autoStarted = useRef(false);
  const provider = useRef(`${!!state.engines?.hy}:${!!state.engines?.argos}`);
  const recognizing = state.phase === 'recognizing';
  const hasEngine = state.engines?.hy || state.engines?.argos;
  const stopSpeech = speech.stop;
  function cancel() { revision.current++; setBusy(false); stopSpeech(); void api.cancelWork().catch(() => {}); }
  async function run(source = text) {
    const current = ++revision.current;
    stopSpeech(); setBusy(true); setError(''); setTranslation(null);
    try { const result = await api.translate(source, direction, 'auto'); if (revision.current === current) setTranslation(result); }
    catch (e) { if (revision.current === current) setError(message(e)); }
    finally { if (revision.current === current) setBusy(false); }
  }
  useEffect(() => {
    const next = `${!!state.engines?.hy}:${!!state.engines?.argos}`;
    if (provider.current === next) return;
    provider.current = next;
    cancel(); setTranslation(null);
    if (hasEngine && text.trim()) { autoStarted.current = true; void run(text); }
  }, [state.engines?.hy, state.engines?.argos]);
  useEffect(() => { if (state.text !== undefined) setText(state.text); }, [state.text]);
  useEffect(() => {
    if (state.text && !autoStarted.current && hasEngine) { autoStarted.current = true; void run(state.text); }
  }, [state.text, hasEngine]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') void api.close(); };
    const visibility = () => { if (document.hidden) stopSpeech(); };
    addEventListener('keydown', key);
    document.addEventListener('visibilitychange', visibility);
    return () => { removeEventListener('keydown', key); document.removeEventListener('visibilitychange', visibility); revision.current++; stopSpeech(); };
  }, []);
  async function copy(value: string) { try { await api.copy(value); setNotice(t('已复制')); } catch (e) { setError(message(e)); } }
  async function speak() {
    if (!translation) return;
    setError('');
    await speech.toggle('capture', translation);
  }
  return <div className="capture-result" data-testid="capture-result">
    <header className="capture-title"><span><ScanLine size={18} />{t('截图翻译')}</span><div>
      <button className="icon-button" aria-label={t('置顶')} aria-pressed={pinned} onClick={() => void api.pin(!pinned).then(() => setPinned(!pinned)).catch(e => setError(message(e)))}><Pin size={16} /></button>
      <button className="icon-button" aria-label={t('关闭')} onClick={() => void api.close()}><X size={18} /></button>
    </div></header>
    <div className="capture-content">
      <div className="capture-toolbar"><select aria-label={t('翻译方向')} value={direction} onChange={e => { cancel(); setTranslation(null); setDirection(e.target.value); }}><option value="auto">{t('自动识别')}</option><option value="en-zh">English → 中文</option><option value="zh-en">中文 → English</option></select>
        <span>{state.engines?.hy ? t('混元 AI') : state.engines?.argos ? t('基础翻译') : t('未开启')}</span></div>
      <details className="capture-preview"><summary>{t('查看截图')}</summary><img src={state.image} alt={t('截图选区')} /></details>
      <section className="capture-source"><div className="capture-label"><label htmlFor="ocr-text">{t('原文 · 可编辑')}</label><button className="icon-button" disabled={!text} aria-label={t('复制原文')} onClick={() => void copy(text)}><Copy size={14} /></button></div>
        <textarea id="ocr-text" aria-label={t('识别原文')} maxLength={5000} value={text} disabled={recognizing} placeholder={recognizing ? t('正在识别文字…') : t('识别原文')} onChange={e => { cancel(); setTranslation(null); setNotice(''); setText(e.target.value); }} />
        {state.lowConfidence && <p className="capture-hint">{t('部分文字置信度较低，建议核对原文。')}</p>}
      </section>
      <section className="capture-output" aria-live="polite"><div className="capture-label"><strong>{t('译文')}</strong>{translation && <div><button className="icon-button" aria-label={t('播放译文')} aria-pressed={speaking} onClick={() => void speak()}><Volume2 size={15} /></button><button className="icon-button" aria-label={t('复制译文')} onClick={() => void copy(translation.text)}><Copy size={15} /></button></div>}</div>
        {recognizing || busy ? <p className="capture-wait"><LoaderCircle size={17} className="spin" />{t(recognizing ? '正在识别文字…' : '正在翻译…')}</p> : translation ? <><p className="capture-translated">{translation.text}</p><small>{translation.engine}</small></> : <p className="capture-hint">{t(hasEngine ? '识别完成后自动翻译，也可修改原文后重新翻译。' : '请先在设置中下载并启用翻译模型。')}</p>}
      </section>
      {(error || speech.error || state.error) && <div className="error-banner" role="alert">{t(error || speech.error || state.error || '')}</div>}
      {!hasEngine && <button className="secondary-button" onClick={() => void api.open(text, true)}><Settings2 size={14} />{t('打开设置')}</button>}
      {notice && <p className="capture-notice" role="status"><Check size={13} />{notice}</p>}
    </div>
    <footer className="capture-footer"><button className="secondary-button" onClick={() => { cancel(); void api.retry().catch(e => setError(message(e))); }}><ScanLine size={14} />{t('重新截图')}</button><button className="secondary-button" disabled={!text} onClick={() => void api.open(text)}><ArrowUpRight size={14} />{t('完整界面')}</button>
      {busy || recognizing ? <button className="capture-primary" onClick={() => { cancel(); if (recognizing) void api.close(); }}>{t('取消')}</button> : <button className="capture-primary" disabled={!text.trim() || !hasEngine} onClick={() => void run()}>{t('翻译')}</button>}
    </footer>
  </div>;
}
