import JSZip from "jszip";
import React, { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  addBlankScreen,
  applyExternalAppMetadata,
  AUTOSAVE_SLOT_ID,
  buildEffectiveFolderDisplayConfig,
  collectMissingMetadataPackages,
  collectPersonalPackages,
  collectPlacedAppKeys,
  convertLayout,
  convertToNovaLayout,
  decodeSamsungExml,
  deletePrimaryItem,
  deleteSavedWorkspace,
  enrichLayoutIcons,
  evaluateDropOutcome,
  fetchMissingPlayStoreMetadata,
  formatBackupDate,
  formatRelativeTimeAgo,
  getSavedWorkspace,
  hydrateExternalIconBytesForExport,
  inferBackupTimestamp,
  listSavedWorkspaces,
  parseNovaBackup,
  parseSamsungFolderGrid,
  parseSamsungXml,
  putSavedWorkspace,
  readAutoFetchPlayPreference,
  readCachedPlayStoreMetadata,
  removeScreen,
  renameFolder,
  renderSamsungPreviewPng,
  resizeDesktopGrid,
  resizeDockSlots,
  SAMSUNG_FOLDER_GRIDS,
  serializeNovaBackup,
  serializeSamsungXml,
  unwrapSingleItemFolder,
  writeAutoFetchPlayPreference,
  type ConversionWarning,
  type DockEdge,
  type GridEdge,
  type LauncherLayout,
  type LayoutItem,
  type NovaFolderStyle,
  type PlayAppResolvedEntry,
  type SamsungFolderGrid,
  type SavedExportPreferences,
  type SavedWorkspaceRecord,
} from "./core";
import FileForm from "./components/FileForm";
import HelpModal, { type ExportCompletedInfo, type HelpTopic } from "./components/HelpModal";
import LoadSaveModal from "./components/LoadSaveModal";
import PagesView from "./components/PagesView";
import {
  hoverToDropTarget,
  PointerDragLayer,
  type FolderModalDragContext,
  type HoverTargetState,
  type PointerDragSession,
} from "./components/PointerDragLayer";

type LoadState = "idle" | "loading" | "loaded";
type PanelTab = "samsung" | "nova" | "save";

const SAMSUNG_DEFAULT_PREVIEW_COLS = 3 as const;

interface OpenFolderModalState {
  origin: "primary" | "donor";
  folderId: string;
}

interface BottomToastState {
  id: number;
  message: string;
  tone: "warning" | "success";
}

interface DevBackupFixture {
  name: string;
  path: string;
  size: number;
  url: string;
}

interface ExportAuditEntry {
  filename: string;
  size: number;
  mimeType: string;
  savedPath?: string;
}

export interface GroupedWarningSection {
  code: ConversionWarning["code"];
  heading: string;
  totalCount: number;
  entries: string[];
}

const WARNING_CATEGORY_TITLES: Record<ConversionWarning["code"], string> = {
  "subgrid-snapped":
    "Half-cell (subgrid) widgets snapped to whole grid cells (One UI Home requires integer cells)",
  "nova-gesture-dropped": "Per-icon swipe gestures dropped",
  "work-profile-downgraded":
    "Work Profile apps also in Personal Profile (will restore as Personal shortcuts)",
  "work-only-skipped":
    "Work-only apps not found in Personal Profile (will be dropped on restore unless installed in Personal)",
  "extra-dock-page-dropped": "Extra Nova dock pages dropped (One UI Home has a single dock page)",
  "stacked-widget-flattened":
    "Samsung widget stacks flattened to primary widget (Nova Launcher does not support swipeable widget stacks)",
  "widget-skipped": "Home screen widgets requiring manual tap-to-bind or skipped",
  "unsupported-action": "Launcher-specific shortcut actions skipped",
  collision: "Items nudged to nearby cells to avoid overlap",
  "hotseat-duplicate": "Duplicate dock slot items skipped",
  "out-of-bounds": "Items skipped because all target slots were full",
};

export function groupConversionWarnings(warnings: ConversionWarning[]): GroupedWarningSection[] {
  const map = new Map<ConversionWarning["code"], string[]>();
  for (const w of warnings) {
    const list = map.get(w.code) ?? [];
    list.push(w.detail || w.message);
    map.set(w.code, list);
  }
  return [...map.entries()].map(([code, rawEntries]) => {
    const counts = new Map<string, number>();
    for (const entry of rawEntries) {
      counts.set(entry, (counts.get(entry) ?? 0) + 1);
    }
    const entries = [...counts.entries()].map(([label, count]) =>
      count > 1 ? `${label} (×${count})` : label,
    );
    return {
      code,
      heading: WARNING_CATEGORY_TITLES[code] ?? code,
      totalCount: rawEntries.length,
      entries,
    };
  });
}

async function parseBackupBytes(bytes: Uint8Array, filename: string): Promise<LauncherLayout> {
  const extension = filename.toLowerCase().split(".").pop();
  if (extension === "novabackup" || extension === "zip") {
    return parseNovaBackup(bytes);
  }
  if (extension === "exml") {
    const decoded = await decodeSamsungExml(bytes);
    return parseSamsungXml(decoded.xml);
  }
  if (extension === "xml") {
    return parseSamsungXml(new TextDecoder().decode(bytes));
  }
  throw new Error("Choose a Nova (.novabackup) or Samsung Home Up (.exml / .xml) backup file.");
}

async function saveOrDownloadBlob(
  blob: Blob,
  filename: string,
  saveToDevServer: boolean,
): Promise<string | undefined> {
  let savedPath: string | undefined;
  if (import.meta.env.DEV && saveToDevServer) {
    const response = await fetch(`/__dev/exports/${encodeURIComponent(filename)}`, {
      method: "POST",
      headers: { "Content-Type": blob.type || "application/octet-stream" },
      body: blob,
    });
    if (!response.ok) {
      throw new Error(`Dev server export failed (${response.status})`);
    }
    const payload = (await response.json()) as { savedPath: string };
    savedPath = payload.savedPath;
  } else {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (import.meta.env.DEV) {
    const win = window as unknown as { __devExports?: ExportAuditEntry[] };
    win.__devExports = win.__devExports ?? [];
    win.__devExports.push({
      filename,
      size: blob.size,
      mimeType: blob.type,
      savedPath,
    });
  }
  return savedPath;
}

function stripPlayStoreCachedMetadata(
  item: LayoutItem,
  playMetadataMap: ReadonlyMap<string, PlayAppResolvedEntry>,
): LayoutItem {
  if (item.kind === "folder") {
    return {
      ...item,
      children: item.children.map((child) => stripPlayStoreCachedMetadata(child, playMetadataMap)),
    };
  }
  const cached = item.packageName ? playMetadataMap.get(item.packageName) : undefined;
  if (cached?.iconUrl && item.iconUrl === cached.iconUrl) {
    const copy = { ...item };
    delete copy.iconUrl;
    return copy;
  }
  return item;
}

const CompatibilityNotesBox: React.FC<{ warnings: ConversionWarning[] }> = ({ warnings }) => {
  const groups = useMemo(() => groupConversionWarnings(warnings), [warnings]);
  if (groups.length === 0) return null;

  return (
    <details className="conversion-notes mt-3">
      <summary>
        Migrating from one launcher format to another will result in the loss of launcher-specific
        features ({warnings.length})
      </summary>
      <p className="mt-2 mb-2">
        Migrating from one launcher format to another will result in the loss of launcher-specific
        features, including:
      </p>
      <div className="conversion-groups">
        {groups.map((group) => (
          <div key={group.code} className="conversion-group-block">
            <div className="conversion-group-heading">
              {group.heading} <span className="conversion-group-count">({group.totalCount})</span>
            </div>
            <ul className="conversion-group-list">
              {group.entries.map((entry, idx) => (
                <li key={`${group.code}-${idx}-${entry}`}>{entry}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
};

const App: React.FC = () => {
  const [rawPrimaryLayout, setRawPrimaryLayout] = useState<LauncherLayout>();
  const [primaryFilename, setPrimaryFilename] = useState<string>("");
  const [primaryBackupTimestamp, setPrimaryBackupTimestamp] = useState<number | undefined>();
  const [hasUserLoadedPrimary, setHasUserLoadedPrimary] = useState<boolean>(false);
  const [isDirty, setIsDirty] = useState<boolean>(false);

  const [rawDonorLayout, setRawDonorLayout] = useState<LauncherLayout>();
  const [donorFilename, setDonorFilename] = useState<string>("");
  const [donorBackupTimestamp, setDonorBackupTimestamp] = useState<number | undefined>();

  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string>();
  const [helpTopic, setHelpTopic] = useState<HelpTopic | null>(null);
  const [exportModalInfo, setExportModalInfo] = useState<ExportCompletedInfo | null>(null);

  const [openFolderModal, setOpenFolderModal] = useState<OpenFolderModalState | null>(null);
  const [dragSession, setDragSession] = useState<PointerDragSession | null>(null);
  const [hoverTarget, setHoverTarget] = useState<HoverTargetState | null>(null);
  const [toast, setToast] = useState<BottomToastState | null>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);

  // Panel tabs: Nova Export, Samsung Export, or Save Snapshot (defaults to same -> same format)
  const [panelTab, setPanelTab] = useState<PanelTab>("nova");
  const [lastLauncherTab, setLastLauncherTab] = useState<"samsung" | "nova">("nova");

  // Samsung target settings (note: closed folder icon preview is fixed at 3×3 in One UI Home; `.exml` does not store Home Up's preview override)
  const [keepWidgets, setKeepWidgets] = useState(true);
  const [includeDrawerFolders, setIncludeDrawerFolders] = useState(true);
  const [includeDrawerTabs, setIncludeDrawerTabs] = useState(true);
  const [samsungFolderGrid, setSamsungFolderGrid] = useState<SamsungFolderGrid>("3X4");

  // Nova target settings
  const [novaFolderStyle, setNovaFolderStyle] = useState<NovaFolderStyle>("WINDOW");
  const [novaFolderRows, setNovaFolderRows] = useState<number>(4);
  const [novaFolderCols, setNovaFolderCols] = useState<number>(4);
  const [novaPreviewCols, setNovaPreviewCols] = useState<2 | 3>(2);
  const [novaFolderConfigModified, setNovaFolderConfigModified] = useState<boolean>(false);
  const [novaFolderPreviewModified, setNovaFolderPreviewModified] = useState<boolean>(false);

  // Persistence state (IndexedDB autosave + manual saves)
  const [savedWorkspaces, setSavedWorkspaces] = useState<SavedWorkspaceRecord[]>([]);
  const [isLoadSaveModalOpen, setIsLoadSaveModalOpen] = useState(false);
  const [manualSaveName, setManualSaveName] = useState("");
  const [lastAutosavedAt, setLastAutosavedAt] = useState<number | undefined>();
  const skipNextAutosaveRef = useRef(false);

  // Shared Google Play Store `{ title, iconUrl }` mapping cache (`localStorage`) + persistent opt-in toggle
  const [playMetadataMap, setPlayMetadataMap] = useState<Map<string, PlayAppResolvedEntry>>(() =>
    readCachedPlayStoreMetadata(),
  );
  const [autoFetchPlayIcons, setAutoFetchPlayIcons] = useState<boolean>(() =>
    readAutoFetchPlayPreference(),
  );
  const [playFetchProgress, setPlayFetchProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const playFetchAbortRef = useRef<AbortController | null>(null);
  const transientFailedPlayPackagesRef = useRef<Set<string>>(new Set());
  const [playFetchRunTick, setPlayFetchRunTick] = useState<number>(0);

  // Dev-only state
  const [devFixtures, setDevFixtures] = useState<DevBackupFixture[]>([]);
  const [selectedDevFixture, setSelectedDevFixture] = useState<string>("");
  const [saveToDevServer, setSaveToDevServer] = useState<boolean>(() =>
    import.meta.env.DEV
      ? new URLSearchParams(window.location.search).get("devSave") === "1"
      : false,
  );

  const showToast = (message: string, tone: "warning" | "success" = "warning"): void => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToast({ id: Date.now(), message, tone });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
    }, 3800);
  };

  const refreshSavedWorkspaces = async (): Promise<SavedWorkspaceRecord[]> => {
    try {
      const list = await listSavedWorkspaces();
      setSavedWorkspaces(list);
      return list;
    } catch {
      return [];
    }
  };

  const syncFolderSettingsFromParsedLayout = (parsed: LauncherLayout): void => {
    const snappedSamsung = parseSamsungFolderGrid(parsed.grid.folderGrid ?? "3X4").normalized;
    setSamsungFolderGrid(snappedSamsung);
    setNovaFolderConfigModified(false);
    setNovaFolderPreviewModified(false);
    if (parsed.sourceFormat === "samsung") {
      const { cols, rows } = parseSamsungFolderGrid(snappedSamsung);
      setNovaFolderStyle("IMMERSIVE");
      setNovaFolderCols(cols);
      setNovaFolderRows(rows);
      setNovaPreviewCols(3);
    } else {
      const preview = (parsed.grid.folderPreviewCols ?? 2) >= 3 ? 3 : 2;
      setNovaFolderStyle(parsed.grid.novaFolderStyle ?? "WINDOW");
      setNovaFolderRows(parsed.grid.novaFolderRows ?? 4);
      setNovaFolderCols(parsed.grid.novaFolderCols ?? 4);
      setNovaPreviewCols(preview);
    }
  };

  // Cross-enrich icons AND human-readable app titles across both loaded backups, then dynamically
  // overlay cached Play Store metadata so `rawPrimaryLayout` & `rawDonorLayout` stay lean in saves!
  const crossEnrichedPrimary = useMemo(
    () => (rawPrimaryLayout ? enrichLayoutIcons(rawPrimaryLayout, rawDonorLayout) : undefined),
    [rawPrimaryLayout, rawDonorLayout],
  );
  const crossEnrichedDonor = useMemo(
    () => (rawDonorLayout ? enrichLayoutIcons(rawDonorLayout, rawPrimaryLayout) : undefined),
    [rawDonorLayout, rawPrimaryLayout],
  );

  const primaryLayout = useMemo(
    () =>
      crossEnrichedPrimary
        ? applyExternalAppMetadata(crossEnrichedPrimary, playMetadataMap)
        : undefined,
    [crossEnrichedPrimary, playMetadataMap],
  );

  const donorLayout = useMemo(
    () =>
      crossEnrichedDonor
        ? applyExternalAppMetadata(crossEnrichedDonor, playMetadataMap)
        : undefined,
    [crossEnrichedDonor, playMetadataMap],
  );

  const baseUnknownPackages = useMemo(
    () => collectMissingMetadataPackages(crossEnrichedPrimary, crossEnrichedDonor),
    [crossEnrichedPrimary, crossEnrichedDonor],
  );

  const unresolvedPlayPackages = useMemo(
    () => collectMissingMetadataPackages(primaryLayout, donorLayout, playMetadataMap),
    [primaryLayout, donorLayout, playMetadataMap],
  );

  const showPlayResolveRow =
    unresolvedPlayPackages.length > 0 ||
    playFetchProgress !== null ||
    (autoFetchPlayIcons && baseUnknownPackages.length > 0);

  const placedPrimaryKeys = useMemo(() => collectPlacedAppKeys(primaryLayout), [primaryLayout]);

  const activeTargetLauncher: "samsung" | "nova" = panelTab === "save" ? lastLauncherTab : panelTab;

  const primaryFolderDisplay = useMemo(
    () =>
      buildEffectiveFolderDisplayConfig({
        targetFormat: activeTargetLauncher,
        samsungFolderGrid,
        samsungPreviewCols: SAMSUNG_DEFAULT_PREVIEW_COLS,
        novaStyle: novaFolderStyle,
        novaRows: novaFolderRows,
        novaCols: novaFolderCols,
        novaPreviewCols,
      }),
    [
      activeTargetLauncher,
      samsungFolderGrid,
      novaFolderStyle,
      novaFolderRows,
      novaFolderCols,
      novaPreviewCols,
    ],
  );

  const donorFolderDisplay = useMemo(() => {
    if (!donorLayout) return primaryFolderDisplay;
    const dGrid = parseSamsungFolderGrid(donorLayout.grid.folderGrid ?? "3X4").normalized;
    return buildEffectiveFolderDisplayConfig({
      targetFormat: donorLayout.sourceFormat,
      samsungFolderGrid: dGrid,
      samsungPreviewCols: SAMSUNG_DEFAULT_PREVIEW_COLS,
      novaStyle: donorLayout.grid.novaFolderStyle ?? "WINDOW",
      novaRows: donorLayout.grid.novaFolderRows ?? 4,
      novaCols: donorLayout.grid.novaFolderCols ?? 4,
      novaPreviewCols: (donorLayout.grid.folderPreviewCols ?? 2) >= 3 ? 3 : 2,
    });
  }, [donorLayout, primaryFolderDisplay]);

  const openBackupIntoSlot = async (
    bytes: Uint8Array,
    filename: string,
    slot: "primary" | "donor",
    isUserInitiated: boolean,
    fileLastModified?: number,
  ): Promise<void> => {
    setLoadState("loading");
    setError(undefined);
    try {
      const parsed = await parseBackupBytes(bytes, filename);
      const parsedTimestamp = inferBackupTimestamp(
        filename,
        fileLastModified,
        parsed.backupTimestamp,
      );
      transientFailedPlayPackagesRef.current.clear();
      if (slot === "primary") {
        playFetchAbortRef.current?.abort();
        setRawPrimaryLayout(parsed);
        setPrimaryFilename(filename);
        setPrimaryBackupTimestamp(parsedTimestamp);
        setHasUserLoadedPrimary(isUserInitiated);
        setIsDirty(false);
        setLastAutosavedAt(undefined);
        setPanelTab(parsed.sourceFormat);
        setLastLauncherTab(parsed.sourceFormat);
        syncFolderSettingsFromParsedLayout(parsed);
        if (openFolderModal?.origin === "primary") setOpenFolderModal(null);
      } else {
        setRawDonorLayout(parsed);
        setDonorFilename(filename);
        setDonorBackupTimestamp(parsedTimestamp);
        setIsDirty(false);
        if (openFolderModal?.origin === "donor") setOpenFolderModal(null);
      }
      setLoadState("loaded");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setLoadState("idle");
    }
  };

  const fetchBackupIntoSlot = async (
    url: string,
    label: string,
    slot: "primary" | "donor",
    isUserInitiated: boolean,
  ): Promise<void> => {
    setLoadState("loading");
    setError(undefined);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch ${url} (${response.status})`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      await openBackupIntoSlot(bytes, label, slot, isUserInitiated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setLoadState("idle");
    }
  };

  const restoreSavedRecord = (record: SavedWorkspaceRecord): void => {
    transientFailedPlayPackagesRef.current.clear();
    playFetchAbortRef.current?.abort();
    skipNextAutosaveRef.current = true;
    setIsDirty(false);
    setRawPrimaryLayout(record.layout);
    setPrimaryFilename(record.sourceFilename);
    setPrimaryBackupTimestamp(
      record.originalBackupTimestamp ??
        inferBackupTimestamp(record.sourceFilename, undefined, record.layout.backupTimestamp),
    );
    setHasUserLoadedPrimary(true);
    setRawDonorLayout(record.donorLayout);
    setDonorFilename(record.donorFilename ?? "");
    setDonorBackupTimestamp(
      record.donorBackupTimestamp ??
        (record.donorFilename
          ? inferBackupTimestamp(
              record.donorFilename,
              undefined,
              record.donorLayout?.backupTimestamp,
            )
          : undefined),
    );
    setOpenFolderModal(null);

    if (record.exportPrefs) {
      const p = record.exportPrefs;
      setPanelTab(p.exportTab);
      setLastLauncherTab(p.exportTab);
      setKeepWidgets(p.keepWidgets);
      setIncludeDrawerFolders(p.includeDrawerFolders);
      setIncludeDrawerTabs(p.includeDrawerTabs);
      setSamsungFolderGrid(p.samsungFolderGrid);
      setNovaFolderStyle(p.novaFolderStyle);
      setNovaFolderRows(p.novaFolderRows);
      setNovaFolderCols(p.novaFolderCols);
      setNovaPreviewCols(p.novaPreviewCols);
      setNovaFolderConfigModified(Boolean(p.novaFolderConfigModified));
      setNovaFolderPreviewModified(Boolean(p.novaFolderPreviewModified));
    } else {
      setPanelTab(record.layout.sourceFormat);
      setLastLauncherTab(record.layout.sourceFormat);
      syncFolderSettingsFromParsedLayout(record.layout);
    }
    setLastAutosavedAt(record.updatedAt);
    setLoadState("loaded");
  };

  const onChangePrimaryFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (file) {
      await openBackupIntoSlot(
        new Uint8Array(await file.arrayBuffer()),
        file.name,
        "primary",
        true,
        file.lastModified,
      );
      event.target.value = "";
    }
  };

  const onChangeDonorFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (file) {
      await openBackupIntoSlot(
        new Uint8Array(await file.arrayBuffer()),
        file.name,
        "donor",
        true,
        file.lastModified,
      );
      event.target.value = "";
    }
  };

  useEffect(() => {
    let cancelled = false;

    const init = async (): Promise<void> => {
      if (import.meta.env.DEV) {
        fetch("/__dev/backups")
          .then((res) =>
            res.ok ? (res.json() as Promise<{ fixtures: DevBackupFixture[] }>) : Promise.reject(),
          )
          .then((data) => {
            if (cancelled) return;
            setDevFixtures(data.fixtures);
            if (data.fixtures.length > 0) {
              setSelectedDevFixture(data.fixtures[0].path);
            }
          })
          .catch(() => undefined);

        const params = new URLSearchParams(window.location.search);
        const donorParam = params.get("donor");
        if (donorParam) {
          const donorLabel = donorParam.split("/").pop() || donorParam;
          void fetchBackupIntoSlot(
            `/__dev/backups/${encodeURI(donorParam)}`,
            donorLabel,
            "donor",
            true,
          );
        }

        const devFixtureParam = params.get("fixture");
        if (devFixtureParam) {
          void refreshSavedWorkspaces();
          const label = devFixtureParam.split("/").pop() || devFixtureParam;
          await fetchBackupIntoSlot(
            `/__dev/backups/${encodeURI(devFixtureParam)}`,
            label,
            "primary",
            true,
          );
          return;
        }
      }

      // Check IndexedDB for an existing Autosave slot first!
      await refreshSavedWorkspaces();
      try {
        const autosave = await getSavedWorkspace(AUTOSAVE_SLOT_ID);
        if (!cancelled && autosave) {
          restoreSavedRecord(autosave);
          return;
        }
      } catch {
        // Ignore IndexedDB unavailability and fall back to sample preview
      }

      if (cancelled) return;
      fetch("/sample/sample.novabackup")
        .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject()))
        .then((bytes) => {
          if (!cancelled) {
            void openBackupIntoSlot(new Uint8Array(bytes), "sample.novabackup", "primary", false);
          }
        })
        .catch(() => undefined);
    };

    void init();
    return () => {
      cancelled = true;
      playFetchAbortRef.current?.abort();
    };
  }, []);

  const currentExportPrefs: SavedExportPreferences = useMemo(
    () => ({
      exportTab: lastLauncherTab,
      keepWidgets,
      includeDrawerFolders,
      includeDrawerTabs,
      samsungFolderGrid,
      samsungPreviewCols: SAMSUNG_DEFAULT_PREVIEW_COLS,
      novaFolderStyle,
      novaFolderRows,
      novaFolderCols,
      novaPreviewCols,
      novaFolderConfigModified,
      novaFolderPreviewModified,
    }),
    [
      lastLauncherTab,
      keepWidgets,
      includeDrawerFolders,
      includeDrawerTabs,
      samsungFolderGrid,
      novaFolderStyle,
      novaFolderRows,
      novaFolderCols,
      novaPreviewCols,
      novaFolderConfigModified,
      novaFolderPreviewModified,
    ],
  );

  // Debounced background autosave to IndexedDB ONLY after actual user edits (`isDirty`)
  useEffect(() => {
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      return;
    }
    if (!hasUserLoadedPrimary || !isDirty || !rawPrimaryLayout || !primaryLayout) return;

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const previewLayout: LauncherLayout = {
            ...primaryLayout,
            grid: {
              ...primaryLayout.grid,
              folderPreviewCols: primaryFolderDisplay.previewGridCols,
            },
          };
          const previewPngBytes = await renderSamsungPreviewPng(previewLayout, 180, 390);
          const now = Date.now();
          const record: SavedWorkspaceRecord = {
            id: AUTOSAVE_SLOT_ID,
            isAutosave: true,
            name: "Autosave",
            sourceFilename: primaryFilename || rawPrimaryLayout.sourceFormat,
            sourceFormat: rawPrimaryLayout.sourceFormat,
            originalBackupTimestamp: primaryBackupTimestamp,
            createdAt: now,
            updatedAt: now,
            previewPngBytes,
            layout: rawPrimaryLayout,
            ...(rawDonorLayout
              ? {
                  donorLayout: rawDonorLayout,
                  donorFilename,
                  donorBackupTimestamp,
                }
              : {}),
            exportPrefs: currentExportPrefs,
          };
          await putSavedWorkspace(record);
          setLastAutosavedAt(now);
          await refreshSavedWorkspaces();
        } catch {
          // Non-fatal if browser blocks storage in private mode
        }
      })();
    }, 450);

    return () => window.clearTimeout(timer);
  }, [
    hasUserLoadedPrimary,
    isDirty,
    rawPrimaryLayout,
    primaryLayout,
    rawDonorLayout,
    donorFilename,
    donorBackupTimestamp,
    primaryFilename,
    primaryBackupTimestamp,
    currentExportPrefs,
    primaryFolderDisplay.previewGridCols,
  ]);

  const handleCreateManualSave = async (): Promise<void> => {
    if (!rawPrimaryLayout || !primaryLayout) return;
    try {
      const previewLayout: LauncherLayout = {
        ...primaryLayout,
        grid: {
          ...primaryLayout.grid,
          folderPreviewCols: primaryFolderDisplay.previewGridCols,
        },
      };
      const previewPngBytes = await renderSamsungPreviewPng(previewLayout, 180, 390);
      const now = Date.now();
      const id = `save:${crypto.randomUUID()}`;
      const trimmedName = manualSaveName.trim();
      const record: SavedWorkspaceRecord = {
        id,
        isAutosave: false,
        name: trimmedName,
        sourceFilename: primaryFilename || rawPrimaryLayout.sourceFormat,
        sourceFormat: rawPrimaryLayout.sourceFormat,
        originalBackupTimestamp: primaryBackupTimestamp,
        createdAt: now,
        updatedAt: now,
        previewPngBytes,
        layout: rawPrimaryLayout,
        ...(rawDonorLayout
          ? {
              donorLayout: rawDonorLayout,
              donorFilename,
              donorBackupTimestamp,
            }
          : {}),
        exportPrefs: currentExportPrefs,
      };
      setHasUserLoadedPrimary(true);
      await putSavedWorkspace(record);
      await refreshSavedWorkspaces();
      setManualSaveName("");
      showToast(
        trimmedName ? `Saved snapshot "${trimmedName}".` : "Saved workspace snapshot.",
        "success",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const knownPersonalPackages = useMemo(
    () => collectPersonalPackages(primaryLayout, donorLayout),
    [primaryLayout, donorLayout],
  );

  const samsungConversion = useMemo(() => {
    if (!primaryLayout) return undefined;
    return convertLayout(primaryLayout, {
      targetRows: primaryLayout.grid.rows,
      targetCols: primaryLayout.grid.cols,
      targetDockCols: primaryLayout.grid.dockCols,
      targetFolderGrid: samsungFolderGrid,
      targetFolderPreviewCols: SAMSUNG_DEFAULT_PREVIEW_COLS,
      scaleMode: "clamp",
      includeDrawerFolders,
      includeDrawerTabs,
      keepWidgets,
      knownPersonalPackages,
    });
  }, [
    primaryLayout,
    samsungFolderGrid,
    includeDrawerFolders,
    includeDrawerTabs,
    keepWidgets,
    knownPersonalPackages,
  ]);

  const novaConversion = useMemo(
    () =>
      primaryLayout
        ? convertToNovaLayout(primaryLayout, {
            novaFolderStyle,
            novaFolderRows,
            novaFolderCols,
            folderPreviewCols: novaPreviewCols,
            novaFolderConfigModified,
            novaFolderPreviewModified,
          })
        : undefined,
    [
      primaryLayout,
      novaFolderStyle,
      novaFolderRows,
      novaFolderCols,
      novaPreviewCols,
      novaFolderConfigModified,
      novaFolderPreviewModified,
    ],
  );

  const showSamsungMigrationNotes =
    primaryLayout?.sourceFormat !== "samsung" &&
    Boolean(samsungConversion && samsungConversion.warnings.length > 0);
  const showNovaMigrationNotes =
    primaryLayout?.sourceFormat !== "nova" &&
    Boolean(novaConversion && novaConversion.warnings.length > 0);

  const exportHomeUpBundle = async (): Promise<void> => {
    if (!samsungConversion) return;
    try {
      const stamp = String(Date.now());
      const xml = serializeSamsungXml(samsungConversion.layout, {
        includeAppOrder: includeDrawerFolders,
      });
      const png = await renderSamsungPreviewPng(samsungConversion.layout);
      const zip = new JSZip();
      zip.file(`.AutoBackup/${stamp}.exml`, xml);
      zip.file(`.AutoBackupPreview/${stamp}.png`, png);
      const blob = await zip.generateAsync({ type: "blob" });
      const filename = `homeup-backup-${stamp}.zip`;
      const savedDevPath = await saveOrDownloadBlob(blob, filename, saveToDevServer);
      setExportModalInfo({
        target: "samsung",
        filename,
        stamp,
        savedDevPath,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const exportNovaArchive = async (): Promise<void> => {
    if (!novaConversion) return;
    try {
      const hydratedLayout = await hydrateExternalIconBytesForExport(novaConversion.layout);
      const zipBytes = await serializeNovaBackup(hydratedLayout);
      const base = primaryFilename
        ? primaryFilename.replace(/\.(novabackup|exml|xml|zip)$/i, "")
        : "nova-layout";
      const filename = `${base}.novabackup`;
      const savedDevPath = await saveOrDownloadBlob(
        new Blob([zipBytes as unknown as BlobPart], {
          type: "application/vnd.novalauncher.backup",
        }),
        filename,
        saveToDevServer,
      );
      setExportModalInfo({
        target: "nova",
        filename,
        savedDevPath,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const clearDragState = (): void => {
    setDragSession(null);
    setHoverTarget(null);
  };

  const markUserEditedPrimary = (updater: (prev: LauncherLayout) => LauncherLayout): void => {
    setRawPrimaryLayout((prev) => {
      if (!prev) return prev;
      const next = updater(prev);
      if (next !== prev) {
        setHasUserLoadedPrimary(true);
        setIsDirty(true);
      }
      return next;
    });
  };

  const handleBeginDrag = (
    origin: "primary" | "donor",
    item: LayoutItem,
    clientX: number,
    clientY: number,
    shiftKey: boolean,
    folderModal?: FolderModalDragContext,
  ): void => {
    setDragSession({ origin, item, clientX, clientY, shiftKey, folderModal });
    setHoverTarget(null);
  };

  const handleCommitDrag = (
    finalSession: PointerDragSession,
    finalHover: HoverTargetState | null,
  ): void => {
    clearDragState();
    if (!primaryLayout || !rawPrimaryLayout) return;

    if (finalHover && !finalHover.allowed) {
      showToast(finalHover.rejectionReason || "Cannot drop item at that position.", "warning");
      return;
    }

    const resolved = hoverToDropTarget(finalHover);
    if (!resolved) {
      return;
    }

    if (resolved === "trash") {
      if (finalSession.origin === "primary") {
        markUserEditedPrimary((prev) => deletePrimaryItem(prev, finalSession.item.id));
        if (finalSession.folderModal?.exitedBounds) {
          setOpenFolderModal(null);
        }
      }
      return;
    }

    const dragSource =
      finalSession.origin === "primary"
        ? ({ origin: "primary", itemId: finalSession.item.id } as const)
        : ({
            origin: "donor",
            item: stripPlayStoreCachedMetadata(finalSession.item, playMetadataMap),
          } as const);
    const outcome = evaluateDropOutcome(rawPrimaryLayout, dragSource, resolved);

    if (!outcome.accepted) {
      showToast(outcome.rejectionReason || "Cannot drop item at that position.", "warning");
      return;
    }

    setRawPrimaryLayout(outcome.layout);
    setHasUserLoadedPrimary(true);
    setIsDirty(true);
    if (finalSession.folderModal?.exitedBounds && resolved.kind !== "folder-interior") {
      setOpenFolderModal(null);
    }
  };

  const handleResizeGrid = (edge: GridEdge, delta: 1 | -1): void => {
    markUserEditedPrimary((prev) => resizeDesktopGrid(prev, edge, delta));
  };

  const handleResizeDock = (edge: DockEdge, delta: 1 | -1): void => {
    markUserEditedPrimary((prev) => resizeDockSlots(prev, edge, delta));
  };

  const handleAddScreen = (): void => {
    markUserEditedPrimary((prev) => addBlankScreen(prev));
  };

  const handleRemoveScreen = (screenRank: number): void => {
    markUserEditedPrimary((prev) => removeScreen(prev, screenRank));
  };

  const handleRenameFolder = (folderId: string, newTitle: string): void => {
    markUserEditedPrimary((prev) => renameFolder(prev, folderId, newTitle));
  };

  const handleUnwrapFolder = (folderId: string): void => {
    markUserEditedPrimary((prev) => unwrapSingleItemFolder(prev, folderId));
  };

  const selectLauncherTab = (tab: "samsung" | "nova"): void => {
    setPanelTab(tab);
    setLastLauncherTab(tab);
  };

  const handleToggleAutoFetchPlayIcons = (enabled: boolean): void => {
    transientFailedPlayPackagesRef.current.clear();
    setAutoFetchPlayIcons(enabled);
    writeAutoFetchPlayPreference(enabled);
    if (!enabled) {
      playFetchAbortRef.current?.abort();
      playFetchAbortRef.current = null;
      setPlayFetchProgress(null);
    }
  };

  useEffect(() => {
    if (!autoFetchPlayIcons) {
      playFetchAbortRef.current?.abort();
      playFetchAbortRef.current = null;
      setPlayFetchProgress(null);
      return;
    }
    if (playFetchAbortRef.current !== null) return;

    const packagesToFetch = unresolvedPlayPackages.filter(
      (pkg) => !transientFailedPlayPackagesRef.current.has(pkg),
    );
    if (packagesToFetch.length === 0) return;

    const controller = new AbortController();
    playFetchAbortRef.current = controller;
    setPlayFetchProgress({ done: 0, total: packagesToFetch.length });

    void (async () => {
      try {
        const summary = await fetchMissingPlayStoreMetadata(packagesToFetch, {
          signal: controller.signal,
          onProgress: (done, total, _entry, batch) => {
            if (controller.signal.aborted) return;
            setPlayFetchProgress({ done, total });
            if (batch.length > 0) {
              setPlayMetadataMap((prev) => {
                const next = new Map(prev);
                for (const item of batch) {
                  next.set(item.packageName, item);
                }
                return next;
              });
            }
          },
        });

        if (!controller.signal.aborted) {
          if (summary.entries.size > 0) {
            setPlayMetadataMap((prev) => {
              const next = new Map(prev);
              for (const [pkg, entry] of summary.entries) {
                next.set(pkg, entry);
              }
              return next;
            });
          }

          for (const pkg of packagesToFetch) {
            if (!summary.entries.has(pkg)) {
              transientFailedPlayPackagesRef.current.add(pkg);
            }
          }

          if (summary.foundCount > 0) {
            showToast(
              `Resolved ${summary.foundCount} ${summary.foundCount === 1 ? "app" : "apps"} from Google Play.`,
              "success",
            );
          } else if (summary.transientErrorCount > 0) {
            showToast(
              "Could not reach Google Play right now — toggle off and on to retry.",
              "warning",
            );
          }
        }
      } finally {
        if (playFetchAbortRef.current === controller) {
          playFetchAbortRef.current = null;
          setPlayFetchProgress(null);
          setPlayFetchRunTick((t) => t + 1);
        }
      }
    })();
  }, [autoFetchPlayIcons, unresolvedPlayPackages, playFetchRunTick]);

  return (
    <div id="page-home">
      {/* Top Toolbar: Primary, Progressive Reference, & Saved Workspaces */}
      <div className="top-control-bar">
        <p className="mb-2">
          Open, edit, and convert Nova Launcher and Samsung Home Up home screen backups locally in
          your browser.
        </p>
        <div className="file-actions-row">
          <FileForm
            id="primaryInputFile"
            label="Load Primary Backup"
            variant="primary"
            onChange={onChangePrimaryFile}
          />
          {hasUserLoadedPrimary && (
            <FileForm
              id="donorInputFile"
              label="Load Reference Backup"
              variant="secondary"
              onChange={onChangeDonorFile}
            />
          )}
          {savedWorkspaces.length > 0 && (
            <button
              type="button"
              className="btn btn-outline-info"
              onClick={() => {
                void refreshSavedWorkspaces();
                setIsLoadSaveModalOpen(true);
              }}
            >
              <i className="fas fa-history me-1" aria-hidden="true" />
              Saved Workspaces ({savedWorkspaces.length})
            </button>
          )}
          <button
            type="button"
            className="help-icon-btn"
            onClick={() => setHelpTopic("load-backups")}
            title="Where to find backup files on your phone"
            aria-label="Help: Where to find backup files"
          >
            <i className="fas fa-question" aria-hidden="true" />
          </button>
        </div>

        {import.meta.env.DEV && devFixtures.length > 0 && (
          <details className="dev-fixtures-drawer mt-3">
            <summary>Developer Test Fixtures</summary>
            <div className="dev-fixtures-controls">
              <select
                className="form-select form-select-sm me-2"
                aria-label="Dev local backup fixture"
                value={selectedDevFixture}
                onChange={(e) => setSelectedDevFixture(e.target.value)}
              >
                {devFixtures.map((fixture) => (
                  <option key={fixture.path} value={fixture.path}>
                    {fixture.path} ({(fixture.size / 1024).toFixed(0)} KB)
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-sm btn-outline-primary me-2"
                onClick={() => {
                  const chosen = devFixtures.find((f) => f.path === selectedDevFixture);
                  if (chosen) void fetchBackupIntoSlot(chosen.url, chosen.name, "primary", true);
                }}
              >
                Load as Primary
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary me-3"
                onClick={() => {
                  const chosen = devFixtures.find((f) => f.path === selectedDevFixture);
                  if (chosen) void fetchBackupIntoSlot(chosen.url, chosen.name, "donor", true);
                }}
              >
                Load as Reference
              </button>
              <label className="mb-0">
                <input
                  type="checkbox"
                  className="me-1"
                  checked={saveToDevServer}
                  onChange={(e) => setSaveToDevServer(e.target.checked)}
                />
                <small className="text-muted">Save exports to dev server</small>
              </label>
            </div>
          </details>
        )}
      </div>

      {loadState === "loading" && <div className="alert alert-primary">Opening backup file...</div>}
      {error && <div className="alert alert-danger">{error}</div>}

      {primaryLayout && (
        <>
          {/* Export & Save Panel with Brand Icons & Launcher-Specific Folder Controls */}
          <div className={`export-panel card ${showPlayResolveRow ? "mb-3" : "mb-4"}`}>
            <div className="export-tabs-header">
              <div className="btn-group flex-wrap" role="tablist" aria-label="Export or save">
                <button
                  type="button"
                  role="tab"
                  aria-selected={panelTab === "nova"}
                  className={`btn export-tab-btn ${
                    panelTab === "nova" ? "btn-primary" : "btn-outline-primary"
                  }`}
                  onClick={() => selectLauncherTab("nova")}
                >
                  <img src="/nova-icon.png" alt="" className="tab-brand-icon" />
                  Nova Launcher
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={panelTab === "samsung"}
                  className={`btn export-tab-btn ${
                    panelTab === "samsung" ? "btn-primary" : "btn-outline-primary"
                  }`}
                  onClick={() => selectLauncherTab("samsung")}
                >
                  <img src="/homeup-icon.png" alt="" className="tab-brand-icon" />
                  Samsung Home Up
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={panelTab === "save"}
                  className={`btn export-tab-btn ${
                    panelTab === "save" ? "btn-primary" : "btn-outline-primary"
                  }`}
                  onClick={() => setPanelTab("save")}
                >
                  <i className="fas fa-bookmark" aria-hidden="true" />
                  Save Snapshot
                </button>
              </div>
              <span className="export-grid-summary">
                Grid: {primaryLayout.grid.cols} × {primaryLayout.grid.rows} · Dock:{" "}
                {primaryLayout.grid.dockCols} slots · {primaryLayout.screens.length}{" "}
                {primaryLayout.screens.length === 1 ? "page" : "pages"}
              </span>
            </div>

            {panelTab === "samsung" && (
              <div className="export-tab-body">
                <div className="export-options-row">
                  <label className="export-checkbox">
                    <input
                      type="checkbox"
                      checked={keepWidgets}
                      onChange={(e) => {
                        setKeepWidgets(e.target.checked);
                        if (hasUserLoadedPrimary) setIsDirty(true);
                      }}
                    />
                    Include home screen widgets
                  </label>
                  <label className="export-checkbox">
                    <input
                      type="checkbox"
                      checked={includeDrawerFolders}
                      onChange={(e) => {
                        setIncludeDrawerFolders(e.target.checked);
                        if (hasUserLoadedPrimary) setIsDirty(true);
                      }}
                    />
                    Export app drawer folders
                  </label>
                  <label className="export-checkbox">
                    <input
                      type="checkbox"
                      checked={includeDrawerTabs}
                      disabled={!includeDrawerFolders}
                      onChange={(e) => {
                        setIncludeDrawerTabs(e.target.checked);
                        if (hasUserLoadedPrimary) setIsDirty(true);
                      }}
                    />
                    Convert app drawer tabs into folders
                  </label>
                </div>

                <div className="folder-settings-row mb-3">
                  <label className="folder-select-group">
                    <span>Open folder grid (Cols × Rows):</span>
                    <select
                      className="form-select form-select-sm"
                      aria-label="Samsung open folder grid"
                      value={samsungFolderGrid}
                      onChange={(e) => {
                        setSamsungFolderGrid(e.target.value as SamsungFolderGrid);
                        if (hasUserLoadedPrimary) setIsDirty(true);
                      }}
                    >
                      {SAMSUNG_FOLDER_GRIDS.map((g) => (
                        <option key={g} value={g}>
                          {g.replace("X", " × ")}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="export-buttons-row">
                  <button className="btn btn-primary" type="button" onClick={exportHomeUpBundle}>
                    <i className="fas fa-download me-2" aria-hidden="true" />
                    Export Home Up Bundle (.zip)
                  </button>
                  <button
                    type="button"
                    className="help-icon-btn"
                    onClick={() => setHelpTopic("homeup-restore")}
                    title="How to restore this backup in Samsung Home Up"
                    aria-label="Help: How to restore in Samsung Home Up"
                  >
                    <i className="fas fa-question" aria-hidden="true" />
                  </button>
                </div>

                {showSamsungMigrationNotes && samsungConversion && (
                  <CompatibilityNotesBox warnings={samsungConversion.warnings} />
                )}
              </div>
            )}

            {panelTab === "nova" && (
              <div className="export-tab-body">
                <div className="folder-settings-row mb-3">
                  <label className="folder-select-group">
                    <span>Open folder mode:</span>
                    <select
                      className="form-select form-select-sm"
                      aria-label="Nova open folder view mode"
                      value={novaFolderStyle}
                      onChange={(e) => {
                        setNovaFolderStyle(e.target.value as NovaFolderStyle);
                        setNovaFolderConfigModified(true);
                        if (hasUserLoadedPrimary) setIsDirty(true);
                      }}
                    >
                      <option value="WINDOW">Window (auto up to 4 × 4)</option>
                      <option value="IMMERSIVE">Immersive (custom grid)</option>
                    </select>
                  </label>

                  {novaFolderStyle === "IMMERSIVE" && (
                    <>
                      <label className="folder-select-group">
                        <span>Folder cols:</span>
                        <select
                          className="form-select form-select-sm"
                          aria-label="Nova immersive folder columns"
                          value={novaFolderCols}
                          onChange={(e) => {
                            setNovaFolderCols(Number(e.target.value));
                            setNovaFolderConfigModified(true);
                            if (hasUserLoadedPrimary) setIsDirty(true);
                          }}
                        >
                          {[2, 3, 4, 5, 6, 7].map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="folder-select-group">
                        <span>Folder rows:</span>
                        <select
                          className="form-select form-select-sm"
                          aria-label="Nova immersive folder rows"
                          value={novaFolderRows}
                          onChange={(e) => {
                            setNovaFolderRows(Number(e.target.value));
                            setNovaFolderConfigModified(true);
                            if (hasUserLoadedPrimary) setIsDirty(true);
                          }}
                        >
                          {[2, 3, 4, 5, 6, 7].map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}

                  <label className="folder-select-group">
                    <span>Folder icon preview (Cols × Rows):</span>
                    <select
                      className="form-select form-select-sm"
                      aria-label="Nova closed folder icon preview grid"
                      value={novaPreviewCols}
                      onChange={(e) => {
                        setNovaPreviewCols(Number(e.target.value) as 2 | 3);
                        setNovaFolderPreviewModified(true);
                        if (hasUserLoadedPrimary) setIsDirty(true);
                      }}
                    >
                      <option value={2}>2 × 2</option>
                      <option value={3}>3 × 3</option>
                    </select>
                  </label>
                </div>

                <div className="export-buttons-row">
                  <button className="btn btn-primary" type="button" onClick={exportNovaArchive}>
                    <i className="fas fa-download me-2" aria-hidden="true" />
                    Export Nova Backup (.novabackup)
                  </button>
                  <button
                    type="button"
                    className="help-icon-btn"
                    onClick={() => setHelpTopic("nova-restore")}
                    title="How to restore a Nova Launcher backup"
                    aria-label="Help: How to restore in Nova Launcher"
                  >
                    <i className="fas fa-question" aria-hidden="true" />
                  </button>
                </div>

                {showNovaMigrationNotes && novaConversion && (
                  <CompatibilityNotesBox warnings={novaConversion.warnings} />
                )}
              </div>
            )}

            {panelTab === "save" && (
              <div className="export-tab-body">
                <p className="mb-2 text-muted small">
                  Edits automatically save in the background to an <strong>Autosave</strong> slot in
                  your browser&rsquo;s IndexedDB. Save a named checkpoint below if you want to
                  branch or compare multiple layouts:
                </p>
                <div className="manual-save-row">
                  <input
                    type="text"
                    className="form-control"
                    placeholder="Optional snapshot name (e.g. Minimal 5x6 layout)"
                    aria-label="Snapshot name"
                    value={manualSaveName}
                    onChange={(e) => setManualSaveName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        void handleCreateManualSave();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handleCreateManualSave()}
                  >
                    <i className="fas fa-save me-1" aria-hidden="true" />
                    Save Snapshot
                  </button>
                  {savedWorkspaces.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-outline-secondary"
                      onClick={() => {
                        void refreshSavedWorkspaces();
                        setIsLoadSaveModalOpen(true);
                      }}
                    >
                      Browse Saves ({savedWorkspaces.length})
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {showPlayResolveRow && (
            <div className="play-resolve-row mb-3">
              <div className="play-resolve-pill">
                <div className="form-check form-switch mb-0">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    role="switch"
                    id="autoFetchPlayIconsSwitch"
                    checked={autoFetchPlayIcons}
                    onChange={(e) => handleToggleAutoFetchPlayIcons(e.target.checked)}
                  />
                  <label
                    className="form-check-label play-resolve-label"
                    htmlFor="autoFetchPlayIconsSwitch"
                  >
                    <i className="fab fa-google-play me-1" aria-hidden="true" />
                    Resolve unknown apps via Google Play
                    {playFetchProgress !== null ? (
                      <span className="play-resolve-progress ms-1">
                        <i className="fas fa-circle-notch fa-spin me-1" aria-hidden="true" />
                        (resolving {playFetchProgress.done}/{playFetchProgress.total}&hellip;)
                      </span>
                    ) : unresolvedPlayPackages.length > 0 ? (
                      <span className="play-resolve-missing-badge ms-1">
                        ({unresolvedPlayPackages.length} unknown)
                      </span>
                    ) : null}
                  </label>
                </div>
                <button
                  type="button"
                  className="help-icon-btn help-icon-btn-sm"
                  onClick={() => setHelpTopic("play-icons")}
                  title="How Google Play app lookup works and what is shared"
                  aria-label="Help: Resolving unknown apps via Google Play"
                >
                  <i className="fas fa-question" aria-hidden="true" />
                </button>
              </div>
            </div>
          )}

          {/* Row 1: Primary Editable Workspace */}
          <section className="workspace-section workspace-primary">
            <div className="workspace-banner">
              <div className="workspace-banner-left">
                <span className="workspace-role-pill pill-primary">
                  {hasUserLoadedPrimary ? "Primary Workspace" : "Sample Preview"}
                </span>
                <span className={`format-badge format-${primaryLayout.sourceFormat}`}>
                  {primaryLayout.sourceFormat === "nova" ? "Nova" : "Samsung"}
                </span>
                <strong className="workspace-filename">
                  {primaryFilename || primaryLayout.sourceFormat}
                </strong>
                {primaryBackupTimestamp && (
                  <span className="workspace-backup-date" title="Original backup date">
                    <i className="far fa-clock me-1" aria-hidden="true" />
                    {formatBackupDate(primaryBackupTimestamp)}
                  </span>
                )}
              </div>
              {hasUserLoadedPrimary && lastAutosavedAt && (
                <span className="autosave-status-pill" title="Stored locally in IndexedDB">
                  <i className="fas fa-check-circle text-success me-1" aria-hidden="true" />
                  Autosaved {formatRelativeTimeAgo(lastAutosavedAt)}
                </span>
              )}
            </div>

            <PagesView
              layout={primaryLayout}
              folderDisplay={primaryFolderDisplay}
              editable
              placedPrimaryKeys={placedPrimaryKeys}
              openFolderId={openFolderModal?.origin === "primary" ? openFolderModal.folderId : null}
              onOpenFolderChange={(folderId) =>
                setOpenFolderModal(folderId ? { origin: "primary", folderId } : null)
              }
              dragSession={dragSession}
              hoverTarget={hoverTarget}
              onBeginDrag={handleBeginDrag}
              onUnwrapFolder={handleUnwrapFolder}
              onResizeGrid={handleResizeGrid}
              onResizeDock={handleResizeDock}
              onAddScreen={handleAddScreen}
              onRemoveScreen={handleRemoveScreen}
              onRenameFolder={handleRenameFolder}
            />
          </section>

          {/* Row 2: Secondary Reference / Donor Workspace */}
          {donorLayout && (
            <section className="workspace-section workspace-donor mt-4">
              <div className="workspace-banner">
                <div className="workspace-banner-left">
                  <span className="workspace-role-pill pill-donor">Reference Backup</span>
                  <span className={`format-badge format-${donorLayout.sourceFormat}`}>
                    {donorLayout.sourceFormat === "nova" ? "Nova" : "Samsung"}
                  </span>
                  <strong className="workspace-filename">
                    {donorFilename || donorLayout.sourceFormat}
                  </strong>
                  {donorBackupTimestamp && (
                    <span className="workspace-backup-date" title="Original backup date">
                      <i className="far fa-clock me-1" aria-hidden="true" />
                      {formatBackupDate(donorBackupTimestamp)}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary ms-auto"
                  onClick={() => {
                    setRawDonorLayout(undefined);
                    setDonorFilename("");
                    setDonorBackupTimestamp(undefined);
                    if (openFolderModal?.origin === "donor") setOpenFolderModal(null);
                  }}
                >
                  <i className="fas fa-times me-1" aria-hidden="true" />
                  Close Reference
                </button>
              </div>

              <PagesView
                layout={donorLayout}
                folderDisplay={donorFolderDisplay}
                editable={false}
                placedPrimaryKeys={placedPrimaryKeys}
                openFolderId={openFolderModal?.origin === "donor" ? openFolderModal.folderId : null}
                onOpenFolderChange={(folderId) =>
                  setOpenFolderModal(folderId ? { origin: "donor", folderId } : null)
                }
                dragSession={dragSession}
                hoverTarget={hoverTarget}
                onBeginDrag={handleBeginDrag}
              />
            </section>
          )}
        </>
      )}

      {dragSession && (
        <PointerDragLayer
          session={dragSession}
          hoverTarget={hoverTarget}
          primaryLayout={primaryLayout}
          folderPreviewCols={primaryFolderDisplay.previewGridCols}
          onUpdate={(next, hover) => {
            setDragSession(next);
            setHoverTarget(hover);
          }}
          onCommit={handleCommitDrag}
          onCancel={clearDragState}
        />
      )}

      {helpTopic && <HelpModal topic={helpTopic} onClose={() => setHelpTopic(null)} />}
      {exportModalInfo && (
        <HelpModal exportInfo={exportModalInfo} onClose={() => setExportModalInfo(null)} />
      )}

      {isLoadSaveModalOpen && (
        <LoadSaveModal
          saves={savedWorkspaces}
          onLoadSave={(record) => {
            restoreSavedRecord(record);
            setIsLoadSaveModalOpen(false);
          }}
          onDeleteSave={(id) => {
            void (async () => {
              await deleteSavedWorkspace(id);
              await refreshSavedWorkspaces();
            })();
          }}
          onClose={() => setIsLoadSaveModalOpen(false)}
        />
      )}

      {toast && (
        <div
          key={toast.id}
          role="status"
          aria-live="polite"
          className={`editor-bottom-toast toast-${toast.tone}`}
        >
          <i
            className={`fas ${
              toast.tone === "success" ? "fa-check-circle" : "fa-exclamation-circle"
            } me-2`}
            aria-hidden="true"
          />
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
};

export default App;
