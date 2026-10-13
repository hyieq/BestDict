import { LoaderCircle, Square, Volume2 } from 'lucide-react';
export default function SpeechButton({ active, loading, onClick, t }: {
  active: boolean; loading: boolean; onClick(): void; t(message: string): string;
}) {
  const label = t(active ? '停止发音' : '播放发音');
  return <button className={`icon-button speech-button ${active ? 'speaking' : ''}`} aria-label={label} title={active && loading ? t('正在准备发音，点击停止') : label} aria-pressed={active} onClick={onClick}>
    {active ? loading ? <LoaderCircle size={16} className="spin" /> : <Square size={14} fill="currentColor" /> : <Volume2 size={17} />}
  </button>;
}
