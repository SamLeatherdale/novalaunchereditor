import type {
  ConversionWarning,
  ConvertLayoutOptions,
  ConvertLayoutResult,
  DrawerGroupModel,
  LauncherLayout,
  LayoutItem,
  ScreenModel,
} from "../model/types";

function cloneItem(item: LayoutItem): LayoutItem {
  if (item.kind === "folder") {
    return {
      ...item,
      placement: { ...item.placement },
      children: item.children.map(cloneItem),
    };
  }
  if (item.kind === "widget" && item.stackedWidgets) {
    return {
      ...item,
      placement: { ...item.placement },
      stackedWidgets: item.stackedWidgets.map((child) => cloneItem(child) as typeof child),
    };
  }
  return { ...item, placement: { ...item.placement } };
}

function occupies(
  occupied: Set<string>,
  x: number,
  y: number,
  spanX: number,
  spanY: number,
): boolean {
  for (let row = y; row < y + spanY; row += 1) {
    for (let column = x; column < x + spanX; column += 1) {
      if (occupied.has(`${column}:${row}`)) return true;
    }
  }
  return false;
}

function markOccupied(
  occupied: Set<string>,
  x: number,
  y: number,
  spanX: number,
  spanY: number,
): void {
  for (let row = y; row < y + spanY; row += 1) {
    for (let column = x; column < x + spanX; column += 1) {
      occupied.add(`${column}:${row}`);
    }
  }
}

function findFreeCell(
  occupied: Set<string>,
  preferredX: number,
  preferredY: number,
  cols: number,
  rows: number,
  spanX: number,
  spanY: number,
): { x: number; y: number } | undefined {
  for (let distance = 0; distance <= cols + rows; distance += 1) {
    for (let y = 0; y <= rows - spanY; y += 1) {
      for (let x = 0; x <= cols - spanX; x += 1) {
        if (
          Math.abs(x - preferredX) + Math.abs(y - preferredY) !== distance ||
          occupies(occupied, x, y, spanX, spanY)
        ) {
          continue;
        }
        return { x, y };
      }
    }
  }
  return undefined;
}

function isFractional(value: number): boolean {
  return Math.abs(value - Math.round(value)) > 1e-6;
}

function uniqueClampedInts(values: number[], min: number, max: number): number[] {
  const result: number[] = [];
  for (const v of values) {
    const clamped = Math.max(min, Math.min(max, v));
    if (!result.includes(clamped)) result.push(clamped);
  }
  return result;
}

/**
 * Find the best non-overlapping integer `(x, y, spanX, spanY)` placement for a widget,
 * trying exact/ceil/floor candidates on fractional Nova `.5` subgrid edges first so
 * side-by-side subgrid widgets (e.g. `2.5 + 2.5 = 5`) tile cleanly into `3 + 2 = 5`.
 */
function findWidgetPlacement(
  occupied: Set<string>,
  rawX: number,
  rawY: number,
  rawSpanX: number,
  rawSpanY: number,
  targetCols: number,
  targetRows: number,
): { x: number; y: number; spanX: number; spanY: number } | undefined {
  const spanXCandidates = uniqueClampedInts(
    isFractional(rawSpanX)
      ? [Math.round(rawSpanX), Math.floor(rawSpanX), Math.ceil(rawSpanX)]
      : [Math.round(rawSpanX), Math.max(1, Math.round(rawSpanX) - 1)],
    1,
    targetCols,
  );
  const spanYCandidates = uniqueClampedInts(
    isFractional(rawSpanY)
      ? [Math.round(rawSpanY), Math.floor(rawSpanY), Math.ceil(rawSpanY)]
      : [Math.round(rawSpanY), Math.max(1, Math.round(rawSpanY) - 1)],
    1,
    targetRows,
  );

  for (const spanX of spanXCandidates) {
    for (const spanY of spanYCandidates) {
      const xCandidates = uniqueClampedInts(
        isFractional(rawX)
          ? [Math.ceil(rawX), Math.floor(rawX), Math.round(rawX)]
          : [Math.round(rawX)],
        0,
        targetCols - spanX,
      );
      const yCandidates = uniqueClampedInts(
        isFractional(rawY)
          ? [Math.ceil(rawY), Math.floor(rawY), Math.round(rawY)]
          : [Math.round(rawY)],
        0,
        targetRows - spanY,
      );
      for (const x of xCandidates) {
        for (const y of yCandidates) {
          if (!occupies(occupied, x, y, spanX, spanY)) {
            return { x, y, spanX, spanY };
          }
        }
      }
    }
  }

  for (const spanX of spanXCandidates) {
    for (const spanY of spanYCandidates) {
      const prefX = Math.max(0, Math.min(targetCols - spanX, Math.round(rawX)));
      const prefY = Math.max(0, Math.min(targetRows - spanY, Math.round(rawY)));
      const cell = findFreeCell(occupied, prefX, prefY, targetCols, targetRows, spanX, spanY);
      if (cell) return { x: cell.x, y: cell.y, spanX, spanY };
    }
  }
  return undefined;
}

function displayLabel(item: LayoutItem): string {
  return item.title || item.packageName || "Unnamed";
}

export function conciseItemDetail(
  name: string | undefined,
  fallbackLocation: string,
  isFolder = false,
): string {
  const trimmed = name?.trim();
  if (trimmed && trimmed !== "Unnamed") {
    return trimmed;
  }
  return isFolder ? `Unnamed folder (${fallbackLocation})` : `Unnamed (${fallbackLocation})`;
}

function itemWarningDetail(item: LayoutItem, fallbackLocation: string): string {
  if (item.kind === "folder") {
    return conciseItemDetail(item.title, fallbackLocation, true);
  }
  if (item.kind === "launcherAction") {
    return conciseItemDetail(item.action || item.title, fallbackLocation, false);
  }
  return conciseItemDetail(item.title || item.packageName, fallbackLocation, false);
}

/**
 * Collect all Personal-profile (`!isWorkProfile`) package names discovered across
 * home screens, hotseat, dock pages, app-drawer groups/items, and `appCatalog`.
 */
export function collectPersonalPackages(...layouts: (LauncherLayout | undefined)[]): Set<string> {
  const packages = new Set<string>();
  const visitItem = (item: LayoutItem): void => {
    if (item.kind === "folder") {
      item.children.forEach(visitItem);
      return;
    }
    if (item.kind === "widget" || item.kind === "launcherAction") return;
    if (!item.isWorkProfile && item.packageName) {
      packages.add(item.packageName);
    }
  };

  for (const layout of layouts) {
    if (!layout) continue;
    layout.screens.forEach((s) => s.items.forEach(visitItem));
    layout.hotseat.forEach(visitItem);
    layout.dockPages?.forEach((dp) => dp.items.forEach(visitItem));
    layout.drawerGroups?.forEach((g) => g.items.forEach(visitItem));
    layout.drawerItems?.forEach(visitItem);
    layout.appCatalog?.forEach((app) => {
      if (!app.isWorkProfile && app.packageName) {
        packages.add(app.packageName);
      }
    });
  }
  return packages;
}

function recordWorkProfileWarning(
  item: LayoutItem,
  personalPackages: Set<string>,
  warnings: ConversionWarning[],
  locationLabel: string,
  screenRank?: number,
): void {
  const label = displayLabel(item);
  const detail = itemWarningDetail(item, locationLabel);
  if (item.packageName && personalPackages.has(item.packageName)) {
    warnings.push({
      code: "work-profile-downgraded",
      detail,
      message: `"${label}" (${locationLabel}) will restore as its Personal Profile shortcut (One UI Home backups do not store Work Profile IDs).`,
      itemId: item.id,
      ...(typeof screenRank === "number" ? { screenRank } : {}),
    });
  } else {
    warnings.push({
      code: "work-only-skipped",
      detail,
      message: `"${label}" (${locationLabel}) is a Work-only app not found in Personal Profile and will be dropped on restore unless installed in Personal.`,
      itemId: item.id,
      ...(typeof screenRank === "number" ? { screenRank } : {}),
    });
  }
}

function recordNovaFeatureDrops(
  item: LayoutItem,
  warnings: ConversionWarning[],
  locationLabel: string,
  screenRank: number,
): void {
  if (item.novaMetadata?.flingUpIntent || item.novaMetadata?.flingDownIntent) {
    const label = displayLabel(item);
    warnings.push({
      code: "nova-gesture-dropped",
      detail: itemWarningDetail(item, locationLabel),
      message: `Dropped Nova icon swipe gesture on "${label}" (${locationLabel}).`,
      itemId: item.id,
      screenRank,
    });
  }
}

function convertDesktopItem(
  item: LayoutItem,
  sourceFormat: LauncherLayout["sourceFormat"],
  sourceCols: number,
  sourceRows: number,
  targetCols: number,
  targetRows: number,
  scaleMode: "proportional" | "clamp",
  keepWidgets: boolean,
  occupied: Set<string>,
  personalPackages: Set<string>,
  warnings: ConversionWarning[],
  screenRank: number,
): LayoutItem | undefined {
  const pageLabel = `Page ${screenRank + 1}`;

  if (item.kind === "widget" && !keepWidgets) {
    const label = displayLabel(item);
    warnings.push({
      code: "widget-skipped",
      detail: itemWarningDetail(item, pageLabel),
      message: `Skipped widget "${label}" on ${pageLabel}.`,
      itemId: item.id,
      screenRank,
    });
    return undefined;
  }
  if (item.kind === "launcherAction") {
    const actionLabel = item.action || item.id;
    warnings.push({
      code: "unsupported-action",
      detail: itemWarningDetail(item, pageLabel),
      message: `Skipped Nova launcher action "${actionLabel}" on ${pageLabel}.`,
      itemId: item.id,
      screenRank,
    });
    return undefined;
  }
  if (item.isWorkProfile) {
    recordWorkProfileWarning(item, personalPackages, warnings, pageLabel, screenRank);
  }

  recordNovaFeatureDrops(item, warnings, pageLabel, screenRank);

  const source = item.placement;
  const hadSubgrid =
    isFractional(source.cellX) ||
    isFractional(source.cellY) ||
    isFractional(source.spanX) ||
    isFractional(source.spanY);

  const scaledRawX =
    scaleMode === "proportional" && sourceCols !== targetCols
      ? (source.cellX * targetCols) / Math.max(1, sourceCols)
      : source.cellX;
  const scaledRawY =
    scaleMode === "proportional" && sourceRows !== targetRows
      ? (source.cellY * targetRows) / Math.max(1, sourceRows)
      : source.cellY;
  const scaledRawSpanX =
    item.kind === "widget"
      ? scaleMode === "proportional" && sourceCols !== targetCols
        ? (source.spanX * targetCols) / Math.max(1, sourceCols)
        : source.spanX
      : 1;
  const scaledRawSpanY =
    item.kind === "widget"
      ? scaleMode === "proportional" && sourceRows !== targetRows
        ? (source.spanY * targetRows) / Math.max(1, sourceRows)
        : source.spanY
      : 1;

  let finalX: number;
  let finalY: number;
  let spanX: number;
  let spanY: number;

  if (item.kind === "widget") {
    const fitted = findWidgetPlacement(
      occupied,
      scaledRawX,
      scaledRawY,
      scaledRawSpanX,
      scaledRawSpanY,
      targetCols,
      targetRows,
    );
    if (fitted) {
      finalX = fitted.x;
      finalY = fitted.y;
      spanX = fitted.spanX;
      spanY = fitted.spanY;
    } else {
      spanX = Math.min(targetCols, Math.max(1, Math.round(scaledRawSpanX)));
      spanY = Math.min(targetRows, Math.max(1, Math.round(scaledRawSpanY)));
      finalX = Math.max(0, Math.min(targetCols - spanX, Math.round(scaledRawX)));
      finalY = Math.max(0, Math.min(targetRows - spanY, Math.round(scaledRawY)));
      const label = displayLabel(item);
      warnings.push({
        code: "collision",
        detail: itemWarningDetail(item, pageLabel),
        message: `No free region on ${pageLabel} for widget "${label}"; retained (${finalX}, ${finalY}) [${spanX}×${spanY}].`,
        itemId: item.id,
        screenRank,
        cellX: finalX,
        cellY: finalY,
      });
    }
  } else {
    spanX = 1;
    spanY = 1;
    const preferredX = Math.max(0, Math.min(targetCols - 1, Math.round(scaledRawX)));
    const preferredY = Math.max(0, Math.min(targetRows - 1, Math.round(scaledRawY)));
    const position = findFreeCell(occupied, preferredX, preferredY, targetCols, targetRows, 1, 1);
    const resolved = position ?? { x: preferredX, y: preferredY };
    finalX = resolved.x;
    finalY = resolved.y;

    const label = displayLabel(item);
    if (!position && occupies(occupied, preferredX, preferredY, 1, 1)) {
      warnings.push({
        code: "collision",
        detail: itemWarningDetail(item, pageLabel),
        message: `No free cell on ${pageLabel} for "${label}"; retained (${preferredX}, ${preferredY}).`,
        itemId: item.id,
        screenRank,
        cellX: preferredX,
        cellY: preferredY,
      });
    } else if (finalX !== preferredX || finalY !== preferredY) {
      warnings.push({
        code: "collision",
        detail: itemWarningDetail(item, pageLabel),
        message: `Nudged "${label}" on ${pageLabel} from (${preferredX}, ${preferredY}) to (${finalX}, ${finalY}) to avoid collision.`,
        itemId: item.id,
        screenRank,
        cellX: finalX,
        cellY: finalY,
      });
    }
  }

  if (hadSubgrid) {
    const label = displayLabel(item);
    warnings.push({
      code: "subgrid-snapped",
      detail: itemWarningDetail(item, pageLabel),
      message: `Snapped subgrid item "${label}" from (${source.cellX}, ${source.cellY}) [${source.spanX}×${source.spanY}] to (${finalX}, ${finalY}) [${spanX}×${spanY}].`,
      itemId: item.id,
      screenRank,
      cellX: finalX,
      cellY: finalY,
    });
  }

  markOccupied(occupied, finalX, finalY, spanX, spanY);

  const converted = cloneItem(item);
  converted.placement = {
    ...converted.placement,
    container: "desktop",
    screenRank,
    cellX: finalX,
    cellY: finalY,
    spanX,
    spanY,
  };

  if (converted.kind === "widget" && sourceFormat !== "samsung") {
    converted.appWidgetId = -1;
  }

  if (converted.kind === "folder") {
    converted.children = convertFolderChildren(
      converted.children,
      personalPackages,
      warnings,
      screenRank,
      converted.title
        ? `folder "${converted.title}" - ${pageLabel}`
        : `unnamed folder - ${pageLabel}`,
    );
  }
  return converted;
}

function convertFolderChildren(
  children: LayoutItem[],
  personalPackages: Set<string>,
  warnings: ConversionWarning[],
  screenRank: number,
  folderLabel = "folder",
): LayoutItem[] {
  const result: LayoutItem[] = [];
  for (const child of children) {
    if (child.kind === "widget") {
      const label = displayLabel(child);
      warnings.push({
        code: "widget-skipped",
        detail: itemWarningDetail(child, folderLabel),
        message: `Skipped widget "${label}" inside ${folderLabel}.`,
        itemId: child.id,
        screenRank,
      });
      continue;
    }
    if (child.kind === "launcherAction") {
      const actionLabel = child.action || child.id;
      warnings.push({
        code: "unsupported-action",
        detail: itemWarningDetail(child, folderLabel),
        message: `Skipped Nova action "${actionLabel}" inside ${folderLabel}.`,
        itemId: child.id,
        screenRank,
      });
      continue;
    }
    if (child.isWorkProfile) {
      recordWorkProfileWarning(child, personalPackages, warnings, folderLabel, screenRank);
    }
    recordNovaFeatureDrops(child, warnings, folderLabel, screenRank);
    const cloned = cloneItem(child);
    const index = result.length;
    cloned.placement = {
      ...cloned.placement,
      container: "folder",
      screenRank: index,
      rank: index,
      cellX: 0,
      cellY: 0,
      spanX: 1,
      spanY: 1,
    };
    result.push(cloned);
  }
  return result;
}

export function convertLayout(
  source: LauncherLayout,
  options: ConvertLayoutOptions,
): ConvertLayoutResult {
  const warnings: ConversionWarning[] = [];
  const scaleMode = options.scaleMode ?? "proportional";
  const keepWidgets = options.keepWidgets ?? true;
  const personalPackages = collectPersonalPackages(source);
  if (options.knownPersonalPackages) {
    for (const pkg of options.knownPersonalPackages) {
      if (pkg) personalPackages.add(pkg);
    }
  }

  const sortedSourceScreens = [...source.screens].sort((a, b) => a.rank - b.rank);
  const screens: ScreenModel[] = sortedSourceScreens.map((screen, denseRank) => {
    const occupied = new Set<string>();
    const nonWidgets = screen.items.filter((item) => item.kind !== "widget");
    const widgets = screen.items.filter((item) => item.kind === "widget");
    const ordered = [...nonWidgets, ...widgets];

    const items = ordered
      .map((item) =>
        convertDesktopItem(
          item,
          source.sourceFormat,
          source.grid.cols,
          source.grid.rows,
          options.targetCols,
          options.targetRows,
          scaleMode,
          keepWidgets,
          occupied,
          personalPackages,
          warnings,
          denseRank,
        ),
      )
      .filter((item): item is LayoutItem => Boolean(item));
    return {
      id: denseRank,
      rank: denseRank,
      items,
    };
  });

  if (source.dockPages && source.dockPages.length > 1) {
    for (const dockPage of source.dockPages) {
      if (dockPage.page === 0) continue;
      for (const extraItem of dockPage.items) {
        const dockPageLabel = `Dock page ${dockPage.page + 1}${dockPage.active ? "" : ", inactive"}`;
        if (extraItem.kind === "launcherAction") {
          warnings.push({
            code: "extra-dock-page-dropped",
            detail: itemWarningDetail(extraItem, dockPageLabel),
            message: `Dropped Nova dock page ${dockPage.page + 1} launcher action "${extraItem.action}".`,
            itemId: extraItem.id,
          });
        } else {
          const label = displayLabel(extraItem);
          warnings.push({
            code: "extra-dock-page-dropped",
            detail: itemWarningDetail(extraItem, dockPageLabel),
            message: `Dropped "${label}" from Nova dock page ${dockPage.page + 1}; One UI Home only supports a single dock page.`,
            itemId: extraItem.id,
          });
        }
      }
    }
  }

  const hotseat: LayoutItem[] = [];
  const occupiedDockSlots = new Set<number>();
  for (const item of source.hotseat) {
    if (item.kind === "widget") {
      const label = displayLabel(item);
      warnings.push({
        code: "widget-skipped",
        detail: itemWarningDetail(item, "Dock"),
        message: `Skipped dock widget "${label}".`,
        itemId: item.id,
      });
      continue;
    }
    if (item.kind === "launcherAction") {
      warnings.push({
        code: "unsupported-action",
        detail: itemWarningDetail(item, "Dock"),
        message: `Skipped Nova dock launcher action "${item.action || item.id}".`,
        itemId: item.id,
      });
      continue;
    }

    const rawSlot =
      scaleMode === "proportional" && source.grid.dockCols !== options.targetDockCols
        ? Math.round(
            (item.placement.cellX * options.targetDockCols) / Math.max(1, source.grid.dockCols),
          )
        : Math.round(item.placement.cellX);
    let slot = Math.max(0, Math.min(options.targetDockCols - 1, rawSlot));
    if (occupiedDockSlots.has(slot)) {
      let freeSlot: number | undefined;
      for (let candidate = 0; candidate < options.targetDockCols; candidate += 1) {
        if (!occupiedDockSlots.has(candidate)) {
          freeSlot = candidate;
          break;
        }
      }
      if (typeof freeSlot === "undefined") {
        const label = displayLabel(item);
        warnings.push({
          code: "out-of-bounds",
          detail: itemWarningDetail(item, "Dock"),
          message: `Skipped dock item "${label}" because all ${options.targetDockCols} hotseat slots are full.`,
          itemId: item.id,
        });
        continue;
      }
      const label = displayLabel(item);
      warnings.push({
        code: "collision",
        detail: itemWarningDetail(item, `dock slot ${slot + 1}`),
        message: `Moved dock item "${label}" from slot ${slot + 1} to slot ${freeSlot + 1}.`,
        itemId: item.id,
        cellX: freeSlot,
      });
      slot = freeSlot;
    }
    occupiedDockSlots.add(slot);

    const slotLabel = `dock slot ${slot + 1}`;
    if (item.isWorkProfile) {
      recordWorkProfileWarning(item, personalPackages, warnings, slotLabel);
    }
    recordNovaFeatureDrops(item, warnings, slotLabel, 0);

    const converted = cloneItem(item);
    converted.placement = {
      ...converted.placement,
      container: "hotseat",
      screenRank: slot,
      rank: slot,
      cellX: slot,
      cellY: 0,
      spanX: 1,
      spanY: 1,
    };
    if (converted.kind === "folder") {
      converted.children = convertFolderChildren(
        converted.children,
        personalPackages,
        warnings,
        0,
        converted.title
          ? `dock folder "${converted.title}" - ${slotLabel}`
          : `unnamed dock folder - ${slotLabel}`,
      );
    }
    hotseat.push(converted);
  }
  hotseat.sort((a, b) => a.placement.screenRank - b.placement.screenRank);

  let drawerGroups: DrawerGroupModel[] | undefined;
  const includeDrawerFolders = !options.homeOnlyMode && (options.includeDrawerFolders ?? true);
  const includeDrawerTabs = options.includeDrawerTabs ?? true;
  if (includeDrawerFolders && source.drawerGroups) {
    const seenDrawerApps = new Set<string>();
    const mergedByTitle = new Map<string, DrawerGroupModel>();
    const allowedGroupTypes = new Set(["FOLDER_APP_GROUP"]);
    if (includeDrawerTabs) allowedGroupTypes.add("TAB_APP_GROUP");

    const prioritizedGroups = [
      ...source.drawerGroups.filter((g) => g.groupType === "FOLDER_APP_GROUP"),
      ...source.drawerGroups.filter((g) => g.groupType === "TAB_APP_GROUP"),
    ];

    for (const group of prioritizedGroups) {
      if (!allowedGroupTypes.has(group.groupType)) continue;
      // Do not duplicate work-profile warnings for drawer groups already reported on desktop/dock
      const dummyWarnings: ConversionWarning[] = [];
      const convertedChildren = convertFolderChildren(
        group.items,
        personalPackages,
        dummyWarnings,
        0,
        `Drawer folder "${group.title}"`,
      ).filter((child) => {
        if (!child.packageName || !child.activityName) return false;
        const key = `${child.packageName}/${child.activityName}`;
        if (seenDrawerApps.has(key)) return false;
        seenDrawerApps.add(key);
        return true;
      });
      if (convertedChildren.length === 0) continue;
      const existing = mergedByTitle.get(group.title);
      if (existing) {
        existing.items.push(...convertedChildren);
        existing.items.forEach((it, idx) => {
          it.placement.screenRank = idx;
          it.placement.rank = idx;
        });
      } else {
        mergedByTitle.set(group.title, {
          ...group,
          groupType: "FOLDER_APP_GROUP",
          items: convertedChildren,
        });
      }
    }
    if (mergedByTitle.size > 0) {
      drawerGroups = [...mergedByTitle.values()];
    }
  }

  const defaultScreenRank = Math.max(
    0,
    Math.min(Math.max(0, screens.length - 1), source.grid.defaultScreenRank),
  );

  const layout: LauncherLayout = {
    sourceFormat: "samsung",
    grid: {
      rows: options.targetRows,
      cols: options.targetCols,
      dockCols: options.targetDockCols,
      defaultScreenRank,
      drawerRows: source.grid.drawerRows ?? options.targetRows,
      drawerCols: source.grid.drawerCols ?? options.targetCols,
      folderGrid: options.targetFolderGrid ?? source.grid.folderGrid ?? "3X4",
      folderPreviewCols: options.targetFolderPreviewCols ?? source.grid.folderPreviewCols ?? 3,
    },
    screens,
    hotseat,
    ...(drawerGroups ? { drawerGroups } : {}),
    ...(source.sourceFormat === "samsung" && source.drawerItems
      ? { drawerItems: source.drawerItems }
      : {}),
    ...(source.appCatalog ? { appCatalog: source.appCatalog } : {}),
    rawPrefs: {
      ...source.rawPrefs,
      ...(options.homeOnlyMode ? { homeOnlyMode: true } : {}),
    },
    warnings: [...source.warnings, ...warnings.map((warning) => warning.message)],
  };

  return { layout, warnings };
}

/**
 * Prepare a `LauncherLayout` for Nova Launcher export, reporting compatibility notes
 * when migrating from Samsung One UI Home (such as stacked widgets that Nova 8.x does
 * not support as swipeable carousels, and device-bound widget IDs).
 */
export interface ConvertToNovaOptions {
  novaFolderStyle?: "WINDOW" | "IMMERSIVE";
  novaFolderRows?: number;
  novaFolderCols?: number;
  folderPreviewCols?: 2 | 3;
  novaFolderConfigModified?: boolean;
  novaFolderPreviewModified?: boolean;
}

export function convertToNovaLayout(
  source: LauncherLayout,
  options: ConvertToNovaOptions = {},
): ConvertLayoutResult {
  const warnings: ConversionWarning[] = [];

  // Same-to-same Nova export has zero cross-launcher feature loss unless foreign Samsung items were dragged in
  const screens: ScreenModel[] = source.screens.map((screen, idx) => {
    const pageLabel = `Page ${idx + 1}`;
    const flattenedItems: LayoutItem[] = [];

    for (const item of screen.items) {
      if (item.kind === "widget" && item.stackedWidgets && item.stackedWidgets.length > 0) {
        const stackMembers = item.stackedWidgets.map((w) => displayLabel(w)).join(", ");
        const cleanStackDetail = item.stackedWidgets
          .map((w) => displayLabel(w))
          .filter((n) => n !== "Unnamed")
          .join(", ");
        warnings.push({
          code: "stacked-widget-flattened",
          detail: conciseItemDetail(cleanStackDetail, pageLabel),
          message: `Flattened Samsung widget stack on ${pageLabel} (${stackMembers}) to its primary widget because Nova Launcher does not support swipeable widget stacks.`,
          itemId: item.id,
          screenRank: idx,
        });
        const first = cloneItem(item.stackedWidgets[0]);
        if (first.kind === "widget") {
          first.appWidgetId = -1;
          first.placement = {
            ...item.placement,
            container: "desktop",
            screenRank: idx,
          };
          flattenedItems.push(first);
        }
        continue;
      }

      if (item.kind === "widget" && source.sourceFormat === "samsung") {
        warnings.push({
          code: "widget-skipped",
          detail: itemWarningDetail(item, pageLabel),
          message: `Widget "${displayLabel(item)}" on ${pageLabel} will restore as a tap-to-setup placeholder in Nova Launcher.`,
          itemId: item.id,
          screenRank: idx,
        });
        const clonedWidget = cloneItem(item);
        if (clonedWidget.kind === "widget") {
          clonedWidget.appWidgetId = -1;
        }
        flattenedItems.push(clonedWidget);
        continue;
      }

      flattenedItems.push(cloneItem(item));
    }

    return {
      ...screen,
      items: flattenedItems,
    };
  });

  const inferredFolderConfigModified =
    typeof options.novaFolderConfigModified === "boolean"
      ? options.novaFolderConfigModified
      : (source.grid.novaFolderConfigModified ??
        Boolean(
          (typeof options.novaFolderStyle !== "undefined" &&
            options.novaFolderStyle !== source.grid.novaFolderStyle) ||
          (typeof options.novaFolderRows !== "undefined" &&
            options.novaFolderRows !== source.grid.novaFolderRows) ||
          (typeof options.novaFolderCols !== "undefined" &&
            options.novaFolderCols !== source.grid.novaFolderCols),
        ));

  const inferredFolderPreviewModified =
    typeof options.novaFolderPreviewModified === "boolean"
      ? options.novaFolderPreviewModified
      : (source.grid.novaFolderPreviewModified ??
        Boolean(
          typeof options.folderPreviewCols !== "undefined" &&
          options.folderPreviewCols !== source.grid.folderPreviewCols,
        ));

  const layout: LauncherLayout = {
    ...source,
    sourceFormat: "nova",
    grid: {
      ...source.grid,
      novaFolderStyle:
        options.novaFolderStyle ??
        source.grid.novaFolderStyle ??
        (source.sourceFormat === "samsung" ? "IMMERSIVE" : "WINDOW"),
      novaFolderRows: options.novaFolderRows ?? source.grid.novaFolderRows ?? 4,
      novaFolderCols: options.novaFolderCols ?? source.grid.novaFolderCols ?? 4,
      folderPreviewCols:
        options.folderPreviewCols ?? ((source.grid.folderPreviewCols ?? 2) >= 3 ? 3 : 2),
      novaFolderConfigModified: inferredFolderConfigModified,
      novaFolderPreviewModified: inferredFolderPreviewModified,
    },
    screens,
    hotseat: source.hotseat.map(cloneItem),
    warnings: [...source.warnings, ...warnings.map((w) => w.message)],
  };

  return { layout, warnings };
}
