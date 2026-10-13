import { useEffect, useRef, useState } from 'react';
import type { Direction, Translation } from './types';

export function useAITranslation(query: string) {
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [busy, setBusy] = useState(false);
  const [direction, setDirection] = useState<Direction>('auto');
  const [result, setResult] = useState<Translation | null>(null);
  const [error, setError] = useState('');
  const revision = useRef(0);
  useEffect(() => {
    revision.current++;
    setVisible(false); setResult(null); setError(''); setBusy(false);
    void window.bestdict?.cancelAITranslation().catch(() => {});
    return () => { revision.current++; void window.bestdict?.cancelAITranslation().catch(() => {}); };
  }, [query]);

  async function run() {
    if (!query.trim()) return;
    const id = ++revision.current;
    setVisible(true); setExpanded(true); setBusy(true); setError('');
    try {
      const translated = await window.bestdict.translateAI(query.trim(), direction, id);
      if (id === revision.current) setResult(translated);
    } catch (e) {
      if (id === revision.current) setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, ''));
    } finally { if (id === revision.current) setBusy(false); }
  }

  function cancel() {
    revision.current++; setBusy(false);
    void window.bestdict.cancelAITranslation().catch(() => {});
  }
  return { visible, expanded, setExpanded, busy, direction, setDirection, result, error, run, cancel };
}
