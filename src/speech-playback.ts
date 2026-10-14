import type { SpeechChunk } from './types';

// Schedule PCM on one audio clock, avoiding gaps from repeated HTMLAudio loading.
export class SpeechStreamPlayer {
  private context = new AudioContext();
  private output = this.context.createGain();
  private sources = new Set<AudioBufferSourceNode>();
  private pending: AudioBuffer[] = [];
  private ready = false;
  private stopped = false;
  private finished = false;
  private begun = false;
  private buffering = false;
  private sequence = 0;
  private nextTime = 0;
  private slow = false;

  constructor(private callbacks: { started(): void; waiting(): void; ended(): void; error(error: unknown): void }) {
    this.output.connect(this.context.destination);
    void this.context.resume().then(() => { this.ready = true; this.pump(); }).catch(error => { if (!this.stopped) callbacks.error(error); });
  }

  push(chunk: SpeechChunk) {
    if (this.stopped) return;
    if (this.finished || chunk.sequence !== this.sequence++ || !Number.isInteger(chunk.sampleRate) || chunk.sampleRate < 8000 || chunk.sampleRate > 96000 || !Number.isFinite(chunk.generationMs) || chunk.generationMs < 0) throw new Error('音频播放失败，请重试。');
    const raw = atob(chunk.pcm);
    if (!raw.length || raw.length % 2 || raw.length > 16 * 1024 * 1024) throw new Error('音频播放失败，请重试。');
    const buffer = this.context.createBuffer(1, raw.length / 2, chunk.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index++) {
      const value = raw.charCodeAt(index * 2) | raw.charCodeAt(index * 2 + 1) << 8;
      samples[index] = (value >= 32768 ? value - 65536 : value) / 32768;
    }
    if (!this.begun && this.sequence === 1) this.slow = buffer.duration < 1 || chunk.generationMs / 1000 > buffer.duration * .85;
    this.pending.push(buffer);
    this.pump();
  }

  finish() { this.finished = true; this.pump(); }

  private pump() {
    if (this.stopped || !this.ready) return;
    const duration = this.pending.reduce((sum, buffer) => sum + buffer.duration, 0);
    // Start fast on ordinary hardware; reserve more audio if inference is near
    // real time, or after an underrun, instead of repeatedly playing tiny fragments.
    if (!this.finished && ((!this.begun && this.slow) || this.buffering) && duration < 2.5 && (this.pending.length < 2 || duration < 1.5)) return;
    for (const buffer of this.pending.splice(0)) {
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.output);
      const start = Math.max(this.nextTime, this.context.currentTime + .04);
      this.nextTime = start + buffer.duration;
      this.sources.add(source);
      source.onended = () => {
        source.disconnect(); this.sources.delete(source);
        if (this.stopped) return;
        if (!this.sources.size && !this.pending.length) {
          if (this.finished) this.callbacks.ended();
          else { this.buffering = true; this.callbacks.waiting(); }
        }
      };
      source.start(start);
      this.buffering = false;
      this.begun = true;
      this.callbacks.started();
    }
    if (this.finished && !this.pending.length && !this.sources.size) this.callbacks.ended();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect(); }
    this.sources.clear(); this.pending = [];
    this.output.disconnect();
    void this.context.close().catch(() => {});
  }
}
