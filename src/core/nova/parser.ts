import JSZip from "jszip";
import XmlConverter from "xml-js";
import { inferFriendlyAppLabel, isGenericTechnicalLabel } from "../model/appLabels";
import {
  parseNovaFolderIconConfig,
  parseNovaFolderWindowConfig,
  snapToSamsungFolderGrid,
} from "../model/folderGrids";
import type {
  AppShortcutItem,
  DeepShortcutItem,
  DockPageModel,
  DrawerGroupModel,
  FolderItem,
  GridConfig,
  InstalledAppSummary,
  LauncherActionItem,
  LauncherLayout,
  LayoutItem,
  LayoutItemBase,
  NovaBackupArchive,
  NovaItemMetadata,
  ScreenModel,
  WidgetItem,
} from "../model/types";
import { openSqlite, type SqlQueryResult } from "../sql";

export interface NovaParserAdapter {
  parse(bytes: Uint8Array | ArrayBuffer): Promise<LauncherLayout>;
}

interface RawRow {
  [key: string]: unknown;
}

interface AppInfo {
  packageName: string;
  activityName: string;
  componentName: string;
  title: string;
  isWorkProfile: boolean;
  iconBytes?: Uint8Array;
  customIconSource?: string;
}

export interface ParsedIntent {
  action?: string;
  category?: string;
  component?: string;
  package?: string;
  [key: string]: string | undefined;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (value === null || typeof value === "undefined" || value === "") {
    return fallback;
  }
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asOptionalNumber(value: unknown): number | undefined {
  if (value === null || typeof value === "undefined" || value === "") {
    return undefined;
  }
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function asBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array && value.byteLength > 0) return value;
  if (value instanceof ArrayBuffer && value.byteLength > 0) {
    return new Uint8Array(value);
  }
  if (Array.isArray(value) && value.length > 0) {
    return Uint8Array.from(value as number[]);
  }
  return undefined;
}

function getCaseInsensitive(row: RawRow, column: string): unknown {
  if (column in row) return row[column];
  const lower = column.toLowerCase();
  for (const [key, val] of Object.entries(row)) {
    if (key.toLowerCase() === lower) return val;
  }
  return undefined;
}

export function normalizeActivityName(packageName: string, activityName: string): string {
  if (!activityName) return "";
  if (activityName.startsWith(".")) return `${packageName}${activityName}`;
  if (!activityName.includes(".")) return `${packageName}.${activityName}`;
  return activityName;
}

/** Parse both Android `#Intent;...;end` URIs and legacy `;`-delimited strings. */
export function parseNovaIntent(intent: string | null | undefined): ParsedIntent {
  if (!intent) return {};
  const normalized = intent.replace(/^#Intent;/, "").replace(/;end$/, "");
  const result: ParsedIntent = {};
  for (const property of normalized.split(";")) {
    if (!property) continue;
    const equals = property.indexOf("=");
    if (equals < 0) {
      result[property] = "";
      continue;
    }
    const key = property.slice(0, equals);
    const val = decodeURIComponentSafe(property.slice(equals + 1));
    result[key] = val;
  }
  return result;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function componentParts(
  component: string | undefined,
  fallbackPackage = "",
): { packageName: string; activityName: string } {
  const cleaned = component?.replace(/#-?\d+$/, "");
  const separator = cleaned?.indexOf("/") ?? -1;
  if (separator < 0) {
    return { packageName: fallbackPackage, activityName: "" };
  }
  const packageName = cleaned?.slice(0, separator) || fallbackPackage;
  const activityName = normalizeActivityName(packageName, cleaned?.slice(separator + 1) || "");
  return { packageName, activityName };
}

function tableColumns(db: { exec: (sql: string) => SqlQueryResult[] }, table: string): string[] {
  const result = db.exec(`PRAGMA table_info(${table})`)[0];
  return result ? result.values.map((row) => String(row[1])) : [];
}

function hasTable(db: { exec: (sql: string) => SqlQueryResult[] }, table: string): boolean {
  const result = db.exec(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='${table}'`)[0];
  return Boolean(result?.values.length);
}

function queryRows(db: { exec: (sql: string) => SqlQueryResult[] }, table: string): RawRow[] {
  const result = db.exec(`SELECT * FROM ${table}`)[0];
  if (!result) return [];
  return result.values.map((values) => {
    const row: RawRow = {};
    result.columns.forEach((column, index) => {
      row[column] = values[index];
    });
    return row;
  });
}

function parsePreferences(xml: string): Record<string, string | number | boolean> {
  const preferences: Record<string, string | number | boolean> = {};
  const xmlDocument = XmlConverter.xml2js(xml, {
    compact: false,
    trim: true,
  }) as XmlConverter.Element;

  const visit = (element: XmlConverter.Element): void => {
    if (element.type !== "element") return;
    const attributes = element.attributes ?? {};
    const name = attributes.name;
    if (typeof name === "string") {
      const rawValue =
        typeof attributes.value !== "undefined"
          ? attributes.value
          : (element.elements?.find((child) => child.type === "text")?.text ?? "");
      if (element.name === "boolean") {
        preferences[name] = rawValue === "true";
      } else if (element.name === "int" || element.name === "float" || element.name === "long") {
        preferences[name] = asNumber(rawValue);
      } else {
        preferences[name] = String(rawValue);
      }
    }
    element.elements?.forEach(visit);
  };

  xmlDocument.elements?.forEach(visit);
  return preferences;
}

/**
 * Parse Nova grid string such as `"6x5 subgrid"` or `"7x5"`.
 * Confirmed against Lawnchair `NovaBackupConverter.kt` and Nova 8.4.7 prefs:
 * first integer is `rows`, second integer is `cols`.
 */
function parseNovaGridString(
  value: unknown,
): { rows: number; cols: number; subgrid: boolean } | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^(\d+)x(\d+)(?:\s+(subgrid))?/i);
  if (!match) return undefined;
  return {
    rows: Number(match[1]),
    cols: Number(match[2]),
    subgrid: Boolean(match[3]),
  };
}

function getIcon(
  row: RawRow,
  app: AppInfo | undefined,
  customIcons: Map<number, Uint8Array>,
): Uint8Array | undefined {
  const direct = asBytes(row.icon);
  if (direct) return direct;

  const rowSource = asString(row.customIconSource);
  const rowMatch = rowSource.match(/\/customIcons\/(\d+)$/);
  if (rowMatch) {
    const icon = customIcons.get(Number(rowMatch[1]));
    if (icon) return icon;
  }

  if (app) {
    const appMatch = (app.customIconSource ?? "").match(/\/customIcons\/(\d+)$/);
    if (appMatch) {
      const icon = customIcons.get(Number(appMatch[1]));
      if (icon) return icon;
    }
    if (app.iconBytes) return app.iconBytes;
  }
  return undefined;
}

function buildNovaMetadata(row: RawRow): NovaItemMetadata | undefined {
  const novaFlags = asOptionalNumber(row.novaFlags);
  const flingUpIntent = asString(row.flingUpIntent) || undefined;
  const flingDownIntent = asString(row.flingDownIntent) || undefined;
  const profileId = asOptionalNumber(row.profileId);
  const customIconSource = asString(row.customIconSource) || undefined;

  if (
    typeof novaFlags === "undefined" &&
    !flingUpIntent &&
    !flingDownIntent &&
    typeof profileId === "undefined" &&
    !customIconSource
  ) {
    return undefined;
  }

  return {
    novaFlags,
    hasCustomIcon: typeof novaFlags === "number" ? (novaFlags & 1) !== 0 : undefined,
    hasCustomTitle: typeof novaFlags === "number" ? (novaFlags & 2) !== 0 : undefined,
    swipeToOpen: typeof novaFlags === "number" ? (novaFlags & 4) !== 0 : undefined,
    flingUpIntent,
    flingDownIntent,
    profileId,
    customIconSource,
  };
}

function isNovaInternalAction(
  intentUri: string,
  parsed: ParsedIntent,
  packageName: string,
): boolean {
  return (
    packageName === "com.teslacoilsw.launcher" ||
    parsed.action === "com.teslacoilsw.launcher.ACTION" ||
    Boolean(parsed["S.LAUNCHER_ACTION"]) ||
    intentUri.includes("com.teslacoilsw.launcher")
  );
}

function lookupAppInfo(
  appsByComponent: Map<string, AppInfo>,
  appsByPackage: Map<string, AppInfo>,
  rawComponent: string,
  normalizedComponent: string,
  packageName: string,
  isWorkProfile: boolean,
): AppInfo | undefined {
  const tag = isWorkProfile ? "work" : "main";
  return (
    (rawComponent ? appsByComponent.get(`${rawComponent}#${tag}`) : undefined) ??
    (normalizedComponent ? appsByComponent.get(`${normalizedComponent}#${tag}`) : undefined) ??
    appsByPackage.get(`${packageName}#${tag}`) ??
    (isWorkProfile
      ? ((rawComponent ? appsByComponent.get(`${rawComponent}#main`) : undefined) ??
        (normalizedComponent ? appsByComponent.get(`${normalizedComponent}#main`) : undefined) ??
        appsByPackage.get(`${packageName}#main`))
      : undefined)
  );
}

function createItem(
  row: RawRow,
  appsByComponent: Map<string, AppInfo>,
  appsByPackage: Map<string, AppInfo>,
  customIcons: Map<number, Uint8Array>,
): LayoutItem {
  const rawId = getCaseInsensitive(row, "_id");
  const id = asString(rawId, crypto.randomUUID());
  const intentUri = asString(row.intent);
  const intent = parseNovaIntent(intentUri);
  const provider = asString(row.appWidgetProvider);
  const rawComponent = intent.component ?? provider;
  const parts = componentParts(rawComponent, intent.package || asString(row.packageName));

  const itemType = asNumber(row.itemType, 0);
  const novaMetadata = buildNovaMetadata(row);
  const intentProfile = asOptionalNumber(intent["l.profile"] ?? intent["i.userid"]);
  const isWorkProfile =
    (typeof novaMetadata?.profileId === "number" && novaMetadata.profileId > 0) ||
    (typeof intentProfile === "number" && intentProfile > 0);

  const normalizedComponent =
    parts.packageName && parts.activityName ? `${parts.packageName}/${parts.activityName}` : "";
  const app = lookupAppInfo(
    appsByComponent,
    appsByPackage,
    rawComponent,
    normalizedComponent,
    parts.packageName,
    isWorkProfile,
  );

  const packageName = parts.packageName || app?.packageName || "";
  const activityName = normalizeActivityName(
    packageName,
    parts.activityName || app?.activityName || "",
  );

  const containerId = asNumber(row.container, -100);
  const container: LayoutItemBase["placement"]["container"] =
    containerId === -101
      ? "hotseat"
      : containerId <= -200
        ? "drawer"
        : containerId >= 0
          ? "folder"
          : "desktop";

  const screenId = asOptionalNumber(row.screen);
  const rank = asOptionalNumber(row.rank) ?? asOptionalNumber(row.hotseatRank);

  const placement: LayoutItemBase["placement"] = {
    container,
    screenId,
    screenRank: screenId ?? 0,
    ...(container === "hotseat" ? { dockPage: screenId ?? 0 } : {}),
    cellX: asNumber(row.cellX, 0),
    cellY: asNumber(row.cellY, 0),
    spanX: Math.max(0.5, asNumber(row.spanX, 1)),
    spanY: Math.max(0.5, asNumber(row.spanY, 1)),
    rank,
  };

  const base: LayoutItemBase = {
    id: `nova:${id}`,
    title:
      itemType === 2
        ? asString(row.title)
        : asString(row.title) || app?.title || inferFriendlyAppLabel(packageName, activityName),
    packageName,
    activityName,
    intentUri,
    placement,
    iconBytes: getIcon(row, app, customIcons),
    ...(isWorkProfile ? { isWorkProfile: true } : {}),
    novaMetadata,
    novaRaw: row,
  };

  if (itemType === 2) {
    return { ...base, kind: "folder", children: [] } satisfies FolderItem;
  }
  if (itemType === 4 || provider) {
    return {
      ...base,
      kind: "widget",
      provider,
      appWidgetId: asOptionalNumber(row.appWidgetId),
    } satisfies WidgetItem;
  }
  if (isNovaInternalAction(intentUri, intent, packageName)) {
    const actionName = intent["S.LAUNCHER_ACTION"] || intent.action || intentUri;
    return {
      ...base,
      kind: "launcherAction",
      action: actionName,
    } satisfies LauncherActionItem;
  }
  if (itemType === 6 || itemType === 1) {
    return {
      ...base,
      kind: "deepShortcut",
      shortcutId: intent["S.shortcut_id"],
    } satisfies DeepShortcutItem;
  }
  return { ...base, kind: "app" } satisfies AppShortcutItem;
}

function findZipEntry(
  zip: JSZip,
  preferredNames: string[],
  extension: string,
): JSZip.JSZipObject | undefined {
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  for (const preferred of preferredNames) {
    const exact = entries.find((entry) => entry.name.toLowerCase() === preferred.toLowerCase());
    if (exact) return exact;
  }
  return entries.find((entry) => entry.name.toLowerCase().endsWith(extension.toLowerCase()));
}

function sortFolderChildren(children: LayoutItem[]): LayoutItem[] {
  return [...children].sort((a, b) => {
    const rankA = a.placement.rank;
    const rankB = b.placement.rank;
    if (typeof rankA === "number" && typeof rankB === "number" && rankA !== rankB) {
      return rankA - rankB;
    }
    const posA = a.placement.cellY * 16 + a.placement.cellX;
    const posB = b.placement.cellY * 16 + b.placement.cellX;
    return posA - posB;
  });
}

export async function parseNovaBackup(bytes: Uint8Array | ArrayBuffer): Promise<LauncherLayout> {
  const zip = await JSZip.loadAsync(bytes);
  const databaseEntry = findZipEntry(zip, ["nova.db", "backup.db", "databases/nova.db"], ".db");
  if (!databaseEntry) {
    throw new Error("Nova backup does not contain a SQLite database (.db)");
  }
  const databaseBytes = await databaseEntry.async("uint8array");

  // JSZip decodes DOS zip local timestamps into UTC fields on `entry.date`
  let backupTimestamp: number | undefined;
  if (databaseEntry.date instanceof Date && !Number.isNaN(databaseEntry.date.getTime())) {
    const d = databaseEntry.date;
    const localMs = new Date(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
    ).getTime();
    if (localMs > 946684800000) {
      backupTimestamp = localMs;
    }
  }

  const prefsEntry = findZipEntry(
    zip,
    [
      "nova.xml",
      "com.teslacoilsw.launcher_preferences.xml",
      "shared_prefs/com.teslacoilsw.launcher_preferences.xml",
    ],
    ".xml",
  );
  const prefsXml = prefsEntry ? await prefsEntry.async("string") : undefined;
  const rawPrefs = prefsXml ? parsePreferences(prefsXml) : {};

  const extraEntries: Record<string, Uint8Array> = {};
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    if (entry.name === databaseEntry.name) continue;
    if (prefsEntry && entry.name === prefsEntry.name) continue;
    extraEntries[entry.name] = await entry.async("uint8array");
  }

  const novaArchive: NovaBackupArchive = {
    databaseEntryName: databaseEntry.name,
    databaseBytes,
    prefsEntryName: prefsEntry?.name,
    prefsXml,
    extraEntries,
  };

  const db = await openSqlite(databaseBytes);
  const warnings: string[] = [];

  try {
    // Legacy Nova 6.x had workspaceScreens; Nova 8.x omits it and uses sparse screen IDs.
    const workspaceScreenRanks = new Map<number, number>();
    if (hasTable(db, "workspaceScreens")) {
      const columns = tableColumns(db, "workspaceScreens");
      const idColumn = columns.find((col) => col.toLowerCase() === "_id") ?? columns[0];
      const rankColumn = columns.find((col) => /screenrank|rank/i.test(col)) ?? columns[1];
      for (const row of queryRows(db, "workspaceScreens")) {
        workspaceScreenRanks.set(asNumber(row[idColumn]), asNumber(row[rankColumn]));
      }
    }

    const customIcons = new Map<number, Uint8Array>();
    if (hasTable(db, "customIcons")) {
      for (const row of queryRows(db, "customIcons")) {
        const icon = asBytes(row.icon);
        const iconId = asOptionalNumber(getCaseInsensitive(row, "_id"));
        if (icon && typeof iconId === "number") {
          customIcons.set(iconId, icon);
        }
      }
    }

    const appsByComponent = new Map<string, AppInfo>();
    const appsByPackage = new Map<string, AppInfo>();
    if (hasTable(db, "allapps")) {
      for (const row of queryRows(db, "allapps")) {
        const rawComponent = asString(row.componentName);
        const parts = componentParts(rawComponent);
        if (!parts.packageName) continue;
        const rowProfileId = asNumber(row.profileId, -1);
        const isWorkProfile = rowProfileId > 0;
        const tag = isWorkProfile ? "work" : "main";
        const cleanComp = rawComponent.replace(/#-?\d+$/, "");
        const info: AppInfo = {
          packageName: parts.packageName,
          activityName: parts.activityName,
          componentName: cleanComp,
          title: asString(row.title),
          isWorkProfile,
          iconBytes: asBytes(row.icon),
          customIconSource: asString(row.customIconSource) || undefined,
        };
        if (cleanComp) appsByComponent.set(`${cleanComp}#${tag}`, info);
        if (parts.activityName) {
          appsByComponent.set(`${parts.packageName}/${parts.activityName}#${tag}`, info);
        }
        const pkgKey = `${parts.packageName}#${tag}`;
        if (!appsByPackage.has(pkgKey)) {
          appsByPackage.set(pkgKey, info);
        }
      }
    }

    if (!hasTable(db, "favorites")) {
      throw new Error("Nova backup database does not contain a favorites table");
    }

    const rawFavoriteRows = queryRows(db, "favorites").filter((row) => {
      // Nova 8 uses itemType = -1 with NULL container as an empty sentinel row.
      const itemType = asNumber(row.itemType, 0);
      return itemType !== -1 && row.container !== null && typeof row.container !== "undefined";
    });

    const items = rawFavoriteRows.map((row) =>
      createItem(row, appsByComponent, appsByPackage, customIcons),
    );
    const byNovaId = new Map<string, LayoutItem>();
    for (const item of items) {
      byNovaId.set(item.id, item);
    }

    const desktopScreensById = new Map<number, LayoutItem[]>();
    const dockItemsByPage = new Map<number, LayoutItem[]>();
    const drawerFavoritesByContainer = new Map<number, LayoutItem[]>();

    for (const item of items) {
      const rawContainer = asNumber(item.novaRaw?.container, -100);
      if (rawContainer >= 0) {
        const parent = byNovaId.get(`nova:${rawContainer}`);
        if (parent?.kind === "folder") {
          parent.children.push(item);
        } else {
          warnings.push(
            `Item ${item.id} (${item.title}) references missing folder ${rawContainer}; skipped.`,
          );
        }
        continue;
      }

      if (rawContainer <= -200) {
        const list = drawerFavoritesByContainer.get(rawContainer) ?? [];
        list.push(item);
        drawerFavoritesByContainer.set(rawContainer, list);
        continue;
      }

      if (rawContainer === -101) {
        const dockPage = item.placement.dockPage ?? 0;
        const pageItems = dockItemsByPage.get(dockPage) ?? [];
        pageItems.push(item);
        dockItemsByPage.set(dockPage, pageItems);
        continue;
      }

      // Desktop item (container === -100)
      const screenId = item.placement.screenId ?? 0;
      const screenItems = desktopScreensById.get(screenId) ?? [];
      screenItems.push(item);
      desktopScreensById.set(screenId, screenItems);
    }

    // Sort folder children deterministically
    for (const item of items) {
      if (item.kind === "folder") {
        item.children = sortFolderChildren(item.children);
      }
    }

    // Order desktop screens and assign dense 0-based screenRank
    const rawScreenIds = [...desktopScreensById.keys()].sort((a, b) => {
      const rankA = workspaceScreenRanks.get(a);
      const rankB = workspaceScreenRanks.get(b);
      if (typeof rankA === "number" && typeof rankB === "number") {
        return rankA - rankB;
      }
      return a - b;
    });

    const screenIdToDenseRank = new Map<number, number>();
    const screens: ScreenModel[] = rawScreenIds.map((screenId, denseRank) => {
      screenIdToDenseRank.set(screenId, denseRank);
      const screenItems = (desktopScreensById.get(screenId) ?? []).map((item) => ({
        ...item,
        placement: {
          ...item.placement,
          screenId,
          screenRank: denseRank,
        },
      }));
      return {
        id: screenId,
        rank: denseRank,
        items: screenItems,
      };
    });

    // Parse grid preferences (supporting both Nova 8 string prefs and Nova 6 int prefs)
    const parsedDesktopGrid = parseNovaGridString(rawPrefs.desktop_grid);
    const parsedDrawerGrid = parseNovaGridString(rawPrefs.drawer_grid);
    const rows = Math.max(
      1,
      asOptionalNumber(rawPrefs.desktop_grid_rows) ?? parsedDesktopGrid?.rows ?? 5,
    );
    const cols = Math.max(
      1,
      asOptionalNumber(rawPrefs.desktop_grid_cols) ?? parsedDesktopGrid?.cols ?? 5,
    );
    const dockCols = Math.max(1, asOptionalNumber(rawPrefs.dock_grid_cols) ?? 5);
    const subgrid = rawPrefs.desktop_grid_subgrid === true || Boolean(parsedDesktopGrid?.subgrid);

    const activeDockPages = Math.max(1, asOptionalNumber(rawPrefs.dock_pages_count) ?? 1);

    // `desktop_default_page` in Nova XML is already a 0-based page index (0..pageCount-1)
    const rawDefaultPage = asOptionalNumber(rawPrefs.desktop_default_page) ?? 0;
    const defaultScreenRank =
      rawDefaultPage >= 0 && rawDefaultPage < screens.length
        ? rawDefaultPage
        : (screenIdToDenseRank.get(rawDefaultPage) ?? 0);

    const folderWin = parseNovaFolderWindowConfig(rawPrefs.folder_window_config);
    const folderIcon = parseNovaFolderIconConfig(rawPrefs.folder_icon_config);
    const mappedSamsungFolderGrid = snapToSamsungFolderGrid(
      folderWin.cols,
      folderWin.rows,
    ).normalized;

    const grid: GridConfig = {
      rows,
      cols,
      dockCols,
      defaultScreenRank,
      activeDockPages,
      drawerRows: asOptionalNumber(rawPrefs.drawer_app_grid_rows) ?? parsedDrawerGrid?.rows,
      drawerCols: asOptionalNumber(rawPrefs.drawer_app_grid_cols) ?? parsedDrawerGrid?.cols,
      folderGrid: mappedSamsungFolderGrid,
      folderPreviewCols: folderIcon.previewGridCols,
      novaFolderStyle: folderWin.style,
      novaFolderRows: folderWin.rows,
      novaFolderCols: folderWin.cols,
      subgridX: subgrid,
      subgridY: subgrid,
    };

    // Build dock pages (page 0 is primary hotseat; extra pages preserved on dockPages)
    const sortedDockPageNumbers = [...dockItemsByPage.keys()].sort((a, b) => a - b);
    const dockPages: DockPageModel[] = sortedDockPageNumbers.map((page) => {
      const seenSlots = new Set<number>();
      const pageItems: LayoutItem[] = [];
      const sorted = [...(dockItemsByPage.get(page) ?? [])].sort(
        (a, b) => a.placement.cellX - b.placement.cellX,
      );
      for (const item of sorted) {
        const slot = Math.round(item.placement.cellX);
        if (seenSlots.has(slot)) {
          warnings.push(
            `Duplicate dock slot ${slot} on dock page ${page}; skipped ${item.id} (${item.title}).`,
          );
          continue;
        }
        seenSlots.add(slot);
        pageItems.push({
          ...item,
          placement: {
            ...item.placement,
            dockPage: page,
            screenRank: slot,
          },
        });
      }
      return {
        page,
        active: page < activeDockPages,
        items: pageItems,
      };
    });

    const primaryHotseat =
      dockPages.find((page) => page.page === 0)?.items ?? dockPages[0]?.items ?? [];

    // Parse app-drawer groups (`drawer_groups` + `appgroups` + `container <= -200` favorites)
    const rawAppGroupRows = hasTable(db, "appgroups") ? queryRows(db, "appgroups") : [];
    const drawerGroups: DrawerGroupModel[] = [];
    if (hasTable(db, "drawer_groups")) {
      const appGroupMembers = new Map<number, string[]>();
      for (const row of rawAppGroupRows) {
        const groupId = asNumber(row.groupId, -1);
        const component = asString(row.component);
        if (groupId < 0 || !component) continue;
        const list = appGroupMembers.get(groupId) ?? [];
        list.push(component);
        appGroupMembers.set(groupId, list);
      }

      for (const row of queryRows(db, "drawer_groups")) {
        const groupId = asNumber(getCaseInsensitive(row, "_id"), -1);
        if (groupId < 0) continue;
        const containerKey = -200 - groupId;
        const fromFavorites = drawerFavoritesByContainer.get(containerKey) ?? [];
        const memberComponents = appGroupMembers.get(groupId) ?? [];

        const groupItems: LayoutItem[] =
          fromFavorites.length > 0
            ? sortFolderChildren(fromFavorites)
            : memberComponents.map((comp, index) => {
                const profileSuffixMatch = comp.match(/#(-?\d+)$/);
                const compProfileId = profileSuffixMatch ? Number(profileSuffixMatch[1]) : -1;
                const cleanComp = comp.replace(/#-?\d+$/, "");
                const parts = componentParts(cleanComp);
                const normalizedComp =
                  parts.packageName && parts.activityName
                    ? `${parts.packageName}/${parts.activityName}`
                    : cleanComp;
                const isWork = compProfileId > 0;
                const app = lookupAppInfo(
                  appsByComponent,
                  appsByPackage,
                  cleanComp,
                  normalizedComp,
                  parts.packageName,
                  isWork,
                );
                return {
                  kind: "app",
                  id: `nova:appgroup:${groupId}:${index}`,
                  title: app?.title || inferFriendlyAppLabel(parts.packageName, parts.activityName),
                  packageName: parts.packageName,
                  activityName: parts.activityName,
                  intentUri: cleanComp,
                  placement: {
                    container: "drawer",
                    screenRank: index,
                    cellX: 0,
                    cellY: 0,
                    spanX: 1,
                    spanY: 1,
                    rank: index,
                  },
                  iconBytes: getIcon({}, app, customIcons),
                  ...(isWork ? { isWorkProfile: true } : {}),
                } satisfies AppShortcutItem;
              });

        drawerGroups.push({
          id: groupId,
          title: asString(row.title),
          groupType: asString(row.groupType),
          tabOrder: asNumber(row.tabOrder, 0),
          hideApps: asOptionalNumber(row.hideApps) === 1,
          categoryId: asString(row.category_id) || undefined,
          items: groupItems,
        });
      }
      drawerGroups.sort((a, b) => a.tabOrder - b.tabOrder || a.id - b.id);
    }

    // Build deduplicated appCatalog across favorites, drawer groups, and allapps
    const catalogMap = new Map<string, InstalledAppSummary>();
    const recordCatalogApp = (
      packageName: string,
      activityName: string,
      title: string,
      isWorkProfile?: boolean,
      iconBytes?: Uint8Array,
    ): void => {
      if (!packageName || packageName === "com.teslacoilsw.launcher") return;
      const key = `${packageName}/${activityName}#${isWorkProfile ? "work" : "main"}`;
      const existing = catalogMap.get(key);
      if (existing) {
        if (!existing.iconBytes && iconBytes) existing.iconBytes = iconBytes;
        if (
          isGenericTechnicalLabel(existing.title, packageName, activityName) &&
          !isGenericTechnicalLabel(title, packageName, activityName)
        ) {
          existing.title = title;
        }
      } else {
        catalogMap.set(key, {
          packageName,
          activityName,
          title: title || inferFriendlyAppLabel(packageName, activityName),
          ...(isWorkProfile ? { isWorkProfile: true } : {}),
          ...(iconBytes ? { iconBytes } : {}),
        });
      }
    };

    for (const item of items) {
      if (item.kind === "app") {
        recordCatalogApp(
          item.packageName,
          item.activityName,
          item.title,
          item.isWorkProfile,
          item.iconBytes,
        );
      }
    }
    for (const group of drawerGroups) {
      for (const item of group.items) {
        if (item.kind === "app") {
          recordCatalogApp(
            item.packageName,
            item.activityName,
            item.title,
            item.isWorkProfile,
            item.iconBytes,
          );
        }
      }
    }
    for (const row of rawAppGroupRows) {
      const comp = asString(row.component);
      if (!comp) continue;
      const profileSuffixMatch = comp.match(/#(-?\d+)$/);
      const compProfileId = profileSuffixMatch ? Number(profileSuffixMatch[1]) : -1;
      const cleanComp = comp.replace(/#-?\d+$/, "");
      const parts = componentParts(cleanComp);
      if (!parts.packageName) continue;
      const normalizedComp =
        parts.packageName && parts.activityName
          ? `${parts.packageName}/${parts.activityName}`
          : cleanComp;
      const isWork = compProfileId > 0;
      const app = lookupAppInfo(
        appsByComponent,
        appsByPackage,
        cleanComp,
        normalizedComp,
        parts.packageName,
        isWork,
      );
      recordCatalogApp(
        parts.packageName,
        parts.activityName,
        app?.title || inferFriendlyAppLabel(parts.packageName, parts.activityName),
        isWork,
        getIcon({}, app, customIcons),
      );
    }
    for (const app of appsByComponent.values()) {
      recordCatalogApp(
        app.packageName,
        app.activityName,
        app.title,
        app.isWorkProfile,
        getIcon({}, app, customIcons),
      );
    }

    const appCatalog = [...catalogMap.values()].sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
    );

    return {
      sourceFormat: "nova",
      grid,
      screens,
      hotseat: primaryHotseat,
      ...(dockPages.length > 0 ? { dockPages } : {}),
      ...(drawerGroups.length > 0 ? { drawerGroups } : {}),
      ...(appCatalog.length > 0 ? { appCatalog } : {}),
      ...(typeof backupTimestamp === "number" ? { backupTimestamp } : {}),
      rawPrefs,
      novaArchive,
      warnings,
    };
  } finally {
    db.close();
  }
}

export const novaParser: NovaParserAdapter = { parse: parseNovaBackup };
