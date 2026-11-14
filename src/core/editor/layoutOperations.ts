import {
  hasCuratedAppLabel,
  inferFriendlyAppLabel,
  inferHeuristicAppLabel,
  isGenericTechnicalLabel,
} from "../model/appLabels";
import type {
  FolderItem,
  InstalledAppSummary,
  LauncherLayout,
  LayoutItem,
  ScreenModel,
} from "../model/types";

export const GRID_MIN_ROWS = 4;
export const GRID_MAX_ROWS = 7;
export const GRID_MIN_COLS = 4;
export const GRID_MAX_COLS = 7;
export const DOCK_MIN_COLS = 3;
export const DOCK_MAX_COLS = 7;

export type GridEdge = "top" | "bottom" | "left" | "right";
export type DockEdge = "left" | "right";
export type PushDirection = "left" | "right" | "up" | "down";

export type DragItemSource =
  | { origin: "primary"; itemId: string }
  | { origin: "donor"; item: LayoutItem };

export type DropTarget =
  | {
      kind: "desktop-cell";
      screenRank: number;
      cellX: number;
      cellY: number;
      pushDirection?: PushDirection;
      mergeIntoFolder?: boolean;
      replaceOccupant?: boolean;
    }
  | {
      kind: "dock-slot";
      slot: number;
      pushDirection?: "left" | "right";
      mergeIntoFolder?: boolean;
      replaceOccupant?: boolean;
    }
  | {
      kind: "folder-interior";
      folderId: string;
      index?: number;
    };

export function cloneLayoutItem(item: LayoutItem, assignFreshIds = false): LayoutItem {
  const id = assignFreshIds ? `edit:${crypto.randomUUID()}` : item.id;
  if (item.kind === "folder") {
    return {
      ...item,
      id,
      placement: { ...item.placement },
      children: item.children.map((child) => cloneLayoutItem(child, assignFreshIds)),
    };
  }
  if (item.kind === "widget" && item.stackedWidgets) {
    return {
      ...item,
      id,
      placement: { ...item.placement },
      stackedWidgets: item.stackedWidgets.map(
        (child) => cloneLayoutItem(child, assignFreshIds) as typeof child,
      ),
    };
  }
  return {
    ...item,
    id,
    placement: { ...item.placement },
  };
}

function cloneLayout(layout: LauncherLayout): LauncherLayout {
  return {
    ...layout,
    grid: { ...layout.grid },
    screens: layout.screens.map((screen) => ({
      ...screen,
      items: screen.items.map((item) => cloneLayoutItem(item, false)),
    })),
    hotseat: layout.hotseat.map((item) => cloneLayoutItem(item, false)),
    ...(layout.dockPages
      ? {
          dockPages: layout.dockPages.map((dp) => ({
            ...dp,
            items: dp.items.map((item) => cloneLayoutItem(item, false)),
          })),
        }
      : {}),
  };
}

function syncHotseatToDockPages(layout: LauncherLayout): void {
  if (!layout.dockPages || layout.dockPages.length === 0) return;
  layout.dockPages = layout.dockPages.map((dp) =>
    dp.page === 0 ? { ...dp, items: layout.hotseat } : dp,
  );
}

function itemBounds(item: LayoutItem): {
  x: number;
  y: number;
  spanX: number;
  spanY: number;
} {
  return {
    x: item.placement.cellX,
    y: item.placement.cellY,
    spanX: item.kind === "widget" ? Math.max(0.5, item.placement.spanX) : 1,
    spanY: item.kind === "widget" ? Math.max(0.5, item.placement.spanY) : 1,
  };
}

function intSpan(item: LayoutItem): { spanX: number; spanY: number } {
  if (item.kind !== "widget") return { spanX: 1, spanY: 1 };
  return {
    spanX: Math.max(1, Math.round(item.placement.spanX)),
    spanY: Math.max(1, Math.round(item.placement.spanY)),
  };
}

function cellsOverlap(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): boolean {
  const eps = 1e-4;
  return ax < bx + bw - eps && ax + aw > bx + eps && ay < by + bh - eps && ay + ah > by + eps;
}

function isRegionFree(
  items: LayoutItem[],
  x: number,
  y: number,
  spanX: number,
  spanY: number,
  cols: number,
  rows: number,
  ignoreIds?: Set<string>,
): boolean {
  if (x < 0 || y < 0 || x + spanX > cols || y + spanY > rows) return false;
  for (const item of items) {
    if (ignoreIds?.has(item.id)) continue;
    const b = itemBounds(item);
    if (cellsOverlap(x, y, spanX, spanY, b.x, b.y, b.spanX, b.spanY)) return false;
  }
  return true;
}

export function findNearestFreeCell(
  items: LayoutItem[],
  preferredX: number,
  preferredY: number,
  spanX: number,
  spanY: number,
  cols: number,
  rows: number,
  ignoreIds?: Set<string>,
): { x: number; y: number } | undefined {
  for (let dist = 0; dist <= cols + rows; dist += 1) {
    for (let y = 0; y <= rows - spanY; y += 1) {
      for (let x = 0; x <= cols - spanX; x += 1) {
        if (Math.abs(x - preferredX) + Math.abs(y - preferredY) !== dist) continue;
        if (isRegionFree(items, x, y, spanX, spanY, cols, rows, ignoreIds)) {
          return { x, y };
        }
      }
    }
  }
  return undefined;
}

function repackScreenWithinBounds(screen: ScreenModel, cols: number, rows: number): ScreenModel {
  const placed: LayoutItem[] = [];
  for (const item of screen.items) {
    const b = itemBounds(item);
    const fitsExact =
      b.x >= 0 &&
      b.y >= 0 &&
      b.x + b.spanX <= cols + 1e-4 &&
      b.y + b.spanY <= rows + 1e-4 &&
      isRegionFree(placed, b.x, b.y, b.spanX, b.spanY, cols, rows);

    if (fitsExact) {
      placed.push(item);
      continue;
    }

    const rawSpan = intSpan(item);
    const spanX = Math.min(cols, rawSpan.spanX);
    const spanY = Math.min(rows, rawSpan.spanY);
    const prefX = Math.max(0, Math.min(cols - spanX, Math.round(item.placement.cellX)));
    const prefY = Math.max(0, Math.min(rows - spanY, Math.round(item.placement.cellY)));
    const free = findNearestFreeCell(placed, prefX, prefY, spanX, spanY, cols, rows) ?? {
      x: prefX,
      y: prefY,
    };
    placed.push({
      ...item,
      placement: {
        ...item.placement,
        cellX: free.x,
        cellY: free.y,
        spanX: item.kind === "widget" ? spanX : 1,
        spanY: item.kind === "widget" ? spanY : 1,
      },
    });
  }
  return { ...screen, items: placed };
}

/**
 * Expand or shrink the desktop grid from a specific edge (`top`, `bottom`, `left`, `right`),
 * keeping existing item coordinates anchored relative to the opposite edge.
 */
export function resizeDesktopGrid(
  source: LauncherLayout,
  edge: GridEdge,
  delta: 1 | -1,
  limits = {
    minRows: GRID_MIN_ROWS,
    maxRows: GRID_MAX_ROWS,
    minCols: GRID_MIN_COLS,
    maxCols: GRID_MAX_COLS,
  },
): LauncherLayout {
  const next = cloneLayout(source);
  const isVertical = edge === "top" || edge === "bottom";

  if (isVertical) {
    const targetRows = next.grid.rows + delta;
    if (targetRows < limits.minRows || targetRows > limits.maxRows) return source;
    next.grid.rows = targetRows;

    next.screens = next.screens.map((screen) => {
      const shifted: ScreenModel =
        edge === "top"
          ? {
              ...screen,
              items: screen.items.map((item) => ({
                ...item,
                placement: { ...item.placement, cellY: item.placement.cellY + delta },
              })),
            }
          : screen;
      return repackScreenWithinBounds(shifted, next.grid.cols, targetRows);
    });
  } else {
    const targetCols = next.grid.cols + delta;
    if (targetCols < limits.minCols || targetCols > limits.maxCols) return source;
    next.grid.cols = targetCols;

    next.screens = next.screens.map((screen) => {
      const shifted: ScreenModel =
        edge === "left"
          ? {
              ...screen,
              items: screen.items.map((item) => ({
                ...item,
                placement: { ...item.placement, cellX: item.placement.cellX + delta },
              })),
            }
          : screen;
      return repackScreenWithinBounds(shifted, targetCols, next.grid.rows);
    });
  }

  return next;
}

/**
 * Expand or shrink the dock slot count from `left` or `right`.
 */
export function resizeDockSlots(
  source: LauncherLayout,
  edge: DockEdge,
  delta: 1 | -1,
  limits = { minCols: DOCK_MIN_COLS, maxCols: DOCK_MAX_COLS },
): LauncherLayout {
  const targetDockCols = source.grid.dockCols + delta;
  if (targetDockCols < limits.minCols || targetDockCols > limits.maxCols) return source;
  if (delta < 0 && source.hotseat.length > targetDockCols) {
    // Cannot shrink below the number of currently occupied dock items
    return source;
  }

  const next = cloneLayout(source);
  next.grid.dockCols = targetDockCols;

  const shifted = next.hotseat.map((item) => ({
    ...item,
    placement: {
      ...item.placement,
      cellX: edge === "left" ? item.placement.cellX + delta : item.placement.cellX,
    },
  }));

  const occupied = new Set<number>();
  const placed: LayoutItem[] = [];
  for (const item of shifted) {
    let slot = Math.max(0, Math.min(targetDockCols - 1, Math.round(item.placement.cellX)));
    if (occupied.has(slot)) {
      for (let d = 1; d < targetDockCols; d += 1) {
        if (slot - d >= 0 && !occupied.has(slot - d)) {
          slot -= d;
          break;
        }
        if (slot + d < targetDockCols && !occupied.has(slot + d)) {
          slot += d;
          break;
        }
      }
    }
    occupied.add(slot);
    placed.push({
      ...item,
      placement: {
        ...item.placement,
        container: "hotseat",
        cellX: slot,
        cellY: 0,
        screenRank: slot,
        rank: slot,
      },
    });
  }

  next.hotseat = placed.sort((a, b) => a.placement.cellX - b.placement.cellX);
  syncHotseatToDockPages(next);
  return next;
}

export function addBlankScreen(source: LauncherLayout): LauncherLayout {
  const next = cloneLayout(source);
  const maxId = next.screens.reduce((m, s) => Math.max(m, s.id), -1);
  const newRank = next.screens.length;
  next.screens.push({
    id: maxId + 1,
    rank: newRank,
    items: [],
  });
  return next;
}

export function removeScreen(source: LauncherLayout, screenRank: number): LauncherLayout {
  if (source.screens.length <= 1) return source;
  const target = source.screens.find((s) => s.rank === screenRank);
  if (!target || target.items.length > 0) return source;

  const next = cloneLayout(source);
  next.screens = next.screens
    .filter((s) => s.rank !== screenRank)
    .map((s, idx) => ({
      ...s,
      rank: idx,
      items: s.items.map((item) => ({
        ...item,
        placement: { ...item.placement, screenRank: idx },
      })),
    }));
  next.grid.defaultScreenRank = Math.min(
    next.grid.defaultScreenRank,
    Math.max(0, next.screens.length - 1),
  );
  return next;
}

export function renameFolder(
  source: LauncherLayout,
  folderId: string,
  newTitle: string,
): LauncherLayout {
  const next = cloneLayout(source);
  const updateList = (items: LayoutItem[]): boolean => {
    for (const item of items) {
      if (item.id === folderId && item.kind === "folder") {
        item.title = newTitle;
        return true;
      }
    }
    return false;
  };

  for (const screen of next.screens) {
    if (updateList(screen.items)) return next;
  }
  updateList(next.hotseat);
  syncHotseatToDockPages(next);
  return next;
}

interface ExtractedItem {
  item: LayoutItem;
  originContainer: "desktop" | "hotseat" | "folder";
  originScreenRank?: number;
  originCellX?: number;
  originCellY?: number;
}

function extractPrimaryItem(layout: LauncherLayout, itemId: string): ExtractedItem | undefined {
  for (const screen of layout.screens) {
    const directIdx = screen.items.findIndex((it) => it.id === itemId);
    if (directIdx >= 0) {
      const [removed] = screen.items.splice(directIdx, 1);
      return {
        item: removed,
        originContainer: "desktop",
        originScreenRank: screen.rank,
        originCellX: Math.round(removed.placement.cellX),
        originCellY: Math.round(removed.placement.cellY),
      };
    }

    for (let fIdx = 0; fIdx < screen.items.length; fIdx += 1) {
      const folder = screen.items[fIdx];
      if (folder.kind !== "folder") continue;
      const childIdx = folder.children.findIndex((c) => c.id === itemId);
      if (childIdx >= 0) {
        const [removed] = folder.children.splice(childIdx, 1);
        folder.children.forEach((c, idx) => {
          c.placement.rank = idx;
          c.placement.screenRank = idx;
        });
        if (folder.children.length === 0) {
          screen.items.splice(fIdx, 1);
        }
        return {
          item: removed,
          originContainer: "folder",
          originScreenRank: screen.rank,
        };
      }
    }
  }

  const dockIdx = layout.hotseat.findIndex((it) => it.id === itemId);
  if (dockIdx >= 0) {
    const [removed] = layout.hotseat.splice(dockIdx, 1);
    return {
      item: removed,
      originContainer: "hotseat",
      originCellX: Math.round(removed.placement.cellX),
      originCellY: 0,
    };
  }

  for (let fIdx = 0; fIdx < layout.hotseat.length; fIdx += 1) {
    const folder = layout.hotseat[fIdx];
    if (folder.kind !== "folder") continue;
    const childIdx = folder.children.findIndex((c) => c.id === itemId);
    if (childIdx >= 0) {
      const [removed] = folder.children.splice(childIdx, 1);
      folder.children.forEach((c, idx) => {
        c.placement.rank = idx;
        c.placement.screenRank = idx;
      });
      if (folder.children.length === 0) {
        layout.hotseat.splice(fIdx, 1);
      }
      return {
        item: removed,
        originContainer: "folder",
      };
    }
  }

  return undefined;
}

function canGoInsideFolder(item: LayoutItem): boolean {
  return item.kind !== "folder" && item.kind !== "widget";
}

export function itemAppIdentityKey(item: {
  packageName: string;
  activityName: string;
  intentUri?: string;
  isWorkProfile?: boolean;
}): string {
  const profileTag = item.isWorkProfile ? "work" : "main";
  if (item.packageName) {
    return `${item.packageName}/${item.activityName}#${profileTag}`;
  }
  return `${item.intentUri ?? ""}#${profileTag}`;
}

/**
 * Collect identity keys for all apps/shortcuts currently placed on `layout`'s
 * home screens or primary hotseat (including inside folders).
 * Records both exact component+profile (`pkg/act#profile`) and package+profile
 * (`pkg:packageName#profile`) keys so activity-alias changes across backups still match.
 */
export function collectPlacedAppKeys(layout: LauncherLayout | undefined): Set<string> {
  const keys = new Set<string>();
  if (!layout) return keys;
  const visit = (item: LayoutItem): void => {
    if (item.kind === "folder") {
      item.children.forEach(visit);
      return;
    }
    if (item.kind === "widget" || item.kind === "launcherAction") return;
    const key = itemAppIdentityKey(item);
    if (key && !key.startsWith("#")) keys.add(key);
    if (item.packageName) {
      const profileTag = item.isWorkProfile ? "work" : "main";
      keys.add(`pkg:${item.packageName}#${profileTag}`);
    }
  };
  layout.screens.forEach((s) => s.items.forEach(visit));
  layout.hotseat.forEach(visit);
  return keys;
}

/**
 * Check whether an app/shortcut item is already placed on Primary, matching either
 * exact `packageName/activityName#profile` or package+profile `pkg:packageName#profile`.
 */
export function isAppItemPlaced(
  item: {
    packageName: string;
    activityName: string;
    intentUri?: string;
    isWorkProfile?: boolean;
  },
  placedKeys: Set<string> | undefined,
): boolean {
  if (!placedKeys || placedKeys.size === 0) return false;
  if (placedKeys.has(itemAppIdentityKey(item))) return true;
  if (item.packageName) {
    const profileTag = item.isWorkProfile ? "work" : "main";
    if (placedKeys.has(`pkg:${item.packageName}#${profileTag}`)) return true;
  }
  return false;
}

/**
 * Remove an item (app, folder, widget, or folder child) from the Primary workspace.
 */
export function deletePrimaryItem(source: LauncherLayout, itemId: string): LauncherLayout {
  const next = cloneLayout(source);
  const extracted = extractPrimaryItem(next, itemId);
  if (!extracted) return source;
  syncHotseatToDockPages(next);
  return next;
}

/**
 * Replace a 1-item folder with its sole child at the folder's exact screen cell or dock slot.
 */
export function unwrapSingleItemFolder(source: LauncherLayout, folderId: string): LauncherLayout {
  const next = cloneLayout(source);

  for (const screen of next.screens) {
    const idx = screen.items.findIndex(
      (it) => it.id === folderId && it.kind === "folder" && it.children.length === 1,
    );
    if (idx >= 0) {
      const folder = screen.items[idx] as FolderItem;
      const soleChild = folder.children[0];
      screen.items[idx] = {
        ...soleChild,
        placement: {
          ...folder.placement,
          container: "desktop",
          spanX: 1,
          spanY: 1,
        },
      };
      return next;
    }
  }

  const dockIdx = next.hotseat.findIndex(
    (it) => it.id === folderId && it.kind === "folder" && it.children.length === 1,
  );
  if (dockIdx >= 0) {
    const folder = next.hotseat[dockIdx] as FolderItem;
    const soleChild = folder.children[0];
    next.hotseat[dockIdx] = {
      ...soleChild,
      placement: {
        ...folder.placement,
        container: "hotseat",
        spanX: 1,
        spanY: 1,
      },
    };
    syncHotseatToDockPages(next);
    return next;
  }

  return source;
}

function appendItemsIntoFolder(targetFolder: FolderItem, incoming: LayoutItem[]): void {
  const existingByKey = new Map<string, LayoutItem>();
  for (const child of targetFolder.children) {
    existingByKey.set(itemAppIdentityKey(child), child);
  }

  for (const item of incoming) {
    if (!canGoInsideFolder(item)) continue;
    const key = itemAppIdentityKey(item);
    const existing = existingByKey.get(key);
    if (existing) {
      if (!existing.iconBytes && item.iconBytes) {
        existing.iconBytes = item.iconBytes;
      }
      if (!existing.iconBytes && !existing.iconUrl && item.iconUrl) {
        existing.iconUrl = item.iconUrl;
      }
      continue;
    }
    const idx = targetFolder.children.length;
    const pushed: LayoutItem = {
      ...item,
      placement: {
        ...item.placement,
        container: "folder",
        cellX: 0,
        cellY: 0,
        spanX: 1,
        spanY: 1,
        rank: idx,
        screenRank: idx,
      },
    };
    targetFolder.children.push(pushed);
    existingByKey.set(key, pushed);
  }
}

function tryCascadePushDesktop(
  items: LayoutItem[],
  targetX: number,
  targetY: number,
  direction: PushDirection,
  cols: number,
  rows: number,
): boolean {
  const dx = direction === "right" ? 1 : direction === "left" ? -1 : 0;
  const dy = direction === "down" ? 1 : direction === "up" ? -1 : 0;

  const chain: LayoutItem[] = [];
  let cx = targetX;
  let cy = targetY;

  while (cx >= 0 && cx < cols && cy >= 0 && cy < rows) {
    const occupant = items.find((it) => {
      const b = itemBounds(it);
      return cellsOverlap(cx, cy, 1, 1, b.x, b.y, b.spanX, b.spanY);
    });

    if (!occupant) {
      // Found an empty cell along the push ray! Shift the chain forward from tail to head.
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        chain[i].placement.cellX = Math.round(chain[i].placement.cellX) + dx;
        chain[i].placement.cellY = Math.round(chain[i].placement.cellY) + dy;
      }
      return true;
    }

    // Multi-cell widgets don't cascade along 1x1 icon rays
    const b = itemBounds(occupant);
    if (b.spanX > 1 || b.spanY > 1) return false;

    chain.push(occupant);
    cx += dx;
    cy += dy;
  }

  return false;
}

export interface DropOutcomeResult {
  layout: LauncherLayout;
  accepted: boolean;
  /** Which action occurred (or why it was rejected). */
  action: "empty" | "push" | "swap" | "replace" | "folder-merge" | "folder-reorder" | "rejected";
  /** Actual push direction used if a push occurred (`target.pushDirection` or opposite fallback on dock). */
  effectiveDirection?: PushDirection;
  rejectionReason?: string;
}

/**
 * Evaluate and apply a drag-and-drop operation, returning both the resulting `LauncherLayout`
 * and rich metadata (`accepted`, `action`, `effectiveDirection`, `rejectionReason`) so the UI
 * can show truthful live hover cursors/highlights and explanatory toasts on invalid drops.
 */
export function evaluateDropOutcome(
  source: LauncherLayout,
  dragSource: DragItemSource,
  target: DropTarget,
): DropOutcomeResult {
  const next = cloneLayout(source);

  // Guard against dropping a folder onto itself
  if (
    dragSource.origin === "primary" &&
    target.kind === "folder-interior" &&
    dragSource.itemId === target.folderId
  ) {
    return {
      layout: source,
      accepted: false,
      action: "rejected",
      rejectionReason: "Cannot move a folder inside itself.",
    };
  }

  let movingItem: LayoutItem;
  let extracted: ExtractedItem | undefined;

  if (dragSource.origin === "primary") {
    extracted = extractPrimaryItem(next, dragSource.itemId);
    if (!extracted) {
      return {
        layout: source,
        accepted: false,
        action: "rejected",
        rejectionReason: "Could not locate dragged item.",
      };
    }
    movingItem = extracted.item;
  } else {
    movingItem = cloneLayoutItem(dragSource.item, true);
  }

  if (target.kind === "folder-interior") {
    if (!canGoInsideFolder(movingItem)) {
      return {
        layout: source,
        accepted: false,
        action: "rejected",
        rejectionReason:
          movingItem.kind === "widget"
            ? "Widgets cannot be placed inside folders."
            : "Folders cannot be nested inside another folder.",
      };
    }
    const allTopItems = [...next.screens.flatMap((s) => s.items), ...next.hotseat];
    const folder = allTopItems.find(
      (it): it is FolderItem => it.id === target.folderId && it.kind === "folder",
    );
    if (!folder) {
      return {
        layout: source,
        accepted: false,
        action: "rejected",
        rejectionReason: "Target folder no longer exists.",
      };
    }

    const insertIdx =
      typeof target.index === "number"
        ? Math.max(0, Math.min(folder.children.length, target.index))
        : folder.children.length;
    movingItem.placement = {
      ...movingItem.placement,
      container: "folder",
      cellX: 0,
      cellY: 0,
      spanX: 1,
      spanY: 1,
      rank: insertIdx,
      screenRank: insertIdx,
    };
    folder.children.splice(insertIdx, 0, movingItem);
    folder.children.forEach((child, idx) => {
      child.placement.rank = idx;
      child.placement.screenRank = idx;
    });
    syncHotseatToDockPages(next);
    return {
      layout: next,
      accepted: true,
      action: "folder-reorder",
    };
  }

  if (target.kind === "dock-slot") {
    if (movingItem.kind === "widget") {
      return {
        layout: source,
        accepted: false,
        action: "rejected",
        rejectionReason: "Widgets cannot be placed in the dock.",
      };
    }
    const slot = Math.max(0, Math.min(next.grid.dockCols - 1, target.slot));
    const occupantIdx = next.hotseat.findIndex((it) => Math.round(it.placement.cellX) === slot);
    const occupant = occupantIdx >= 0 ? next.hotseat[occupantIdx] : undefined;

    if (occupant && target.replaceOccupant) {
      next.hotseat.splice(occupantIdx, 1);
      movingItem.placement = {
        ...movingItem.placement,
        container: "hotseat",
        dockPage: 0,
        cellX: slot,
        cellY: 0,
        spanX: 1,
        spanY: 1,
        rank: slot,
        screenRank: slot,
      };
      next.hotseat.push(movingItem);
      next.hotseat.sort((a, b) => a.placement.cellX - b.placement.cellX);
      syncHotseatToDockPages(next);
      return { layout: next, accepted: true, action: "replace" };
    }

    if (occupant && target.mergeIntoFolder) {
      if (!canGoInsideFolder(movingItem) && movingItem.kind !== "folder") {
        return {
          layout: source,
          accepted: false,
          action: "rejected",
          rejectionReason: "This item cannot be added to a folder.",
        };
      }
      const incomingItems = movingItem.kind === "folder" ? movingItem.children : [movingItem];
      if (occupant.kind === "folder") {
        appendItemsIntoFolder(occupant, incomingItems);
        syncHotseatToDockPages(next);
        return { layout: next, accepted: true, action: "folder-merge" };
      }
      if (canGoInsideFolder(occupant)) {
        const newFolder: FolderItem = {
          kind: "folder",
          id: `edit:${crypto.randomUUID()}`,
          title: movingItem.kind === "folder" ? movingItem.title : "",
          packageName: "",
          activityName: "",
          intentUri: "",
          placement: {
            container: "hotseat",
            cellX: slot,
            cellY: 0,
            spanX: 1,
            spanY: 1,
            rank: slot,
            screenRank: slot,
          },
          children: [],
        };
        appendItemsIntoFolder(newFolder, [occupant, ...incomingItems]);
        next.hotseat[occupantIdx] = newFolder;
        syncHotseatToDockPages(next);
        return { layout: next, accepted: true, action: "folder-merge" };
      }
      return {
        layout: source,
        accepted: false,
        action: "rejected",
        rejectionReason: "Cannot create a folder on this dock item.",
      };
    }

    let action: DropOutcomeResult["action"] = "empty";
    let effectiveDirection: PushDirection | undefined;

    if (occupant) {
      // Push dock items left or right to make room at `slot`, or swap if dock was already full
      if (next.hotseat.length >= next.grid.dockCols) {
        if (extracted?.originContainer === "hotseat" && typeof extracted.originCellX === "number") {
          occupant.placement.cellX = extracted.originCellX;
          occupant.placement.screenRank = extracted.originCellX;
          occupant.placement.rank = extracted.originCellX;
          action = "swap";
          effectiveDirection = extracted.originCellX < slot ? "left" : "right";
        } else {
          return {
            layout: source,
            accepted: false,
            action: "rejected",
            rejectionReason: `Dock is full (${next.grid.dockCols}/${next.grid.dockCols} slots) — drop in the center to group into a folder, hold Shift to replace, or expand dock slots.`,
          };
        }
      } else {
        const occupiedSlots = new Set(next.hotseat.map((it) => Math.round(it.placement.cellX)));
        const preferDir: -1 | 1 = target.pushDirection === "left" ? -1 : 1;
        const oppDir: -1 | 1 = preferDir === -1 ? 1 : -1;
        let pushedDir: -1 | 1 | undefined;
        for (const dir of [preferDir, oppDir]) {
          let probe = slot + dir;
          while (probe >= 0 && probe < next.grid.dockCols && occupiedSlots.has(probe)) {
            probe += dir;
          }
          if (probe >= 0 && probe < next.grid.dockCols) {
            for (const it of next.hotseat) {
              const sx = Math.round(it.placement.cellX);
              if ((dir > 0 && sx >= slot && sx < probe) || (dir < 0 && sx <= slot && sx > probe)) {
                it.placement.cellX = sx + dir;
                it.placement.screenRank = sx + dir;
                it.placement.rank = sx + dir;
              }
            }
            pushedDir = dir;
            break;
          }
        }
        if (!pushedDir) {
          return {
            layout: source,
            accepted: false,
            action: "rejected",
            rejectionReason: "No free dock slot available to push neighbors into.",
          };
        }
        action = "push";
        effectiveDirection = pushedDir < 0 ? "left" : "right";
      }
    }

    movingItem.placement = {
      ...movingItem.placement,
      container: "hotseat",
      dockPage: 0,
      cellX: slot,
      cellY: 0,
      spanX: 1,
      spanY: 1,
      rank: slot,
      screenRank: slot,
    };
    next.hotseat.push(movingItem);
    next.hotseat.sort((a, b) => a.placement.cellX - b.placement.cellX);
    syncHotseatToDockPages(next);
    return { layout: next, accepted: true, action, effectiveDirection };
  }

  // Desktop cell target
  const screen = next.screens.find((s) => s.rank === target.screenRank);
  if (!screen) {
    return {
      layout: source,
      accepted: false,
      action: "rejected",
      rejectionReason: "Target page does not exist.",
    };
  }

  const rawW = movingItem.kind === "widget" ? Math.max(0.5, movingItem.placement.spanX) : 1;
  const rawH = movingItem.kind === "widget" ? Math.max(0.5, movingItem.placement.spanY) : 1;
  const spanX = Math.min(next.grid.cols, rawW);
  const spanY = Math.min(next.grid.rows, rawH);
  const clampedX = Math.max(0, Math.min(next.grid.cols - spanX, target.cellX));
  const clampedY = Math.max(0, Math.min(next.grid.rows - spanY, target.cellY));

  const overlapping = screen.items.filter((it) => {
    const b = itemBounds(it);
    return cellsOverlap(clampedX, clampedY, spanX, spanY, b.x, b.y, b.spanX, b.spanY);
  });

  if (overlapping.length > 0 && target.replaceOccupant) {
    const overlappedIds = new Set(overlapping.map((it) => it.id));
    screen.items = screen.items.filter((it) => !overlappedIds.has(it.id));
    movingItem.placement = {
      ...movingItem.placement,
      container: "desktop",
      screenId: screen.id,
      screenRank: screen.rank,
      cellX: clampedX,
      cellY: clampedY,
      spanX,
      spanY,
    };
    screen.items.push(movingItem);
    syncHotseatToDockPages(next);
    return { layout: next, accepted: true, action: "replace" };
  }

  if (overlapping.length === 1 && target.mergeIntoFolder) {
    const occupant = overlapping[0];
    if (occupant.kind === "widget" || movingItem.kind === "widget") {
      return {
        layout: source,
        accepted: false,
        action: "rejected",
        rejectionReason: "Widgets cannot be grouped into folders.",
      };
    }
    if (canGoInsideFolder(movingItem) || movingItem.kind === "folder") {
      const incomingItems = movingItem.kind === "folder" ? movingItem.children : [movingItem];
      if (occupant.kind === "folder") {
        appendItemsIntoFolder(occupant, incomingItems);
        syncHotseatToDockPages(next);
        return { layout: next, accepted: true, action: "folder-merge" };
      }
      if (canGoInsideFolder(occupant)) {
        const occX = Math.round(occupant.placement.cellX);
        const occY = Math.round(occupant.placement.cellY);
        const newFolder: FolderItem = {
          kind: "folder",
          id: `edit:${crypto.randomUUID()}`,
          title: movingItem.kind === "folder" ? movingItem.title : "",
          packageName: "",
          activityName: "",
          intentUri: "",
          placement: {
            container: "desktop",
            screenId: screen.id,
            screenRank: screen.rank,
            cellX: occX,
            cellY: occY,
            spanX: 1,
            spanY: 1,
          },
          children: [],
        };
        appendItemsIntoFolder(newFolder, [occupant, ...incomingItems]);
        const occIdx = screen.items.findIndex((it) => it.id === occupant.id);
        screen.items[occIdx] = newFolder;
        syncHotseatToDockPages(next);
        return { layout: next, accepted: true, action: "folder-merge" };
      }
    }
  }

  let action: DropOutcomeResult["action"] = "empty";
  let effectiveDirection: PushDirection | undefined;

  if (overlapping.length > 0) {
    if (spanX === 1 && spanY === 1 && overlapping.length === 1) {
      const occupant = overlapping[0];
      const occSpan = intSpan(occupant);
      const dir = target.pushDirection ?? "right";
      const cascaded =
        occSpan.spanX === 1 &&
        occSpan.spanY === 1 &&
        tryCascadePushDesktop(
          screen.items,
          clampedX,
          clampedY,
          dir,
          next.grid.cols,
          next.grid.rows,
        );

      if (cascaded) {
        action = "push";
        effectiveDirection = dir;
      } else {
        // Try swapping into vacated cell if same screen, or nudging occupant to nearest free cell
        const ignore = new Set([occupant.id]);
        const dummy: LayoutItem = {
          ...movingItem,
          id: "__reserved__",
          placement: {
            ...movingItem.placement,
            cellX: clampedX,
            cellY: clampedY,
            spanX: 1,
            spanY: 1,
          },
        };
        const swapPrefX =
          extracted?.originContainer === "desktop" &&
          extracted.originScreenRank === screen.rank &&
          typeof extracted.originCellX === "number"
            ? extracted.originCellX
            : clampedX;
        const swapPrefY =
          extracted?.originContainer === "desktop" &&
          extracted.originScreenRank === screen.rank &&
          typeof extracted.originCellY === "number"
            ? extracted.originCellY
            : clampedY;
        const fallback = findNearestFreeCell(
          [...screen.items, dummy],
          swapPrefX,
          swapPrefY,
          occSpan.spanX,
          occSpan.spanY,
          next.grid.cols,
          next.grid.rows,
          ignore,
        );
        if (!fallback) {
          const reason =
            occupant.kind === "widget"
              ? `No free space on Page ${screen.rank + 1} to displace widget "${occupant.title || "widget"}" (hold Shift to replace it).`
              : `Page ${screen.rank + 1} is completely full — drop in the center to group into a folder, hold Shift to replace, or move to another page.`;
          return {
            layout: source,
            accepted: false,
            action: "rejected",
            rejectionReason: reason,
          };
        }
        occupant.placement.cellX = fallback.x;
        occupant.placement.cellY = fallback.y;
        action = "swap";
        const dx = fallback.x - clampedX;
        const dy = fallback.y - clampedY;
        effectiveDirection =
          Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
      }
    } else {
      // Multi-cell widget dropped on occupied region: place widget at nearest free spot if needed, or push 1x1s out
      const all1x1 = overlapping.every((it) => {
        const s = intSpan(it);
        return s.spanX === 1 && s.spanY === 1;
      });
      if (!all1x1) {
        return {
          layout: source,
          accepted: false,
          action: "rejected",
          rejectionReason: `Cannot overlap another widget on Page ${screen.rank + 1} — drop onto empty cells instead.`,
        };
      }

      const dummyWidget: LayoutItem = {
        ...movingItem,
        id: "__reserved_widget__",
        placement: { ...movingItem.placement, cellX: clampedX, cellY: clampedY, spanX, spanY },
      };
      for (const occ of overlapping) {
        const free = findNearestFreeCell(
          [...screen.items, dummyWidget],
          Math.round(occ.placement.cellX),
          Math.round(occ.placement.cellY),
          1,
          1,
          next.grid.cols,
          next.grid.rows,
          new Set([occ.id]),
        );
        if (!free) {
          return {
            layout: source,
            accepted: false,
            action: "rejected",
            rejectionReason: `Not enough free cells on Page ${screen.rank + 1} to fit this ${Math.round(spanX)}×${Math.round(spanY)} widget.`,
          };
        }
        occ.placement.cellX = free.x;
        occ.placement.cellY = free.y;
      }
      action = "push";
    }
  }

  movingItem.placement = {
    ...movingItem.placement,
    container: "desktop",
    screenId: screen.id,
    screenRank: screen.rank,
    cellX: clampedX,
    cellY: clampedY,
    spanX,
    spanY,
  };
  screen.items.push(movingItem);
  syncHotseatToDockPages(next);
  return { layout: next, accepted: true, action, effectiveDirection };
}

/**
 * Move an existing item within `source` or insert a cloned item from a Secondary Donor backup.
 */
export function moveOrInsertItem(
  source: LauncherLayout,
  dragSource: DragItemSource,
  target: DropTarget,
): LauncherLayout {
  return evaluateDropOutcome(source, dragSource, target).layout;
}

/**
 * Cross-pollinate missing `iconBytes`, `iconUrl`, and human-readable `title`s on `target`
 * using matching `packageName/activityName` or `packageName` entries from one or more loaded
 * layouts (e.g. pairing a Samsung `.exml` with a Nova `.novabackup`).
 */
export function enrichLayoutIcons(
  target: LauncherLayout,
  ...donors: (LauncherLayout | undefined)[]
): LauncherLayout {
  const iconByComponentProfile = new Map<string, Uint8Array>();
  const iconByPackageProfile = new Map<string, Uint8Array>();
  const iconUrlByComponent = new Map<string, string>();
  const iconUrlByPackage = new Map<string, string>();
  const realTitleByComponent = new Map<string, string>();
  const realTitleByPackage = new Map<string, string>();
  const fallbackTitleByComponent = new Map<string, string>();
  const fallbackTitleByPackage = new Map<string, string>();

  const recordMeta = (
    pkg: string,
    act: string,
    title: string | undefined,
    iconBytes: Uint8Array | undefined,
    iconUrl: string | undefined,
    isWorkProfile: boolean | undefined,
  ): void => {
    if (!pkg) return;
    const profileTag = isWorkProfile ? "work" : "main";
    const compKey = act ? `${pkg}/${act}` : "";
    if (iconBytes) {
      if (compKey) {
        const compProfKey = `${compKey}#${profileTag}`;
        if (!iconByComponentProfile.has(compProfKey)) {
          iconByComponentProfile.set(compProfKey, iconBytes);
        }
      }
      const pkgProfKey = `${pkg}#${profileTag}`;
      if (!iconByPackageProfile.has(pkgProfKey)) {
        iconByPackageProfile.set(pkgProfKey, iconBytes);
      }
    }
    if (iconUrl) {
      if (compKey && !iconUrlByComponent.has(compKey)) {
        iconUrlByComponent.set(compKey, iconUrl);
      }
      if (!iconUrlByPackage.has(pkg)) {
        iconUrlByPackage.set(pkg, iconUrl);
      }
    }
    if (title && !isGenericTechnicalLabel(title, pkg, act)) {
      const isMerelyHeuristic = title === inferHeuristicAppLabel(pkg, act);
      if (!isMerelyHeuristic) {
        if (compKey && !realTitleByComponent.has(compKey)) realTitleByComponent.set(compKey, title);
        if (!realTitleByPackage.has(pkg)) realTitleByPackage.set(pkg, title);
      } else {
        if (compKey && !fallbackTitleByComponent.has(compKey)) {
          fallbackTitleByComponent.set(compKey, title);
        }
        if (!fallbackTitleByPackage.has(pkg)) fallbackTitleByPackage.set(pkg, title);
      }
    }
  };

  const resolveBetterTitle = (
    pkg: string,
    act: string,
    inferred: string,
    heuristicInferred: string,
  ): string | undefined => {
    const compKey = act ? `${pkg}/${act}` : "";
    return (
      (compKey ? realTitleByComponent.get(compKey) : undefined) ??
      realTitleByPackage.get(pkg) ??
      (inferred !== heuristicInferred ? inferred : undefined) ??
      (compKey ? fallbackTitleByComponent.get(compKey) : undefined) ??
      fallbackTitleByPackage.get(pkg)
    );
  };

  const resolveIconForProfile = (
    pkg: string,
    act: string,
    isWorkProfile: boolean | undefined,
  ): Uint8Array | undefined => {
    const compKey = act ? `${pkg}/${act}` : "";
    if (isWorkProfile) {
      // Work profile items prefer work-badged icons, falling back to personal icon (with CSS badge)
      return (
        (compKey ? iconByComponentProfile.get(`${compKey}#work`) : undefined) ??
        iconByPackageProfile.get(`${pkg}#work`) ??
        (compKey ? iconByComponentProfile.get(`${compKey}#main`) : undefined) ??
        iconByPackageProfile.get(`${pkg}#main`)
      );
    }
    // Personal items strictly match `#main` icons so they never inherit Android's rasterized briefcase PNG from `#work`!
    return (
      (compKey ? iconByComponentProfile.get(`${compKey}#main`) : undefined) ??
      iconByPackageProfile.get(`${pkg}#main`)
    );
  };

  const resolveIconUrl = (pkg: string, act: string): string | undefined => {
    const compKey = act ? `${pkg}/${act}` : "";
    return (compKey ? iconUrlByComponent.get(compKey) : undefined) ?? iconUrlByPackage.get(pkg);
  };

  const indexLayout = (layout: LauncherLayout | undefined): void => {
    if (!layout) return;
    const visit = (item: LayoutItem): void => {
      if (item.kind === "folder") {
        item.children.forEach(visit);
        return;
      }
      if (item.kind === "widget") return;
      recordMeta(
        item.packageName,
        item.activityName,
        item.title,
        item.iconBytes,
        item.iconUrl,
        item.isWorkProfile,
      );
    };
    layout.screens.forEach((s) => s.items.forEach(visit));
    layout.hotseat.forEach(visit);
    layout.drawerGroups?.forEach((g) => g.items.forEach(visit));
    layout.appCatalog?.forEach((app) => {
      recordMeta(
        app.packageName,
        app.activityName,
        app.title,
        app.iconBytes,
        app.iconUrl,
        app.isWorkProfile,
      );
    });
  };

  // Index donors BEFORE target so real stored Nova titles override heuristic Samsung fallback titles!
  donors.forEach(indexLayout);
  indexLayout(target);
  if (
    iconByPackageProfile.size === 0 &&
    iconUrlByPackage.size === 0 &&
    realTitleByPackage.size === 0 &&
    fallbackTitleByPackage.size === 0
  ) {
    return target;
  }

  let changed = false;
  const enrichItem = (item: LayoutItem): LayoutItem => {
    if (item.kind === "folder") {
      const nextChildren = item.children.map(enrichItem);
      if (nextChildren.some((c, i) => c !== item.children[i])) {
        changed = true;
        return { ...item, children: nextChildren };
      }
      return item;
    }
    if (item.kind === "widget" || !item.packageName) return item;

    const matchedIcon =
      item.iconBytes ??
      resolveIconForProfile(item.packageName, item.activityName, item.isWorkProfile);
    const matchedIconUrl =
      !matchedIcon && !item.iconUrl
        ? resolveIconUrl(item.packageName, item.activityName)
        : item.iconUrl;
    const inferred = inferFriendlyAppLabel(item.packageName, item.activityName);
    const heuristicInferred = inferHeuristicAppLabel(item.packageName, item.activityName);
    const betterTitle = resolveBetterTitle(
      item.packageName,
      item.activityName,
      inferred,
      heuristicInferred,
    );

    const shouldReplaceTitle =
      Boolean(betterTitle) &&
      betterTitle !== item.title &&
      (isGenericTechnicalLabel(item.title, item.packageName, item.activityName) ||
        item.title === inferred ||
        item.title === heuristicInferred);

    if (matchedIcon !== item.iconBytes || matchedIconUrl !== item.iconUrl || shouldReplaceTitle) {
      changed = true;
      return {
        ...item,
        ...(matchedIcon ? { iconBytes: matchedIcon } : {}),
        ...(matchedIconUrl ? { iconUrl: matchedIconUrl } : {}),
        ...(shouldReplaceTitle && betterTitle ? { title: betterTitle } : {}),
      };
    }
    return item;
  };

  const screens = target.screens.map((s) => ({
    ...s,
    items: s.items.map(enrichItem),
  }));
  const hotseat = target.hotseat.map(enrichItem);
  const dockPages = target.dockPages?.map((dp) => ({
    ...dp,
    items: dp.items.map(enrichItem),
  }));
  const drawerGroups = target.drawerGroups?.map((group) => ({
    ...group,
    items: group.items.map(enrichItem),
  }));
  const drawerItems = target.drawerItems?.map(enrichItem);

  let appCatalog: InstalledAppSummary[] | undefined = target.appCatalog;
  if (target.appCatalog) {
    let catChanged = false;
    const nextCat = target.appCatalog.map((app) => {
      const matchedIcon =
        app.iconBytes ??
        resolveIconForProfile(app.packageName, app.activityName, app.isWorkProfile);
      const matchedIconUrl =
        !matchedIcon && !app.iconUrl
          ? resolveIconUrl(app.packageName, app.activityName)
          : app.iconUrl;
      const inferred = inferFriendlyAppLabel(app.packageName, app.activityName);
      const heuristicInferred = inferHeuristicAppLabel(app.packageName, app.activityName);
      const betterTitle = resolveBetterTitle(
        app.packageName,
        app.activityName,
        inferred,
        heuristicInferred,
      );
      const shouldReplaceTitle =
        Boolean(betterTitle) &&
        betterTitle !== app.title &&
        (isGenericTechnicalLabel(app.title, app.packageName, app.activityName) ||
          app.title === inferred ||
          app.title === heuristicInferred);

      if (matchedIcon !== app.iconBytes || matchedIconUrl !== app.iconUrl || shouldReplaceTitle) {
        catChanged = true;
        return {
          ...app,
          ...(matchedIcon ? { iconBytes: matchedIcon } : {}),
          ...(matchedIconUrl ? { iconUrl: matchedIconUrl } : {}),
          ...(shouldReplaceTitle && betterTitle ? { title: betterTitle } : {}),
        };
      }
      return app;
    });
    if (catChanged) {
      changed = true;
      appCatalog = nextCat.sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
      );
    }
  }

  if (!changed) return target;

  return {
    ...target,
    screens,
    hotseat,
    ...(dockPages ? { dockPages } : {}),
    ...(drawerGroups ? { drawerGroups } : {}),
    ...(drawerItems ? { drawerItems } : {}),
    ...(appCatalog ? { appCatalog } : {}),
  };
}

export interface ExternalAppMetadataEntry {
  found: boolean;
  title?: string;
  iconUrl?: string;
  iconBytes?: Uint8Array;
}

/**
 * Enrich missing icons (`iconUrl` / `iconBytes`) and heuristic/generic `title`s across `target`
 * using cached external metadata (e.g. Google Play Store lookups), without overwriting
 * existing backup icons or user-customized titles.
 */
export function applyExternalAppMetadata(
  target: LauncherLayout,
  metadataMap: ReadonlyMap<string, ExternalAppMetadataEntry>,
): LauncherLayout {
  if (metadataMap.size === 0) return target;

  let changed = false;

  const shouldEnrichTitle = (
    currentTitle: string | undefined,
    pkg: string,
    act: string,
    hasCustomTitle: boolean | undefined,
    externalTitle: string | undefined,
  ): externalTitle is string => {
    if (hasCustomTitle || !externalTitle || externalTitle === currentTitle) {
      return false;
    }
    if (isGenericTechnicalLabel(currentTitle, pkg, act)) {
      return true;
    }
    if (!hasCuratedAppLabel(pkg) && currentTitle === inferHeuristicAppLabel(pkg, act)) {
      return true;
    }
    return false;
  };

  const enrichItem = (item: LayoutItem): LayoutItem => {
    if (item.kind === "folder") {
      const nextChildren = item.children.map(enrichItem);
      if (nextChildren.some((c, i) => c !== item.children[i])) {
        changed = true;
        return { ...item, children: nextChildren };
      }
      return item;
    }
    if (item.kind === "widget" || item.kind === "launcherAction" || !item.packageName) {
      return item;
    }

    const meta = metadataMap.get(item.packageName);
    if (!meta || !meta.found) return item;

    const matchedIcon = item.iconBytes ?? meta.iconBytes;
    const matchedIconUrl =
      !matchedIcon && !item.iconUrl && meta.iconUrl ? meta.iconUrl : item.iconUrl;
    const replaceTitle = shouldEnrichTitle(
      item.title,
      item.packageName,
      item.activityName,
      item.novaMetadata?.hasCustomTitle,
      meta.title,
    );

    if (matchedIcon !== item.iconBytes || matchedIconUrl !== item.iconUrl || replaceTitle) {
      changed = true;
      return {
        ...item,
        ...(matchedIcon ? { iconBytes: matchedIcon } : {}),
        ...(matchedIconUrl ? { iconUrl: matchedIconUrl } : {}),
        ...(replaceTitle ? { title: meta.title } : {}),
      };
    }
    return item;
  };

  const screens = target.screens.map((s) => ({
    ...s,
    items: s.items.map(enrichItem),
  }));
  const hotseat = target.hotseat.map(enrichItem);
  const dockPages = target.dockPages?.map((dp) =>
    dp.page === 0 ? { ...dp, items: hotseat } : { ...dp, items: dp.items.map(enrichItem) },
  );
  const drawerGroups = target.drawerGroups?.map((g) => ({
    ...g,
    items: g.items.map(enrichItem),
  }));
  const drawerItems = target.drawerItems?.map(enrichItem);

  let appCatalog: InstalledAppSummary[] | undefined = target.appCatalog;
  if (target.appCatalog) {
    let catChanged = false;
    let catTitleChanged = false;
    const nextCat = target.appCatalog.map((app) => {
      const meta = metadataMap.get(app.packageName);
      if (!meta || !meta.found) return app;

      const matchedIcon = app.iconBytes ?? meta.iconBytes;
      const matchedIconUrl =
        !matchedIcon && !app.iconUrl && meta.iconUrl ? meta.iconUrl : app.iconUrl;
      const replaceTitle = shouldEnrichTitle(
        app.title,
        app.packageName,
        app.activityName,
        false,
        meta.title,
      );

      if (matchedIcon !== app.iconBytes || matchedIconUrl !== app.iconUrl || replaceTitle) {
        catChanged = true;
        if (replaceTitle) catTitleChanged = true;
        return {
          ...app,
          ...(matchedIcon ? { iconBytes: matchedIcon } : {}),
          ...(matchedIconUrl ? { iconUrl: matchedIconUrl } : {}),
          ...(replaceTitle ? { title: meta.title } : {}),
        };
      }
      return app;
    });
    if (catChanged) {
      changed = true;
      appCatalog = catTitleChanged
        ? nextCat.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }))
        : nextCat;
    }
  }

  if (!changed) return target;

  return {
    ...target,
    screens,
    hotseat,
    ...(dockPages ? { dockPages } : {}),
    ...(drawerGroups ? { drawerGroups } : {}),
    ...(drawerItems ? { drawerItems } : {}),
    ...(appCatalog ? { appCatalog } : {}),
  };
}
