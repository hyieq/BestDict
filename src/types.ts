export interface Entry {
  id: number; dictionaryId?: string; word: string; phonetic: string; translation: string; definition: string;
  exchange: string; tags: string; rank: number;
}
export interface LookupResult { entries: Entry[]; exact: boolean; corrected: boolean; dictionaryId?: string }
export type Direction = 'auto' | 'en-zh' | 'zh-en' | 'es-zh' | 'zh-es' | 'ja-zh' | 'zh-ja' | 'ko-zh' | 'zh-ko' | 'fr-zh' | 'zh-fr';
export type Mode = 'auto' | 'dictionary' | 'translate';
export interface AIStyle { id: string; name: string; prompt: string }
export interface AIOptions { forceRefresh?: boolean; styleName?: string; stylePrompt?: string; polishPrompt?: string; previousText?: string }
export interface Settings {
  captureShortcut: string; captureShortcutError: string;
  miniShortcut: string; miniShortcutError: string; miniHideOnBlur: boolean; miniRememberPosition: boolean;
  speech: SpeechSettings;
  aiStyles: AIStyle[]; aiStyleId: string;
  locale: 'zh-CN' | 'en'; traySettingsAvailable: boolean; captureAvailable: boolean;
  startup: boolean; shortcut: string; theme: 'system' | 'light' | 'dark';
  shortcutError: string; startupAvailable: boolean;
  dictionaryId: string; autoDictionary: boolean; translationEngine: 'none' | 'argos'; translationNoticeDismissed: boolean;
}
export interface Status { version: string; dictionaryCount: number; modelReady: boolean; error: string; shortcutError: string; dictionaryName: string; engine: string }
export interface Translation { text: string; direction: string; cached: boolean; engine: string; targetLanguage?: string; styleName?: string; polished?: boolean }
export interface DictionaryInfo {
  id: string; name: string; languageName: string; languageCode: string; example: string;
  installed: boolean; builtIn: boolean; count: number; source: string; license: string; homepage: string;
}
export interface ResourceProgress { id: string; phase: string; message: string; received?: number; total?: number; count?: number }
export interface ResourceCatalog {
  kokoro: { ready: boolean; bytes: number; name: string; license: string };
  dictionaries: DictionaryInfo[];
  argos: { ready: boolean; bytes: number; name: string; license: string };
  hy: { ready: boolean; bytes: number; name: string; license: string; filename: string };
  progress: ResourceProgress | null;
}
export interface DesktopAPI {
  startCapture(): Promise<void>;
  getOCR(): Promise<OCRStatus>;
  installOCR(): Promise<OCRStatus>;
  cancelOCRDownload(): Promise<void>;
  uninstallOCR(): Promise<OCRStatus>;
  onCaptureOpen(callback: (data: { text: string; settings: boolean; tab?: string }) => void): () => void;
  onCaptureError(callback: (message: string) => void): () => void;
  getWindowMode(): Promise<{ mini: boolean; pinned: boolean }>;
  setMiniMode(mini: boolean): Promise<{ mini: boolean; pinned: boolean }>;
  pinMini(pinned: boolean): Promise<{ mini: boolean; pinned: boolean }>;
  resizeMini(height: number): Promise<void>;
  onWindowMode(callback: (state: { mini: boolean; pinned: boolean }) => void): () => void;
  getSpeechCatalog(): Promise<SpeechCatalog>;
  getSpeechCache(): Promise<SpeechCacheStatus>;
  clearSpeechCache(): Promise<SpeechCacheStatus>;
  synthesizeSpeech(text: string, language: string): Promise<{ audio: string; engine: string; cached: boolean }>;
  previewSpeech(language: string, settings: SpeechSettings): Promise<{ audio: string; engine: string; cached: boolean }>;
  cancelSpeech(): Promise<void>;
  onStopSpeech(callback: () => void): () => void;
  getAppearance(): Promise<{ material: 'acrylic' | 'fallback' | 'solid'; dark: boolean; reducedTransparency: boolean }>;
  onAppearance(callback: (appearance: { material: 'acrylic' | 'fallback' | 'solid'; dark: boolean; reducedTransparency: boolean }) => void): () => void;
  lookup(text: string): Promise<LookupResult>;
  translate(text: string, direction: Direction, requestId: number): Promise<Translation>;
  translateAI(text: string, direction: Direction, requestId: number, options?: AIOptions): Promise<Translation>;
  cancelAITranslation(): Promise<void>;
  cancelTranslation(): Promise<void>;
  status(): Promise<Status>;
  getSettings(): Promise<Settings>;
  setSettings(settings: Partial<Settings>): Promise<Settings>;
  getResources(): Promise<ResourceCatalog>;
  downloadResource(id: string): Promise<unknown>;
  importResource(id: string): Promise<unknown>;
  copyDownloadLinks(id: 'argos' | 'hy-mt2' | 'kokoro'): Promise<number>;
  cancelDownload(): Promise<void>;
  openSource(id: string): Promise<void>;
  openTraySettings(): Promise<void>;
  onOpenSettings(callback: () => void): () => void;
  onResourceProgress(callback: (progress: ResourceProgress) => void): () => void;
  hide(): void; minimize(): void; quit(): void; copy(text: string): Promise<boolean>;
  onFocus(callback: () => void): () => void;
}
declare global { interface Window { bestdict: DesktopAPI } }
export interface SpeechSettings { engine: 'auto' | 'system' | 'kokoro'; rate: number; systemVoices: Record<string, string>; kokoroVoices: { en: number; zh: number } }
export interface SpeechVoice { id: string; name: string; language: string }
export interface SpeechCatalog { system: SpeechVoice[]; kokoro: SpeechVoice[]; systemError: string }
export interface SpeechCacheStatus { bytes: number; count: number; maxBytes: number; maxEntries: number }
export interface OCRStatus { ready: boolean; supported: boolean; bytes: number; progress: { received: number; total: number } | null }
