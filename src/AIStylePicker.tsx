import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { AIStyle, Settings } from './types';
import { createTranslator } from './i18n';

export default function AIStylePicker({ settings, onSaved }: { settings: Settings | null; onSaved: (value: Settings) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AIStyle[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const t = createTranslator(settings?.locale || 'zh-CN');
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!picker.current?.contains(event.target as Node)) setOpen(false);
    };
    const blur = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('blur', blur);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('blur', blur); };
  }, [open]);
  function closeMenu() { setOpen(false); trigger.current?.focus(); }
  async function save(changes: Partial<Settings>, close = false) {
    setSaving(true); setError('');
    try { onSaved(await window.bestdict.setSettings(changes)); if (close) dialog.current?.close(); }
    catch (e) { setError(String(e).replace(/^.*Error: /, '')); }
    finally { setSaving(false); }
  }
  function edit(index: number, changes: Partial<AIStyle>) { setDraft(items => items.map((item, i) => i === index ? { ...item, ...changes } : item)); }
  return <>
    <div ref={picker} className="ai-style-picker" onBlur={e => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
    }} onKeyDown={e => {
      if (open && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    }}>
      <button ref={trigger} className="ai-style-select" aria-label={t('翻译风格')} aria-haspopup="menu" aria-expanded={open} aria-controls="ai-style-menu"
        disabled={!settings || saving} onClick={() => setOpen(value => !value)} onKeyDown={e => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); }
        }}>
        <span>{t(settings?.aiStyles.find(s => s.id === settings.aiStyleId)?.name || '基本')}</span><ChevronDown size={13} />
      </button>
      {open && <div ref={menu} id="ai-style-menu" className="ai-style-menu" role="menu" aria-label={t('翻译风格')} onKeyDown={e => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation();
        const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
        {settings?.aiStyles.map(style => <button key={style.id} role="menuitemradio" aria-checked={style.id === settings.aiStyleId} tabIndex={-1}
          onClick={() => { closeMenu(); void save({ aiStyleId: style.id }); }}>
          <span>{t(style.name)}</span>{style.id === settings.aiStyleId && <Check size={14} />}
        </button>)}
        <button role="menuitem" tabIndex={-1} className="ai-style-manage" onClick={() => {
          closeMenu(); setDraft(settings?.aiStyles.map(s => ({ ...s })) || []); setError(''); dialog.current?.showModal();
        }}>{t('管理翻译风格…')}</button>
      </div>}
    </div>
    <dialog ref={dialog} className="style-dialog" aria-label={t('管理翻译风格')} onKeyDown={e => e.stopPropagation()}>
      <h2>{t('管理翻译风格')}</h2><p>{t('保存常用风格，翻译时一键选择。')}</p>
      <div className="style-list">{draft.map((style, i) => <div className="style-editor" key={style.id}>
        <label>{t('风格名称')}<input aria-label={`${t('风格名称')} ${i + 1}`} value={style.name} maxLength={30} onChange={e => edit(i, { name: e.target.value })} /></label>
        <label>{t('风格提示词')}<textarea aria-label={`${t('风格提示词')} ${i + 1}`} value={style.prompt} rows={3} maxLength={1000} onChange={e => edit(i, { prompt: e.target.value })} /></label>
        <button className="source-link" disabled={draft.length === 1 || saving} onClick={() => setDraft(items => items.filter(s => s.id !== style.id))}>{t('删除')}</button>
      </div>)}</div>
      {error && <p role="alert" className="error-banner">{t(error)}</p>}
      <div className="style-dialog-actions">
        <button className="secondary-button" disabled={draft.length >= 30 || saving} onClick={() => setDraft(items => [...items, { id: crypto.randomUUID(), name: '', prompt: '' }])}>{t('新增风格')}</button>
        <button className="secondary-button" disabled={saving} onClick={() => setDraft([
          { id: 'basic', name: '基本', prompt: '忠实传达原意，表达自然、清晰，保留原文语气。' },
          { id: 'professional', name: '专业', prompt: '使用正式、严谨的书面表达，结合语境采用准确术语，保持术语一致。' },
          { id: 'casual', name: '口语化', prompt: '使用自然的日常交流表达，句式简洁流畅，避免生硬书面语，保留原文语气。' },
          { id: 'concise', name: '简短', prompt: '用简短直接的句子表达，删去冗余措辞，保留原文的关键信息、事实、数字、条件和否定含义，不添加解释。' },
        ])}>{t('恢复默认')}</button>
        <button className="secondary-button" disabled={saving} onClick={() => dialog.current?.close()}>{t('取消')}</button>
        <button className="secondary-button" disabled={saving || draft.some(s => !s.name.trim() || !s.prompt.trim())} onClick={() => void save({ aiStyles: draft }, true)}>{t('保存风格')}</button>
      </div>
    </dialog>
    {error && !dialog.current?.open && <span role="alert" className="style-save-error">{t(error)}</span>}
  </>;
}
