export type LayoutSourceFormat = "nova" | "samsung";

export interface GridConfig {
  rows: number;
  cols: number;
  dockCols: number;
  defaultScreenRank: number;
  activeDockPages?: number;
  drawerRows?: number;
  drawerCols?: number;
  /** Samsung `<FolderGrid>` (`"3X3"`..`"7X7"`, columns × rows). */
  folderGrid?: string;
  /** Closed folder icon mini-preview grid dimension (`2`..`5` for `2×2`..`5×5`). */
  folderPreviewCols?: 2 | 3 | 4 | 5;
  /** Nova open-folder layout mode (`WINDOW` auto-sizes up to 4×4; `IMMERSIVE` uses `novaFolderCols × novaFolderRows`). */
  novaFolderStyle?: "WINDOW" | "IMMERSIVE";
  novaFolderRows?: number;
  novaFolderCols?: number;
  /** True only when the user explicitly modified Nova's open-folder mode/dimensions (`folder_window_config`). */
  novaFolderConfigModified?: boolean;
  /** True only when the user explicitly modified Nova's closed-folder preview (`folder_icon_config`). */
  novaFolderPreviewModified?: boolean;
  subgridX?: boolean;
  subgridY?: boolean;
}

export interface ItemPlacement {
  container: "desktop" | "hotseat" | "folder" | "drawer";
  /** Original database/XML screen identifier (e.g. sparse 1, 5, 8 in Nova 8). */
  screenId?: number;
  /** Dense 0-based page index on desktop, slot index on Samsung hotseat, or order index in folder/drawer. */
  screenRank: number;
  /** 0-based dock page index in Nova (where container = -101 uses screen for dock page). */
  dockPage?: number;
  /** Column coordinate; may be fractional (e.g. -0.5, 2.5) when Nova subgrid is enabled. */
  cellX: number;
  /** Row coordinate; may be fractional (e.g. 4.5) when Nova subgrid is enabled. */
  cellY: number;
  /** Horizontal span; may be fractional (e.g. 2.5) when Nova subgrid is enabled. */
  spanX: number;
  /** Vertical span; may be fractional (e.g. 3.5) when Nova subgrid is enabled. */
  spanY: number;
  /** Explicit in-container sort order (folder item index, hotseat slot, or appOrder index). */
  rank?: number;
}

export interface NovaItemMetadata {
  novaFlags?: number;
  hasCustomIcon?: boolean;
  hasCustomTitle?: boolean;
  swipeToOpen?: boolean;
  flingUpIntent?: string;
  flingDownIntent?: string;
  profileId?: number;
  customIconSource?: string;
}

export interface LayoutItemBase {
  id: string;
  title: string;
  packageName: string;
  activityName: string;
  intentUri: string;
  placement: ItemPlacement;
  iconBytes?: Uint8Array;
  iconUrl?: string;
  isWorkProfile?: boolean;
  hidden?: boolean;
  novaMetadata?: NovaItemMetadata;
  novaRaw?: Record<string, unknown>;
}

export interface AppShortcutItem extends LayoutItemBase {
  kind: "app";
}

export interface FolderItem extends LayoutItemBase {
  kind: "folder";
  children: LayoutItem[];
  options?: number;
  color?: number;
}

export interface WidgetItem extends LayoutItemBase {
  kind: "widget";
  provider: string;
  appWidgetId?: number;
  stackedWidgets?: WidgetItem[];
}

export interface DeepShortcutItem extends LayoutItemBase {
  kind: "deepShortcut";
  shortcutId?: string;
}

export interface LauncherActionItem extends LayoutItemBase {
  kind: "launcherAction";
  action: string;
}

export type LayoutItem =
  | AppShortcutItem
  | FolderItem
  | WidgetItem
  | DeepShortcutItem
  | LauncherActionItem;

export interface ScreenModel {
  id: number;
  rank: number;
  items: LayoutItem[];
}

export interface DockPageModel {
  page: number;
  active: boolean;
  items: LayoutItem[];
}

export interface DrawerGroupModel {
  id: number;
  title: string;
  groupType: string;
  tabOrder: number;
  hideApps?: boolean;
  categoryId?: string;
  items: LayoutItem[];
}

/**
 * Lossless backing snapshot of an original `.novabackup` archive so Nova-to-Nova
 * layout edits can patch `nova.db` / `nova.xml` in place without losing untouched
 * tables (`customIcons`, `drawer_groups`, `appgroups`), exact preference types,
 * or companion zip files (`supportDetails.txt`, `cards.datastore`, etc.).
 */
export interface NovaBackupArchive {
  databaseEntryName: string;
  databaseBytes: Uint8Array;
  prefsEntryName?: string;
  prefsXml?: string;
  extraEntries: Record<string, Uint8Array>;
}

export interface InstalledAppSummary {
  packageName: string;
  activityName: string;
  title: string;
  isWorkProfile?: boolean;
  iconBytes?: Uint8Array;
  iconUrl?: string;
}

export interface LauncherLayout {
  sourceFormat: LayoutSourceFormat;
  grid: GridConfig;
  screens: ScreenModel[];
  /** Primary dock items (page 0 in Nova, or `<hotseat>` in Samsung). */
  hotseat: LayoutItem[];
  /** All dock pages when source format supports multiple dock pages (Nova). */
  dockPages?: DockPageModel[];
  /** App drawer groups/folders (`drawer_groups` in Nova, `<appOrder>` folders in Samsung). */
  drawerGroups?: DrawerGroupModel[];
  /** Flat app-drawer items (`<appOrder>` top-level favorites in Samsung). */
  drawerItems?: LayoutItem[];
  /** Deduplicated catalog of all apps discovered across home, dock, and drawer tables. */
  appCatalog?: InstalledAppSummary[];
  /** Epoch milliseconds when this backup archive was created, if present in archive metadata. */
  backupTimestamp?: number;
  rawPrefs?: Record<string, string | number | boolean>;
  /** Present when loaded from `.novabackup`; enables lossless `.novabackup` write-back. */
  novaArchive?: NovaBackupArchive;
  warnings: string[];
}

export interface ConversionWarning {
  code:
    | "collision"
    | "widget-skipped"
    | "stacked-widget-flattened"
    | "unsupported-action"
    | "work-profile-downgraded"
    | "work-only-skipped"
    | "hotseat-duplicate"
    | "extra-dock-page-dropped"
    | "nova-gesture-dropped"
    | "subgrid-snapped"
    | "out-of-bounds";
  message: string;
  /** Concise item/location label used when grouping warnings by category in the UI. */
  detail?: string;
  itemId?: string;
  screenRank?: number;
  cellX?: number;
  cellY?: number;
}

export interface ConvertLayoutOptions {
  targetRows: number;
  targetCols: number;
  targetDockCols: number;
  targetFolderGrid?: string;
  targetFolderPreviewCols?: 2 | 3 | 4 | 5;
  homeOnlyMode?: boolean;
  scaleMode?: "proportional" | "clamp";
  keepWidgets?: boolean;
  includeDrawerFolders?: boolean;
  includeDrawerTabs?: boolean;
  /** Additional known Personal-profile (`!isWorkProfile`) package names across loaded backups. */
  knownPersonalPackages?: Set<string>;
}

export interface ConvertLayoutResult {
  layout: LauncherLayout;
  warnings: ConversionWarning[];
}
