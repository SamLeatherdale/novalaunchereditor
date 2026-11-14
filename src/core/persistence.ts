import type { NovaFolderStyle, SamsungFolderGrid } from "./model/folderGrids";
import type { LauncherLayout, LayoutSourceFormat } from "./model/types";

export const AUTOSAVE_SLOT_ID = "autosave";

const DB_NAME = "nova-launcher-editor-db";
const DB_VERSION = 1;
const STORE_NAME = "workspace-saves";

export interface SavedExportPreferences {
  exportTab: "samsung" | "nova";
  keepWidgets: boolean;
  includeDrawerFolders: boolean;
  includeDrawerTabs: boolean;
  samsungFolderGrid: SamsungFolderGrid;
  samsungPreviewCols: 2 | 3 | 4 | 5;
  novaFolderStyle: NovaFolderStyle;
  novaFolderRows: number;
  novaFolderCols: number;
  novaPreviewCols: 2 | 3;
  novaFolderConfigModified?: boolean;
  novaFolderPreviewModified?: boolean;
}

export interface SavedWorkspaceRecord {
  id: string;
  isAutosave: boolean;
  /** Optional user-supplied save name; empty string when unnamed. */
  name: string;
  sourceFilename: string;
  sourceFormat: LayoutSourceFormat;
  /** Parsed millisecond timestamp from original filename (e.g. `1700000000000.exml` or `2026-01-15_09-30.novabackup`), or file `lastModified`. */
  originalBackupTimestamp?: number;
  updatedAt: number;
  createdAt: number;
  /** 360×780 PNG thumbnail bytes rendered for instant visual card previews in the Load Save modal. */
  previewPngBytes?: Uint8Array;
  layout: LauncherLayout;
  donorLayout?: LauncherLayout;
  donorFilename?: string;
  donorBackupTimestamp?: number;
  exportPrefs?: SavedExportPreferences;
}

/**
 * Extract original backup timestamp from Samsung (`1700000000000.exml`) or Nova
 * (`2026-01-15_09-30.novabackup` / `2026-01-15_09-30-12.novabackup`) filenames,
 * falling back to `fileLastModified` when available.
 */
export function inferBackupTimestamp(
  filename: string,
  fileLastModified?: number,
  archiveTimestamp?: number,
): number | undefined {
  const base = filename.split(/[\\/]/).pop() ?? filename;

  // Samsung Home Up 13-digit epoch ms (e.g. 1700000000000.exml)
  const epochMatch = base.match(/(?:^|\D)(\d{13})(?:\D|$)/);
  if (epochMatch) {
    const ms = Number(epochMatch[1]);
    if (Number.isFinite(ms) && ms > 946684800000) return ms;
  }

  // Nova Launcher timestamped filename (e.g. 2026-01-15_09-30.novabackup)
  const novaDateMatch = base.match(
    /(\d{4})-(\d{2})-(\d{2})[_T\s-](\d{2})[-:](\d{2})(?:[-:](\d{2}))?/,
  );
  if (novaDateMatch) {
    const [, y, mo, d, h, mi, s] = novaDateMatch;
    const dt = new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      s ? Number(s) : 0,
    );
    if (!Number.isNaN(dt.getTime())) {
      return dt.getTime();
    }
  }

  if (typeof archiveTimestamp === "number" && archiveTimestamp > 946684800000) {
    return archiveTimestamp;
  }

  if (typeof fileLastModified === "number" && fileLastModified > 0) {
    return fileLastModified;
  }
  return undefined;
}

export function formatBackupDate(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatRelativeTimeAgo(timestampMs: number, nowMs = Date.now()): string {
  const diffSec = Math.max(0, Math.round((nowMs - timestampMs) / 1000));
  if (diffSec < 10) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  return `${Math.floor(diffDay / 365)}y ago`;
}

function isIndexedDbSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

function openSavesDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isIndexedDbSupported()) {
      reject(new Error("IndexedDB is not available in this environment."));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
  });
}

export async function putSavedWorkspace(record: SavedWorkspaceRecord): Promise<void> {
  if (!isIndexedDbSupported()) return;
  const db = await openSavesDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    });
  } finally {
    db.close();
  }
}

export async function getSavedWorkspace(id: string): Promise<SavedWorkspaceRecord | undefined> {
  if (!isIndexedDbSupported()) return undefined;
  const db = await openSavesDb();
  try {
    return await new Promise<SavedWorkspaceRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result as SavedWorkspaceRecord | undefined);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB read failed"));
    });
  } finally {
    db.close();
  }
}

export async function listSavedWorkspaces(): Promise<SavedWorkspaceRecord[]> {
  if (!isIndexedDbSupported()) return [];
  const db = await openSavesDb();
  try {
    const records = await new Promise<SavedWorkspaceRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve((req.result as SavedWorkspaceRecord[]) ?? []);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB list failed"));
    });
    // Sort autosave first, then newest manual saves first
    return records.sort((a, b) => {
      if (a.isAutosave !== b.isAutosave) return a.isAutosave ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  } finally {
    db.close();
  }
}

export async function deleteSavedWorkspace(id: string): Promise<void> {
  if (!isIndexedDbSupported()) return;
  const db = await openSavesDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
    });
  } finally {
    db.close();
  }
}
