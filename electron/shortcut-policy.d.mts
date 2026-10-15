export function defaultShortcuts(platform: string): { shortcut: string; miniShortcut: string; captureShortcut: string };
export function migrateShortcuts<T extends Record<string, unknown>>(settings: T, platform: string): T;
export function normalizeShortcut(value: string, platform: string): string;
export function formatShortcut(value: string, platform: string): string;
export function shortcutFromEvent(event: { key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }, platform: string): { preview: string; value?: string; incomplete: boolean };
