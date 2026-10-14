import { useCallback, useEffect, useRef, useState } from 'react';
import type { Translation, SpeechSettings, DesktopAPI } from './types';
import { SpeechStreamPlayer } from './speech-playback';

type SpeechTransport = Pick<DesktopAPI, 'synthesizeSpeech' | 'cancelSpeech' | 'onSpeechChunk'> & Partial<Pick<DesktopAPI, 'previewSpeech' | 'onStopSpeech'>>;

export function useSpeech(transport: SpeechTransport = window.bestdict) {
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const current = useRef<{ id: string; revision: number; requestId?: string; audio?: HTMLAudioElement; url?: string; stream?: SpeechStreamPlayer; offChunk?: () => void } | null>(null);
  const revision = useRef(0);
  const stop = useCallback(() => {
    revision.current++;
    const playback = current.current;
    current.current = null;
    playback?.offChunk?.();
    playback?.stream?.stop();
    if (playback?.audio) {
      playback.audio.onended = playback.audio.onerror = null;
      playback.audio.pause();
      playback.audio.removeAttribute('src');
      playback.audio.load();
    }
    if (playback?.url) URL.revokeObjectURL(playback.url);
    setActive(null); setLoading(false);
    if (playback?.requestId) void transport?.cancelSpeech(playback.requestId).catch(() => {});
  }, [transport]);

  const toggle = useCallback(async (id: string, result: Pick<Translation, 'text' | 'direction'>, preview?: SpeechSettings) => {
    const wasActive = current.current?.id === id;
    stop(); setError('');
    if (wasActive) return;
    const token = revision.current;
    const playback = { id, revision: token } as NonNullable<typeof current.current>;
    current.current = playback;
    setActive(id); setLoading(true);
    try {
      const requestId = crypto.randomUUID();
      playback.requestId = requestId;
      playback.offChunk = transport.onSpeechChunk(chunk => {
        if (current.current !== playback || chunk.requestId !== requestId) return;
        try {
          playback.stream ??= new SpeechStreamPlayer({
            started: () => { if (current.current === playback) setLoading(false); },
            waiting: () => { if (current.current === playback) setLoading(true); },
            ended: () => { if (current.current === playback) stop(); },
            error: () => { if (current.current === playback) { stop(); setError('音频播放失败，请重试。'); } },
          });
          playback.stream.push(chunk);
        } catch { stop(); setError('音频播放失败，请重试。'); }
      });
      const language = result.direction.split('-').at(-1) || '';
      const response = preview
        ? await transport.previewSpeech!(language, preview, requestId)
        : await transport.synthesizeSpeech(result.text, language, requestId);
      if (current.current !== playback || revision.current !== token) return;
      if (response.streamed) {
        if (!playback.stream) throw new Error('音频播放失败，请重试。');
        playback.stream.finish();
        return;
      }
      if (!response.audio || playback.stream) throw new Error('音频播放失败，请重试。');
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
  }, [stop, transport]);

  useEffect(() => {
    const remove = transport?.onStopSpeech?.(stop);
    const hide = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', hide);
    return () => { remove?.(); document.removeEventListener('visibilitychange', hide); stop(); };
  }, [stop, transport]);
  return { active, loading, error, stop, toggle };
}
