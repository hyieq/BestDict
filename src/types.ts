export interface Entry {
  id: number; dictionaryId?: string; word: string; phonetic: string; translation: string; definition: string;
  exchange: string; tags: string; rank: number;
}
export interface LookupResult { entries: Entry[]; exact: boolean; corrected: boolean; dictionaryId?: string }
export type Direction = 'auto' | 'en-zh' | 'zh-en' | 'es-zh' | 'zh-es' | 'ja-zh' | 'zh-ja' | 'ko-zh' | 'zh-ko' | 'fr-zh' | 'zh-fr';
export type Mode = 'auto' | 'dictionary' | 'translate';
export interface Settings {
  locale: 'zh-CN' | 'en'; traySettingsAvailable: boolean;
  startup: boolean; shortcut: string; theme: 'system' | 'light' | 'dark';
  shortcutError: string; startupAvailable: boolean;
  dictionaryId: string; autoDictionary: boolean; translationEngine: 'none' | 'argos' | 'hy';
}
export interface Status { version: string; dictionaryCount: number; modelReady: boolean; error: string; shortcutError: string; dictionaryName: string; engine: string }
export interface Translation { text: string; direction: string; cached: boolean; engine: string; targetLanguage?: string }
export interface DictionaryInfo {
  id: string; name: string; languageName: string; languageCode: string; example: string;
  installed: boolean; builtIn: boolean; count: number; source: string; license: string; homepage: string;
}
export interface ResourceProgress { id: string; phase: string; message: string; received?: number; total?: number; count?: number }
export interface ResourceCatalog {
  dictionaries: DictionaryInfo[];
  argos: { ready: boolean; bytes: number; name: string; license: string };
  hy: { ready: boolean; bytes: number; name: string; license: string; filename: string };
  progress: ResourceProgress | null;
}
export interface DesktopAPI {
  lookup(text: string): Promise<LookupResult>;
  translate(text: string, direction: Direction, requestId: number): Promise<Translation>;
  cancelTranslation(): Promise<void>;
  status(): Promise<Status>;
  getSettings(): Promise<Settings>;
  setSettings(settings: Partial<Settings>): Promise<Settings>;
  getResources(): Promise<ResourceCatalog>;
  downloadResource(id: string): Promise<unknown>;
  importResource(id: string): Promise<unknown>;
  copyDownloadLinks(id: 'argos' | 'hy-mt1.5'): Promise<number>;
  cancelDownload(): Promise<void>;
  openSource(id: string): Promise<void>;
  openTraySettings(): Promise<void>;
  onOpenSettings(callback: () => void): () => void;
  onResourceProgress(callback: (progress: ResourceProgress) => void): () => void;
  hide(): void; minimize(): void; quit(): void; copy(text: string): Promise<boolean>;
  onFocus(callback: () => void): () => void;
}
declare global { interface Window { bestdict: DesktopAPI } }
