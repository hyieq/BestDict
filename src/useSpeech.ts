import { useCallback, useEffect, useRef, useState } from 'react';
import type { Translation, SpeechSettings } from './types';

export function useSpeech() {
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const current = useRef<{ id: string; revision: number; audio?: HTMLAudioElement; url?: string } | null>(null);
  const revision = useRef(0);
  const stop = useCallback(() => {
    revision.current++;
    const playback = current.current;
    current.current = null;
    if (playback?.audio) {
      playback.audio.onended = playback.audio.onerror = null;
      playback.audio.pause();
      playback.audio.removeAttribute('src');
      playback.audio.load();
    }
    if (playback?.url) URL.revokeObjectURL(playback.url);
    setActive(null); setLoading(false);
    void window.bestdict?.cancelSpeech().catch(() => {});
  }, []);

  const toggle = useCallback(async (id: string, result: Pick<Translation, 'text' | 'direction'>, preview?: SpeechSettings) => {
    const wasActive = current.current?.id === id;
    stop(); setError('');
    if (wasActive) return;
    const token = revision.current;
    const playback = { id, revision: token } as NonNullable<typeof current.current>;
    current.current = playback;
    setActive(id); setLoading(true);
    try {
      const language = result.direction.split('-').at(-1) || '';
      const response = preview
        ? await window.bestdict.previewSpeech(language, preview)
        : await window.bestdict.synthesizeSpeech(result.text, language);
      if (current.current !== playback || revision.current !== token) return;
      const bytes = Uint8Array.from(atob(response.audio), char => char.charCodeAt(0));
      playback.url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      playback.audio = new Audio(playback.url);
      playback.audio.onended = () => { if (current.current === playback) stop(); };
      playback.audio.onerror = () => { if (current.current === playback) { stop(); setError('音频播放失败，请重试。'); } };
      await playback.audio.play();
      if (current.current === playback) setLoading(false);
    } catch (e) {
      if (current.current !== playback) return;
      stop();
      setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, ''));
    }
  }, [stop]);

  useEffect(() => {
    const remove = window.bestdict?.onStopSpeech(stop);
    const hide = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', hide);
    return () => { remove?.(); document.removeEventListener('visibilitychange', hide); stop(); };
  }, [stop]);
  return { active, loading, error, stop, toggle };
}
