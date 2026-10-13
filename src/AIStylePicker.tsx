import { useRef, useState } from 'react';
import type { AIStyle, Settings } from './types';
import { createTranslator } from './i18n';

export default function AIStylePicker({ settings, onSaved }: { settings: Settings | null; onSaved: (value: Settings) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<AIStyle[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const t = createTranslator(settings?.locale || 'zh-CN');
  async function save(changes: Partial<Settings>, close = false) {
    setSaving(true); setError('');
    try { onSaved(await window.bestdict.setSettings(changes)); if (close) dialog.current?.close(); }
    catch (e) { setError(String(e).replace(/^.*Error: /, '')); }
    finally { setSaving(false); }
  }
  function edit(index: number, changes: Partial<AIStyle>) { setDraft(items => items.map((item, i) => i === index ? { ...item, ...changes } : item)); }
  return <>
    <select className="ai-style-select" aria-label={t('翻译风格')} value={settings?.aiStyleId || 'basic'} disabled={!settings || saving} onChange={e => {
      if (e.target.value === '__manage') { setDraft(settings?.aiStyles.map(s => ({ ...s })) || []); setError(''); dialog.current?.showModal(); }
      else void save({ aiStyleId: e.target.value });
    }}>
      {(settings?.aiStyles || [{ id: 'basic', name: '基本' }]).map(s => <option key={s.id} value={s.id}>{t(s.name)}</option>)}
      <option value="__manage">{t('管理翻译风格…')}</option>
    </select>
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
