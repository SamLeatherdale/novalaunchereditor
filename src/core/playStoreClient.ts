import { isNonPlayStorePackage } from "../server/playStoreMetadata";
import {
  hasCuratedAppLabel,
  inferHeuristicAppLabel,
  isGenericTechnicalLabel,
} from "./model/appLabels";
import type { LauncherLayout, LayoutItem } from "./model/types";

/** 30-day `localStorage` TTL for packages found on Google Play (`found: true`). */
export const PLAY_CACHE_FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 7-day `localStorage` TTL for packages not found on Google Play (`found: false`). */
export const PLAY_CACHE_NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Persistent `localStorage` key storing lightweight `{ found, title?, iconUrl?, fetchedAt }` Play mappings. */
export const PLAY_METADATA_CACHE_STORAGE_KEY = "nova-editor:play-app-cache";

/** Persistent `localStorage` key storing the user's opt-in auto-fetch toggle (`"true"` / `"false"`). */
export const PLAY_AUTO_FETCH_STORAGE_KEY = "nova-editor:auto-fetch-play-icons";

export interface PlayAppResolvedEntry {
  packageName: string;
  found: boolean;
  title?: string;
  iconUrl?: string;
  fetchedAt?: number;
}

export interface PlayCachedMetadataValue {
  found: boolean;
  title?: string;
  iconUrl?: string;
  fetchedAt: number;
}

export interface FetchPlayStoreMetadataOptions {
  apiBase?: string;
  concurrency?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** Minimum ms between batched `onProgress` callbacks (`120` by default; `0` disables throttling). */
  progressThrottleMs?: number;
  onProgress?: (
    done: number,
    total: number,
    entry: PlayAppResolvedEntry | undefined,
    batch: PlayAppResolvedEntry[],
  ) => void;
}

export interface FetchPlayStoreMetadataSummary {
  entries: Map<string, PlayAppResolvedEntry>;
  foundCount: number;
  notFoundCount: number;
  transientErrorCount: number;
  aborted: boolean;
}

export interface HydrateExternalIconsOptions {
  concurrency?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

interface PlayAppApiResponse {
  packageName: string;
  found: boolean;
  title?: string;
  iconUrl?: string;
  transientError?: boolean;
}

const sessionPlayCache = new Map<string, PlayAppResolvedEntry>();

/**
 * Return the in-memory session map of resolved Google Play package entries,
 * backed by the synchronous `localStorage` JSON mapping (`nova-editor:play-app-cache`).
 */
export function getSessionPlayStoreCache(): ReadonlyMap<string, PlayAppResolvedEntry> {
  return sessionPlayCache;
}

export function clearSessionPlayStoreCache(): void {
  sessionPlayCache.clear();
}

/**
 * Check whether a cached Play Store lookup record is still within its TTL
 * (`30d` for `found: true`, `7d` for `found: false`).
 */
export function isPlayCacheEntryFresh(
  entry: { found: boolean; fetchedAt?: number },
  nowMs = Date.now(),
): boolean {
  if (typeof entry.fetchedAt !== "number" || !Number.isFinite(entry.fetchedAt)) {
    return false;
  }
  const ttlMs = entry.found ? PLAY_CACHE_FOUND_TTL_MS : PLAY_CACHE_NOT_FOUND_TTL_MS;
  const ageMs = nowMs - entry.fetchedAt;
  return ageMs >= -60_000 && ageMs < ttlMs;
}

function resolveBrowserLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (typeof window !== "undefined") {
    return window.localStorage;
  }
  const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  if (desc && "value" in desc && desc.value) {
    return desc.value as Pick<Storage, "getItem" | "setItem">;
  }
  return null;
}

/**
 * Read the persistent Google Play lookup toggle from `localStorage`.
 * Defaults to `false` so first-time visitors make zero outbound requests unless opted in.
 */
export function readAutoFetchPlayPreference(storage?: Pick<Storage, "getItem"> | null): boolean {
  try {
    const target = storage !== undefined ? storage : resolveBrowserLocalStorage();
    if (!target || typeof target.getItem !== "function") return false;
    return target.getItem(PLAY_AUTO_FETCH_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * Persist the Google Play lookup toggle (`"true"` / `"false"`) to `localStorage`.
 */
export function writeAutoFetchPlayPreference(
  enabled: boolean,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage !== undefined ? storage : resolveBrowserLocalStorage();
    if (!target || typeof target.setItem !== "function") return;
    target.setItem(PLAY_AUTO_FETCH_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore storage quota or SecurityError in restricted browsing contexts
  }
}

/**
 * Synchronously read all fresh cached Play Store `{ found, title?, iconUrl?, fetchedAt }`
 * package mappings from `localStorage` (`nova-editor:play-app-cache`).
 */
export function readCachedPlayStoreMetadata(
  storage?: Pick<Storage, "getItem"> | null,
  nowMs = Date.now(),
): Map<string, PlayAppResolvedEntry> {
  const result = new Map<string, PlayAppResolvedEntry>();
  const useDefaultStorage = storage === undefined;

  if (useDefaultStorage) {
    for (const [pkg, entry] of sessionPlayCache) {
      if (entry.fetchedAt === undefined || isPlayCacheEntryFresh(entry, nowMs)) {
        result.set(pkg, entry);
      }
    }
  }

  try {
    const target = useDefaultStorage ? resolveBrowserLocalStorage() : storage;
    if (!target || typeof target.getItem !== "function") return result;

    const raw = target.getItem(PLAY_METADATA_CACHE_STORAGE_KEY);
    if (!raw) return result;

    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return result;
    }

    for (const [pkg, rawVal] of Object.entries(parsed as Record<string, unknown>)) {
      const trimmedPkg = pkg.trim();
      if (!trimmedPkg || !rawVal || typeof rawVal !== "object" || Array.isArray(rawVal)) {
        continue;
      }
      const rec = rawVal as Partial<PlayCachedMetadataValue>;
      if (typeof rec.found !== "boolean") continue;
      if (!isPlayCacheEntryFresh({ found: rec.found, fetchedAt: rec.fetchedAt }, nowMs)) {
        continue;
      }
      const entry: PlayAppResolvedEntry = {
        packageName: trimmedPkg,
        found: rec.found,
        ...(typeof rec.title === "string" && rec.title ? { title: rec.title } : {}),
        ...(typeof rec.iconUrl === "string" && rec.iconUrl ? { iconUrl: rec.iconUrl } : {}),
        fetchedAt: rec.fetchedAt,
      };
      result.set(trimmedPkg, entry);
      if (useDefaultStorage) {
        sessionPlayCache.set(trimmedPkg, entry);
      }
    }
  } catch {
    // Ignore malformed JSON or SecurityError in restricted browsing contexts
  }

  return result;
}

/**
 * Synchronously merge and persist fresh Google Play `{ found, title?, iconUrl?, fetchedAt }`
 * mappings to `localStorage` (`nova-editor:play-app-cache`), pruning any expired entries.
 */
export function writeCachedPlayStoreMetadata(
  entries: ReadonlyMap<string, PlayAppResolvedEntry> | Iterable<PlayAppResolvedEntry>,
  storage?: Pick<Storage, "getItem" | "setItem"> | null,
  nowMs = Date.now(),
): void {
  const useDefaultStorage = storage === undefined;
  const items: Iterable<PlayAppResolvedEntry> =
    typeof (entries as ReadonlyMap<string, PlayAppResolvedEntry>).values === "function" &&
    typeof (entries as ReadonlyMap<string, PlayAppResolvedEntry>).get === "function"
      ? (entries as ReadonlyMap<string, PlayAppResolvedEntry>).values()
      : (entries as Iterable<PlayAppResolvedEntry>);

  const target = useDefaultStorage ? resolveBrowserLocalStorage() : storage;
  const merged = new Map<string, PlayCachedMetadataValue>();

  if (target && typeof target.getItem === "function") {
    const existing = readCachedPlayStoreMetadata(target, nowMs);
    for (const [pkg, rec] of existing) {
      if (typeof rec.fetchedAt === "number") {
        merged.set(pkg, {
          found: rec.found,
          ...(rec.title ? { title: rec.title } : {}),
          ...(rec.iconUrl ? { iconUrl: rec.iconUrl } : {}),
          fetchedAt: rec.fetchedAt,
        });
      }
    }
  }

  for (const rawEntry of items) {
    const pkg = rawEntry.packageName?.trim() ?? "";
    if (!pkg) continue;
    const fetchedAt = rawEntry.fetchedAt ?? nowMs;
    if (!isPlayCacheEntryFresh({ found: rawEntry.found, fetchedAt }, nowMs)) {
      merged.delete(pkg);
      if (useDefaultStorage) {
        sessionPlayCache.delete(pkg);
      }
      continue;
    }

    const normalized: PlayAppResolvedEntry = {
      packageName: pkg,
      found: Boolean(rawEntry.found),
      ...(rawEntry.title ? { title: rawEntry.title } : {}),
      ...(rawEntry.iconUrl ? { iconUrl: rawEntry.iconUrl } : {}),
      fetchedAt,
    };
    if (useDefaultStorage) {
      sessionPlayCache.set(pkg, normalized);
    }
    merged.set(pkg, {
      found: normalized.found,
      ...(normalized.title ? { title: normalized.title } : {}),
      ...(normalized.iconUrl ? { iconUrl: normalized.iconUrl } : {}),
      fetchedAt,
    });
  }

  try {
    if (!target || typeof target.setItem !== "function") return;
    const serializedRecord: Record<string, PlayCachedMetadataValue> = {};
    for (const [pkg, val] of merged) {
      serializedRecord[pkg] = val;
    }
    target.setItem(PLAY_METADATA_CACHE_STORAGE_KEY, JSON.stringify(serializedRecord));
  } catch {
    // Ignore storage quota or SecurityError in restricted browsing contexts
  }
}

function itemNeedsPlayMetadata(item: {
  packageName: string;
  activityName: string;
  title?: string;
  iconBytes?: Uint8Array;
  iconUrl?: string;
  novaMetadata?: { hasCustomTitle?: boolean };
}): boolean {
  const pkg = item.packageName?.trim() ?? "";
  if (!pkg || isNonPlayStorePackage(pkg)) return false;
  const hasEmbeddedIcon = Boolean(item.iconBytes && item.iconBytes.byteLength > 0);
  const hasRemoteIcon = Boolean(item.iconUrl && item.iconUrl.trim().length > 0);
  if (!hasEmbeddedIcon && !hasRemoteIcon) return true;
  if (isGenericTechnicalLabel(item.title, pkg, item.activityName)) return true;
  if (
    !item.novaMetadata?.hasCustomTitle &&
    !hasCuratedAppLabel(pkg) &&
    item.title === inferHeuristicAppLabel(pkg, item.activityName)
  ) {
    return true;
  }
  return false;
}

function isPlayMetadataMap(
  arg: LauncherLayout | ReadonlyMap<string, PlayAppResolvedEntry> | undefined,
): arg is ReadonlyMap<string, PlayAppResolvedEntry> {
  return Boolean(
    arg && typeof (arg as ReadonlyMap<string, PlayAppResolvedEntry>).has === "function",
  );
}

/**
 * Collect unique `packageName`s missing icons or non-heuristic titles across loaded layouts,
 * excluding any packages already present in an optional `knownMetadata` map (including
 * `found: false` 404 entries so non-Play apps are never re-fetched in a loop).
 * Prioritizes visible home screen & hotseat packages FIRST so workspace icons pop in immediately,
 * followed by extra dock pages, app-drawer groups, and `appCatalog`.
 */
export function collectMissingMetadataPackages(
  ...args: (LauncherLayout | ReadonlyMap<string, PlayAppResolvedEntry> | undefined)[]
): string[] {
  const layouts: LauncherLayout[] = [];
  const knownMaps: ReadonlyMap<string, PlayAppResolvedEntry>[] = [];
  for (const arg of args) {
    if (!arg) continue;
    if (isPlayMetadataMap(arg)) {
      knownMaps.push(arg);
    } else {
      layouts.push(arg);
    }
  }

  const isAlreadyChecked = (pkg: string): boolean => {
    for (const map of knownMaps) {
      if (map.has(pkg)) return true;
    }
    return false;
  };

  const priorityPackages = new Set<string>();
  const secondaryPackages = new Set<string>();

  const visitItem = (item: LayoutItem, targetSet: Set<string>): void => {
    if (item.kind === "folder") {
      for (const child of item.children) {
        visitItem(child, targetSet);
      }
      return;
    }
    if (item.kind === "widget" || item.kind === "launcherAction") return;
    if (itemNeedsPlayMetadata(item)) {
      const pkg = item.packageName.trim();
      if (!isAlreadyChecked(pkg) && !priorityPackages.has(pkg)) {
        targetSet.add(pkg);
      }
    }
  };

  // Pass 1: Home screens & primary hotseat (visible workspace priority)
  for (const layout of layouts) {
    for (const screen of layout.screens) {
      for (const item of screen.items) {
        visitItem(item, priorityPackages);
      }
    }
    for (const item of layout.hotseat) {
      visitItem(item, priorityPackages);
    }
  }

  // Pass 2: Extra dock pages, app drawer groups/items, and full appCatalog
  for (const layout of layouts) {
    if (layout.dockPages) {
      for (const dp of layout.dockPages) {
        if (dp.page === 0) continue;
        for (const item of dp.items) {
          visitItem(item, secondaryPackages);
        }
      }
    }
    if (layout.drawerGroups) {
      for (const group of layout.drawerGroups) {
        for (const item of group.items) {
          visitItem(item, secondaryPackages);
        }
      }
    }
    if (layout.drawerItems) {
      for (const item of layout.drawerItems) {
        visitItem(item, secondaryPackages);
      }
    }
    if (layout.appCatalog) {
      for (const app of layout.appCatalog) {
        if (itemNeedsPlayMetadata(app)) {
          const pkg = app.packageName.trim();
          if (!isAlreadyChecked(pkg) && !priorityPackages.has(pkg)) {
            secondaryPackages.add(pkg);
          }
        }
      }
    }
  }

  return [...priorityPackages, ...secondaryPackages];
}

/**
 * Fetch missing Google Play `{ title, iconUrl }` metadata using a bounded worker pool,
 * consulting the synchronous `localStorage` + session cache (`nova-editor:play-app-cache`) first
 * while streaming batched progress updates via `onProgress`.
 * Image bytes are NOT downloaded here — `<img referrerPolicy="no-referrer" />` loads and caches
 * `play-lh.googleusercontent.com` icons natively via the browser's HTTP cache.
 */
export async function fetchMissingPlayStoreMetadata(
  packages: readonly string[],
  options: FetchPlayStoreMetadataOptions = {},
): Promise<FetchPlayStoreMetadataSummary> {
  const uniquePackages: string[] = [];
  const seen = new Set<string>();
  for (const raw of packages) {
    const pkg = raw.trim();
    if (!pkg || isNonPlayStorePackage(pkg) || seen.has(pkg)) continue;
    seen.add(pkg);
    uniquePackages.push(pkg);
  }

  const total = uniquePackages.length;
  const entries = new Map<string, PlayAppResolvedEntry>();
  if (total === 0) {
    return {
      entries,
      foundCount: 0,
      notFoundCount: 0,
      transientErrorCount: 0,
      aborted: Boolean(options.signal?.aborted),
    };
  }

  const fetchFn = options.fetchImpl ?? fetch;
  const apiBase = (options.apiBase ?? "").replace(/\/+$/, "");
  const defaultConcurrency =
    typeof window !== "undefined" && window.location.protocol === "https:" ? 14 : 8;
  const concurrency = Math.max(1, options.concurrency ?? defaultConcurrency);
  const throttleMs = Math.max(0, options.progressThrottleMs ?? 120);
  const signal = options.signal;

  let done = 0;
  let foundCount = 0;
  let notFoundCount = 0;
  let transientErrorCount = 0;
  let pendingBatch: PlayAppResolvedEntry[] = [];
  let pendingPersist: PlayAppResolvedEntry[] = [];
  let latestEntry: PlayAppResolvedEntry | undefined;
  let lastEmitAt = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;

  const flushPersist = (): void => {
    if (pendingPersist.length === 0) return;
    const toWrite = pendingPersist;
    pendingPersist = [];
    writeCachedPlayStoreMetadata(toWrite, options.storage);
  };

  const flushProgress = (): void => {
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
    }
    flushPersist();
    lastEmitAt = Date.now();
    const batch = pendingBatch;
    pendingBatch = [];
    options.onProgress?.(done, total, latestEntry, batch);
  };

  const recordProgress = (entry: PlayAppResolvedEntry | undefined): void => {
    done += 1;
    if (entry) {
      latestEntry = entry;
      pendingBatch.push(entry);
    }
    if (!options.onProgress) return;
    if (throttleMs === 0 || done >= total) {
      flushProgress();
      return;
    }
    const elapsed = Date.now() - lastEmitAt;
    if (elapsed >= throttleMs) {
      flushProgress();
    } else if (pendingTimer === undefined) {
      pendingTimer = setTimeout(flushProgress, throttleMs - elapsed);
    }
  };

  // 1. Synchronously read cached Play mappings from `localStorage` (+ `sessionPlayCache`)
  const nowMs = Date.now();
  const cachedMap = readCachedPlayStoreMetadata(options.storage, nowMs);
  const uncachedQueue: string[] = [];

  for (const pkg of uniquePackages) {
    const hit = cachedMap.get(pkg);
    if (hit && (hit.fetchedAt === undefined || isPlayCacheEntryFresh(hit, nowMs))) {
      entries.set(pkg, hit);
      if (hit.found) foundCount += 1;
      else notFoundCount += 1;
      done += 1;
      latestEntry = hit;
      pendingBatch.push(hit);
    } else {
      uncachedQueue.push(pkg);
    }
  }

  if (pendingBatch.length > 0 && options.onProgress) {
    flushProgress();
  }

  if (uncachedQueue.length === 0 || signal?.aborted) {
    return {
      entries,
      foundCount,
      notFoundCount,
      transientErrorCount,
      aborted: Boolean(signal?.aborted),
    };
  }

  // 2. Concurrent worker pool querying `/api/play-app?id=...` for uncached packages
  let cursor = 0;
  const workerCount = Math.min(concurrency, uncachedQueue.length);

  const runWorker = async (): Promise<void> => {
    while (!signal?.aborted) {
      const idx = cursor;
      cursor += 1;
      if (idx >= uncachedQueue.length) return;

      const pkg = uncachedQueue[idx];
      try {
        const metaRes = await fetchFn(`${apiBase}/api/play-app?id=${encodeURIComponent(pkg)}`, {
          method: "GET",
          signal,
        });

        if (!metaRes.ok) {
          transientErrorCount += 1;
          recordProgress(undefined);
          continue;
        }

        const payload = (await metaRes.json()) as PlayAppApiResponse;
        if (payload.transientError) {
          transientErrorCount += 1;
          recordProgress(undefined);
          continue;
        }

        const fetchedAt = Date.now();
        if (!payload.found) {
          const missEntry: PlayAppResolvedEntry = {
            packageName: pkg,
            found: false,
            fetchedAt,
          };
          if (options.storage === undefined) {
            sessionPlayCache.set(pkg, missEntry);
          }
          pendingPersist.push(missEntry);
          entries.set(pkg, missEntry);
          notFoundCount += 1;
          recordProgress(missEntry);
          continue;
        }

        const hitEntry: PlayAppResolvedEntry = {
          packageName: pkg,
          found: true,
          ...(payload.title ? { title: payload.title } : {}),
          ...(payload.iconUrl ? { iconUrl: payload.iconUrl } : {}),
          fetchedAt,
        };
        if (options.storage === undefined) {
          sessionPlayCache.set(pkg, hitEntry);
        }
        pendingPersist.push(hitEntry);
        entries.set(pkg, hitEntry);
        foundCount += 1;
        recordProgress(hitEntry);
      } catch {
        if (signal?.aborted) return;
        transientErrorCount += 1;
        recordProgress(undefined);
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  flushPersist();
  if (pendingTimer !== undefined || pendingBatch.length > 0) {
    flushProgress();
  }

  return {
    entries,
    foundCount,
    notFoundCount,
    transientErrorCount,
    aborted: Boolean(signal?.aborted),
  };
}

/**
 * Lazily hydrate raw `iconBytes` from `item.iconUrl` (typically served from the browser's warm
 * HTTP disk cache with `referrerPolicy: "no-referrer"`) right before exporting a `.novabackup`
 * SQLite archive, so `favorites.icon` contains embedded PNG blobs for converted items.
 */
export async function hydrateExternalIconBytesForExport(
  layout: LauncherLayout,
  options: HydrateExternalIconsOptions = {},
): Promise<LauncherLayout> {
  const fetchFn = options.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
  if (!fetchFn) return layout;

  const uniqueUrls = new Set<string>();
  const collectItemUrls = (item: LayoutItem): void => {
    if (item.kind === "folder") {
      item.children.forEach(collectItemUrls);
      return;
    }
    if ((!item.iconBytes || item.iconBytes.byteLength === 0) && item.iconUrl) {
      uniqueUrls.add(item.iconUrl);
    }
  };

  layout.screens.forEach((screen) => screen.items.forEach(collectItemUrls));
  layout.hotseat.forEach(collectItemUrls);
  layout.dockPages?.forEach((dp) => {
    if (dp.page !== 0) dp.items.forEach(collectItemUrls);
  });

  if (uniqueUrls.size === 0) return layout;

  const urls = [...uniqueUrls];
  const bytesByUrl = new Map<string, Uint8Array>();
  const concurrency = Math.max(1, options.concurrency ?? 8);
  let cursor = 0;

  const runWorker = async (): Promise<void> => {
    while (!options.signal?.aborted) {
      const idx = cursor;
      cursor += 1;
      if (idx >= urls.length) return;
      const url = urls[idx];
      try {
        const res = await fetchFn(url, {
          method: "GET",
          mode: "cors",
          referrerPolicy: "no-referrer",
          signal: options.signal,
        });
        if (!res.ok) continue;
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.byteLength > 0) {
          bytesByUrl.set(url, bytes);
        }
      } catch {
        // Non-fatal in offline/test environments
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => runWorker()));

  if (bytesByUrl.size === 0) return layout;

  let changed = false;
  const hydrateItem = (item: LayoutItem): LayoutItem => {
    if (item.kind === "folder") {
      const nextChildren = item.children.map(hydrateItem);
      if (nextChildren.some((c, i) => c !== item.children[i])) {
        changed = true;
        return { ...item, children: nextChildren };
      }
      return item;
    }
    if ((!item.iconBytes || item.iconBytes.byteLength === 0) && item.iconUrl) {
      const fetched = bytesByUrl.get(item.iconUrl);
      if (fetched) {
        changed = true;
        return { ...item, iconBytes: fetched };
      }
    }
    return item;
  };

  const screens = layout.screens.map((screen) => ({
    ...screen,
    items: screen.items.map(hydrateItem),
  }));
  const hotseat = layout.hotseat.map(hydrateItem);
  const dockPages = layout.dockPages?.map((dp) =>
    dp.page === 0 ? { ...dp, items: hotseat } : { ...dp, items: dp.items.map(hydrateItem) },
  );

  if (!changed) return layout;

  return {
    ...layout,
    screens,
    hotseat,
    ...(dockPages ? { dockPages } : {}),
  };
}
