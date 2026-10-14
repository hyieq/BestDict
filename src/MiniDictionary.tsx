import { useEffect, useRef, type RefObject, type ReactNode } from 'react';
import { ArrowUpRight, BookOpen, Check, Copy, Pin, Search, X, LoaderCircle } from 'lucide-react';
import type { Entry } from './types';
import './mini.css';

type Props = {
  query: string; entry?: Entry; corrected: boolean; busy: boolean; pinned: boolean;
  copied: boolean; error: string; input: RefObject<HTMLTextAreaElement | null>;
  t: (message: string) => string; speech: ReactNode;
  onQuery(value: string): void; onSearch(): void; onCopy(): void;
  onComposition(value: boolean): void; onExpand(): void; onPin(): void;
};

export default function MiniDictionary(p: Props) {
  const content = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLElement>(null);
  useEffect(() => {
    const resize = () => {
      const height = (top.current?.offsetHeight || 0) + (content.current?.offsetHeight || 0) + (footer.current?.offsetHeight || 0) + 30;
      void window.bestdict.resizeMini(height).catch(() => {});
    };
    const observer = new ResizeObserver(resize);
    for (const element of [top.current, content.current, footer.current]) if (element) observer.observe(element);
    resize();
    return () => observer.disconnect();
  }, []);
  useEffect(() => { p.input.current?.focus(); p.input.current?.select(); }, []);
  return <main className="app-shell mini-shell" data-testid="mini-window">
    <div ref={top} className="mini-top">
      <header className="mini-title">
        <span><BookOpen size={15} />Best<span className="mini-brand">Dict</span></span>
        <div>
          <button className="chrome-button" aria-label={p.t('固定置顶')} title={p.t('固定置顶')} aria-pressed={p.pinned} onClick={p.onPin}><Pin size={15} fill={p.pinned ? 'currentColor' : 'none'} /></button>
          <button className="chrome-button" aria-label={p.t('展开主窗口')} title={p.t('展开主窗口')} onClick={p.onExpand}><ArrowUpRight size={18} /></button>
          <button className="chrome-button close" aria-label={p.t('隐藏窗口')} onClick={() => window.bestdict.hide()}><X size={17} /></button>
        </div>
      </header>
      <div className="mini-search">
        <textarea ref={p.input} rows={1} maxLength={5000} aria-label={p.t('输入单词或词组')} placeholder={p.t('输入单词或词组')} value={p.query}
          onChange={e => p.onQuery(e.target.value)} onCompositionStart={() => p.onComposition(true)} onCompositionEnd={() => p.onComposition(false)} />
        <button className="mini-search-button" aria-label={p.t('搜索')} title={p.t('搜索')} disabled={!p.query.trim()} onClick={p.onSearch}><Search size={20} /></button>
      </div>
    </div>
    <section className="mini-result" aria-live="polite" aria-busy={p.busy}>
      <div ref={content}>
        {p.query.trim() && (p.busy ? <div className="mini-message"><LoaderCircle size={17} className="spin" />{p.t('正在查询…')}</div> : p.entry ? <article className="mini-entry">
          {p.corrected && <div className="mini-caption">{p.t('相近拼写')}</div>}
          <div className="mini-word"><h1 data-testid="mini-word">{p.entry.word}</h1>{p.speech}</div>
          {p.entry.phonetic && <p className="phonetic">/{p.entry.phonetic.replace(/^\/+|\/+$/g, '')}/</p>}
          <div className="mini-definitions">{p.entry.translation.split('\n').filter(Boolean).slice(0, 3).map((line, index) => <p key={index}>{line}</p>)}</div>
        </article> : <div className="mini-message">{p.t('暂未找到这个词条')}<button onClick={p.onExpand}>{p.t('进入主窗口翻译')}<ArrowUpRight size={14} /></button></div>)}
        {p.error && <div className="error-banner" role="alert">{p.t(p.error)}</div>}
      </div>
    </section>
    <footer ref={footer} className="mini-footer">
      <span>{p.t(p.pinned ? '已固定' : p.query.trim() ? '离线词典' : 'Enter 搜索 · Esc 收起')}</span>
      {p.entry && p.query.trim() && <div><button aria-label={p.t('复制释义')} title={p.t('复制释义')} onClick={p.onCopy}>{p.copied ? <Check size={14} /> : <Copy size={14} />}</button><button onClick={p.onExpand}>{p.t('完整释义')}<ArrowUpRight size={13} /></button></div>}
    </footer>
  </main>;
}
