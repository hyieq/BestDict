import { useEffect, useRef, useState } from 'react';
import type { AIStyle, Direction, Translation } from './types';

export function useAITranslation(query: string, style?: AIStyle) {
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [busy, setBusy] = useState(false);
  const [direction, setDirection] = useState<Direction>('auto');
  const [result, setResult] = useState<Translation | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const revision = useRef(0);
  useEffect(() => {
    revision.current++;
    setVisible(false); setResult(null); setError(''); setBusy(false);
    void window.bestdict?.cancelAITranslation().catch(() => {});
    return () => { revision.current++; void window.bestdict?.cancelAITranslation().catch(() => {}); };
  }, [query]);

  async function run(polishPrompt = '', forceRefresh = false, selectedStyle = style) {
    if (!query.trim()) return;
    const id = ++revision.current;
    setVisible(true); setExpanded(true); setBusy(true); setError(''); setNotice('');
    try {
      const translated = await window.bestdict.translateAI(query.trim(), direction, id, { forceRefresh, styleName: selectedStyle?.name, stylePrompt: selectedStyle?.prompt, polishPrompt, previousText: polishPrompt ? result?.text : undefined });
      if (id === revision.current) {
        setResult({ ...translated, styleName: selectedStyle?.name, polished: !!polishPrompt });
        if (result?.text === translated.text) setNotice('已重新生成，模型返回了相同译文。可尝试更具体的用词或句式要求。');
      }
    } catch (e) {
      if (id === revision.current) setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, ''));
    } finally { if (id === revision.current) setBusy(false); }
  }

  function cancel() {
    revision.current++; setBusy(false);
    void window.bestdict.cancelAITranslation().catch(() => {});
  }
  return { visible, expanded, setExpanded, busy, direction, setDirection, result, error, notice, run, cancel };
}
