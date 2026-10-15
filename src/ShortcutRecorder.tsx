import { useEffect, useRef, useState } from 'react';
import { formatShortcut, normalizeShortcut, shortcutFromEvent } from '../electron/shortcut-policy.mjs';
const api = window.bestdict;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');
export default function ShortcutRecorder({ id, value, platform, others, onChange, onIssue, t }: {
  id: string; value: string; platform: string; others: string[]; onChange(value: string): void;
  onIssue(issue: string): void; t(text: string): string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState(false), [ready, setReady] = useState(false);
  const [preview, setPreview] = useState(''), [issue, setIssue] = useState(''), [pending, setPending] = useState(false);
  const captured = useRef(false), down = useRef(new Set<string>());
  const original = useRef(value), generation = useRef(0), alive = useRef(true), focused = useRef(false);
  const report = useRef(onIssue); report.current = onIssue;
  function feedback(message: string) { setIssue(message); report.current(message); }
  useEffect(() => {
    alive.current = true;
    const blur = () => input.current?.blur();
    window.addEventListener('blur', blur);
    return () => { alive.current = false; generation.current++; report.current(''); window.removeEventListener('blur', blur); if (focused.current) void api.setShortcutRecording(false).catch(() => {}); };
  }, []);
  async function begin() {
    generation.current++; captured.current = false; down.current.clear(); original.current = value; focused.current = true; setRecording(true); setReady(false); setPreview(''); feedback('');
    try { await api.setShortcutRecording(true); if (alive.current && focused.current) setReady(true); }
    catch (error) { if (alive.current) feedback(errorText(error)); }
  }
  function end() {
    focused.current = false; setRecording(false); setReady(false);
    void api.setShortcutRecording(false).then(state => { if (alive.current && Object.keys(state.errors).length) feedback(Object.values(state.errors).join(' ')); }).catch(error => { if (alive.current) feedback(errorText(error)); });
  }
  return <div className="shortcut-recorder">
    <input ref={input} id={id} className="shortcut-input" readOnly data-shortcut-recorder="true" data-recording={recording && ready}
      value={recording ? preview : formatShortcut(value, platform)} placeholder={t(ready ? '按下组合键…' : '正在准备录制…')}
      aria-invalid={!!issue} aria-describedby={id + '-feedback'} onFocus={() => void begin()} onBlur={end}
      onKeyDown={event => {
        if (event.key === 'Tab') return;
        event.preventDefault(); event.stopPropagation();
        if (event.repeat || event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') { generation.current++; setPending(false); onChange(original.current); feedback(''); event.currentTarget.blur(); return; }
        if (!ready) return;
        const revision = ++generation.current; setPending(false);
        try {
          const modifier = ['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(event.key);
          if (!modifier) { if (down.current.size && !down.current.has(event.code)) throw new Error('一次只能设置一个字母、数字或功能键。'); down.current.add(event.code); }
          const result = shortcutFromEvent(event, platform);
          captured.current = !result.incomplete;
          setPreview(formatShortcut(result.preview, platform) + (result.incomplete ? ' …' : ''));
          if (result.incomplete) { feedback(''); return; }
          if (others.some(other => normalizeShortcut(other, platform) === result.value)) { feedback('已用于其他功能，请换一个组合。'); return; }
          const candidate = result.value!;
          setPending(true); feedback('正在检查快捷键…');
          void api.checkShortcut(candidate).then(() => {
            if (alive.current && generation.current === revision) { onChange(candidate); setPending(false); feedback(''); }
          }).catch(error => {
            if (alive.current && generation.current === revision) { setPending(false); feedback(errorText(error)); }
          });
        } catch (error) { setPreview(formatShortcut([event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && (platform === 'darwin' ? 'Command' : 'Super'), event.key].filter(Boolean).join('+'), platform)); feedback(errorText(error)); }
      }} onKeyUp={event => {
        down.current.delete(event.code);
        if (!captured.current && recording) {
          const held = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && (platform === 'darwin' ? 'Command' : 'Super')].filter(Boolean).join('+');
          setPreview(held ? formatShortcut(held, platform) + ' …' : '');
        }
      }} />
    <span id={id + '-feedback'} className={'shortcut-feedback ' + (issue && !pending ? 'invalid' : '')} role={issue && !pending ? 'alert' : 'status'}>
      {t(issue || (recording ? ready ? '正在录制，Esc 撤销，Tab 结束。' : '正在准备录制…' : ''))}
    </span>
  </div>;
}
