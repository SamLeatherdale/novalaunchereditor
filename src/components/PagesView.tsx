import React, { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
  DOCK_MAX_COLS,
  DOCK_MIN_COLS,
  GRID_MAX_COLS,
  GRID_MAX_ROWS,
  GRID_MIN_COLS,
  GRID_MIN_ROWS,
  isAppItemPlaced,
  type DockEdge,
  type GridEdge,
} from "../core/editor/layoutOperations";
import { classifyAppPackage, type AppSourceCategory } from "../core/model/appLabels";
import type { EffectiveFolderDisplayConfig } from "../core/model/folderGrids";
import type {
  FolderItem,
  InstalledAppSummary,
  LauncherLayout,
  LayoutItem,
  ScreenModel,
} from "../core/model/types";
import DockArrow from "./DockArrow";
import FolderModal from "./FolderModal";
import { IconGraphic } from "./IconGraphic";
import {
  isIconFullyOutsideRect,
  type FolderModalDragContext,
  type HoverTargetState,
  type PointerDragSession,
} from "./PointerDragLayer";

const CELL_SIZE = 72;

type ExclusiveCatalogFilter = "all" | AppSourceCategory;

const APP_CATEGORY_TABS: { key: ExclusiveCatalogFilter; label: string; tooltip: string }[] = [
  { key: "all", label: "All", tooltip: "Show all installed apps in this backup" },
  { key: "user", label: "User", tooltip: "Third-party apps" },
  {
    key: "google",
    label: "Google",
    tooltip: "Google apps & services (com.google.*, Chrome, Play Store)",
  },
  {
    key: "samsung",
    label: "Samsung",
    tooltip: "Samsung system & Galaxy Store apps (com.samsung.*, com.sec.*)",
  },
  {
    key: "system",
    label: "System",
    tooltip: "Core Android packages (com.android.*)",
  },
];

interface PagesViewProps {
  layout: LauncherLayout;
  folderDisplay: EffectiveFolderDisplayConfig;
  editable?: boolean;
  placedPrimaryKeys?: Set<string>;
  openFolderId: string | null;
  onOpenFolderChange: (folderId: string | null) => void;
  dragSession: PointerDragSession | null;
  hoverTarget: HoverTargetState | null;
  onBeginDrag: (
    origin: "primary" | "donor",
    item: LayoutItem,
    clientX: number,
    clientY: number,
    shiftKey: boolean,
    folderModal?: FolderModalDragContext,
  ) => void;
  onUnwrapFolder?: (folderId: string) => void;
  onResizeGrid?: (edge: GridEdge, delta: 1 | -1) => void;
  onResizeDock?: (edge: DockEdge, delta: 1 | -1) => void;
  onAddScreen?: () => void;
  onRemoveScreen?: (screenRank: number) => void;
  onRenameFolder?: (folderId: string, newTitle: string) => void;
}

function catalogAppToDraggableItem(app: InstalledAppSummary, index: number): LayoutItem {
  return {
    kind: "app",
    id: `catalog:${app.packageName}/${app.activityName}:${index}`,
    title: app.title,
    packageName: app.packageName,
    activityName: app.activityName,
    intentUri:
      app.packageName && app.activityName
        ? `#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;launchFlags=0x10200000;component=${app.packageName}/${app.activityName};end`
        : "",
    placement: {
      container: "drawer",
      screenRank: 0,
      cellX: 0,
      cellY: 0,
      spanX: 1,
      spanY: 1,
    },
    iconBytes: app.iconBytes,
    iconUrl: app.iconUrl,
    isWorkProfile: app.isWorkProfile,
  };
}

function isItemAlreadyInPrimary(item: LayoutItem, placedKeys: Set<string> | undefined): boolean {
  if (!placedKeys || placedKeys.size === 0) return false;
  if (item.kind === "folder") {
    return (
      item.children.length > 0 &&
      item.children.every((child) => isItemAlreadyInPrimary(child, placedKeys))
    );
  }
  if (item.kind === "widget" || item.kind === "launcherAction") return false;
  return isAppItemPlaced(item, placedKeys);
}

function attachDragThreshold(
  e: React.PointerEvent<HTMLElement>,
  onStart: (clientX: number, clientY: number, shiftKey: boolean) => void,
  onClick?: () => void,
): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const startX = e.clientX;
  const startY = e.clientY;
  const pointerId = e.pointerId;
  let started = false;

  const cleanup = (): void => {
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
    window.removeEventListener("pointercancel", cleanup);
  };

  const handleMove = (me: PointerEvent): void => {
    if (me.pointerId !== pointerId || started) return;
    if (Math.hypot(me.clientX - startX, me.clientY - startY) >= 5) {
      started = true;
      cleanup();
      onStart(me.clientX, me.clientY, me.shiftKey);
    }
  };

  const handleUp = (ue: PointerEvent): void => {
    if (ue.pointerId !== pointerId) return;
    cleanup();
    if (!started && onClick) {
      onClick();
    }
  };

  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp);
  window.addEventListener("pointercancel", cleanup);
}

const GridAppItem: React.FC<{
  item: LayoutItem;
  origin: "primary" | "donor";
  folderPreviewCols: 2 | 3 | 4 | 5;
  isBeingDragged?: boolean;
  alreadyPlaced?: boolean;
  onBeginDrag: (
    origin: "primary" | "donor",
    item: LayoutItem,
    clientX: number,
    clientY: number,
    shiftKey: boolean,
  ) => void;
  onOpenFolder: (folderId: string) => void;
}> = ({
  item,
  origin,
  folderPreviewCols,
  isBeingDragged = false,
  alreadyPlaced = false,
  onBeginDrag,
  onOpenFolder,
}) => {
  const classes = ["grid-app"];
  if (item.kind === "widget") classes.push("grid-widget");
  if (item.kind === "folder") classes.push("grid-folder");
  if (alreadyPlaced) classes.push("item-already-placed");
  if (isBeingDragged) classes.push("item-dragging-source");

  const isWidget = item.kind === "widget";
  const inset = isWidget ? 3 : 0;
  const style: CSSProperties = {
    position: "absolute",
    left: item.placement.cellX * CELL_SIZE + inset,
    top: item.placement.cellY * CELL_SIZE + inset,
    width: item.placement.spanX * CELL_SIZE - inset * 2,
    height: item.placement.spanY * CELL_SIZE - inset * 2,
  };
  const label = item.kind === "launcherAction" ? "" : item.title;
  const baseTip =
    item.kind === "folder"
      ? `${item.title || "Unnamed Folder"} (${item.children.length} items — click to open)`
      : isWidget
        ? `${label} (${item.placement.spanX}×${item.placement.spanY} widget)`
        : item.isWorkProfile
          ? `${label} (Work Profile)`
          : label;
  const tooltip = alreadyPlaced ? `${baseTip} — Already on Primary` : baseTip;
  const maxMini = folderPreviewCols * folderPreviewCols;

  return (
    <div
      className={classes.join(" ")}
      style={style}
      title={tooltip}
      data-item-id={item.id}
      onPointerDown={(e) =>
        attachDragThreshold(
          e,
          (cx, cy, shift) => onBeginDrag(origin, item, cx, cy, shift),
          item.kind === "folder" ? () => onOpenFolder(item.id) : undefined,
        )
      }
    >
      {item.kind === "folder" ? (
        <div className="grid-app-icon">
          <div
            className="grid-folder-container"
            style={{
              gridTemplateColumns: `repeat(${folderPreviewCols}, 1fr)`,
              gridTemplateRows: `repeat(${folderPreviewCols}, 1fr)`,
              gap: folderPreviewCols >= 4 ? "1px" : "2px",
            }}
          >
            {item.children.slice(0, maxMini).map((child) => (
              <IconGraphic item={child} className="grid-folder-item" key={child.id} />
            ))}
          </div>
          {alreadyPlaced && (
            <span className="placed-check-badge" title="All apps already on Primary">
              <i className="fas fa-check" aria-hidden="true" />
            </span>
          )}
        </div>
      ) : isWidget ? (
        <div className="widget-card-body">
          <i className="fas fa-th-large widget-glyph" />
          <span className="widget-provider-name">{label}</span>
          <span className="widget-span-badge">
            {item.placement.spanX}×{item.placement.spanY}
          </span>
        </div>
      ) : (
        <div className="position-relative">
          <IconGraphic item={item} showWorkBadge />
          {alreadyPlaced && (
            <span className="placed-check-badge" title="Already on Primary">
              <i className="fas fa-check" aria-hidden="true" />
            </span>
          )}
        </div>
      )}
      {!isWidget && <div className="grid-app-title">{label}</div>}
    </div>
  );
};

interface CellOccupantMeta {
  occupied: boolean;
  canGroup: boolean;
  occupantId?: string;
}

const ScreenCanvas: React.FC<{
  screen: ScreenModel;
  pageNumber: number;
  isDefault: boolean;
  rows: number;
  cols: number;
  folderPreviewCols: 2 | 3 | 4 | 5;
  editable: boolean;
  canDelete: boolean;
  origin: "primary" | "donor";
  placedPrimaryKeys?: Set<string>;
  dragSession: PointerDragSession | null;
  hoverTarget: HoverTargetState | null;
  onBeginDrag: (
    origin: "primary" | "donor",
    item: LayoutItem,
    clientX: number,
    clientY: number,
    shiftKey: boolean,
  ) => void;
  onOpenFolder: (folderId: string) => void;
  onRemoveScreen?: (screenRank: number) => void;
}> = ({
  screen,
  pageNumber,
  isDefault,
  rows,
  cols,
  folderPreviewCols,
  editable,
  canDelete,
  origin,
  placedPrimaryKeys,
  dragSession,
  hoverTarget,
  onBeginDrag,
  onOpenFolder,
  onRemoveScreen,
}) => {
  const cellMetaMap = useMemo(() => {
    const map = new Map<string, CellOccupantMeta>();
    for (const item of screen.items) {
      const x0 = Math.floor(item.placement.cellX + 1e-4);
      const y0 = Math.floor(item.placement.cellY + 1e-4);
      const x1 = Math.ceil(
        item.placement.cellX +
          (item.kind === "widget" ? Math.max(0.5, item.placement.spanX) : 1) -
          1e-4,
      );
      const y1 = Math.ceil(
        item.placement.cellY +
          (item.kind === "widget" ? Math.max(0.5, item.placement.spanY) : 1) -
          1e-4,
      );
      const canGroup = item.kind !== "widget";
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          map.set(`${x}:${y}`, { occupied: true, canGroup, occupantId: item.id });
        }
      }
    }
    return map;
  }, [screen.items]);

  const canDraggedItemGroup = dragSession ? dragSession.item.kind !== "widget" : false;
  const shiftReplaceActive = Boolean(dragSession?.shiftKey);

  const cells: React.ReactNode[] = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const meta = cellMetaMap.get(`${x}:${y}`);
      const isOccupied = Boolean(meta?.occupied);
      const isSelf = Boolean(dragSession && meta?.occupantId === dragSession.item.id);
      const showReplaceHint =
        editable && Boolean(dragSession) && shiftReplaceActive && isOccupied && !isSelf;
      const showCenterFolderHint =
        editable &&
        Boolean(dragSession) &&
        !shiftReplaceActive &&
        canDraggedItemGroup &&
        Boolean(meta?.canGroup) &&
        !isSelf;

      const isHovered =
        editable &&
        Boolean(dragSession) &&
        hoverTarget?.kind === "desktop-cell" &&
        hoverTarget.screenRank === screen.rank &&
        hoverTarget.cellX === x &&
        hoverTarget.cellY === y;

      const cellClasses = ["grid-cell-slot"];
      if (isHovered && hoverTarget) {
        if (!hoverTarget.allowed) {
          cellClasses.push("drop-blocked");
        } else if (hoverTarget.action === "replace") {
          cellClasses.push("drop-replace");
        } else if (hoverTarget.action === "folder-merge") {
          cellClasses.push("drop-folder-merge");
        } else if (
          (hoverTarget.action === "push" || hoverTarget.action === "swap") &&
          hoverTarget.effectiveDirection
        ) {
          cellClasses.push(`drop-push-${hoverTarget.effectiveDirection}`);
        } else {
          cellClasses.push("drop-empty");
        }
      }

      cells.push(
        <div
          key={`${x}:${y}`}
          className={cellClasses.join(" ")}
          style={{
            left: x * CELL_SIZE,
            top: y * CELL_SIZE,
            width: CELL_SIZE,
            height: CELL_SIZE,
          }}
          data-cell={`${screen.rank}:${x}:${y}`}
          data-editable={editable ? "true" : "false"}
          data-occupied={isOccupied ? "true" : "false"}
          data-can-group={meta?.canGroup ? "true" : "false"}
          data-occupant-id={meta?.occupantId}
        >
          {showReplaceHint && (
            <div
              className={`cell-center-replace-zone${
                isHovered && hoverTarget?.action === "replace" && hoverTarget.allowed
                  ? " active"
                  : ""
              }`}
            >
              {isHovered && hoverTarget?.action === "replace" && hoverTarget.allowed ? (
                <span className="replace-merge-pill">
                  <i className="fas fa-exchange-alt me-1" />
                  Replace
                </span>
              ) : (
                <i className="fas fa-exchange-alt" aria-hidden="true" />
              )}
            </div>
          )}
          {showCenterFolderHint && (
            <div
              className={`cell-center-folder-zone${
                isHovered && hoverTarget?.action === "folder-merge" && hoverTarget.allowed
                  ? " active"
                  : ""
              }`}
            >
              {isHovered && hoverTarget?.action === "folder-merge" && hoverTarget.allowed ? (
                <span className="folder-merge-pill">
                  <i className="fas fa-folder-plus me-1" />
                  Folder
                </span>
              ) : (
                <i className="fas fa-folder-plus" aria-hidden="true" />
              )}
            </div>
          )}
        </div>,
      );
    }
  }

  return (
    <div className="screen-frame" data-screen-rank={screen.rank}>
      <div className="screen-frame-header">
        <span>
          Page {pageNumber}
          {isDefault && (
            <span className="screen-home-badge" title="Default Home Screen">
              Home
            </span>
          )}
        </span>
        {editable && canDelete && screen.items.length === 0 && onRemoveScreen && (
          <button
            type="button"
            className="screen-delete-btn"
            onClick={() => onRemoveScreen(screen.rank)}
            title="Remove empty page"
          >
            <i className="fas fa-trash-alt me-1" aria-hidden="true" />
            Remove
          </button>
        )}
      </div>
      <div className="desktop-container" style={{ backgroundImage: "url(/phone_wallpaper.jpg)" }}>
        <div className="desktop-container-overlay">
          <div
            className={`desktop-grid${dragSession && editable ? " drag-active-surface" : ""}`}
            style={{
              width: cols * CELL_SIZE,
              height: rows * CELL_SIZE,
              position: "relative",
            }}
          >
            {cells}
            {screen.items.map((item) => (
              <GridAppItem
                key={item.id}
                item={item}
                origin={origin}
                folderPreviewCols={folderPreviewCols}
                isBeingDragged={dragSession?.origin === origin && dragSession.item.id === item.id}
                alreadyPlaced={!editable && isItemAlreadyInPrimary(item, placedPrimaryKeys)}
                onBeginDrag={onBeginDrag}
                onOpenFolder={onOpenFolder}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const PagesView: React.FC<PagesViewProps> = ({
  layout,
  folderDisplay,
  editable = false,
  placedPrimaryKeys,
  openFolderId,
  onOpenFolderChange,
  dragSession,
  hoverTarget,
  onBeginDrag,
  onUnwrapFolder,
  onResizeGrid,
  onResizeDock,
  onAddScreen,
  onRemoveScreen,
  onRenameFolder,
}) => {
  const origin: "primary" | "donor" = editable ? "primary" : "donor";
  const screens = useMemo(
    () => [...layout.screens].sort((a, b) => a.rank - b.rank),
    [layout.screens],
  );
  const [selectedRank, setSelectedRank] = useState(
    layout.grid.defaultScreenRank || screens[0]?.rank || 0,
  );
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 768px)").matches : false,
  );
  const [appSearch, setAppSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<ExclusiveCatalogFilter>("all");
  const stripRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 768px)");
    const listener = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);

  useEffect(() => {
    if (!screens.some((s) => s.rank === selectedRank)) {
      setSelectedRank(screens[0]?.rank ?? 0);
    }
  }, [screens, selectedRank]);

  const openFolder = useMemo<FolderItem | undefined>(() => {
    if (!openFolderId) return undefined;
    const allTop = [...screens.flatMap((s) => s.items), ...layout.hotseat];
    return allTop.find(
      (item): item is FolderItem => item.id === openFolderId && item.kind === "folder",
    );
  }, [openFolderId, screens, layout.hotseat]);

  const isFolderHiddenDuringOutsideDrag = Boolean(
    openFolder &&
    dragSession?.folderModal?.folderId === openFolder.id &&
    dragSession.folderModal.exitedBounds,
  );

  const jumpToScreen = (rank: number): void => {
    setSelectedRank(rank);
    if (!isMobile && stripRef.current) {
      const targetEl = stripRef.current.querySelector<HTMLElement>(`[data-screen-rank="${rank}"]`);
      targetEl?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
  };

  const stepScreen = (delta: -1 | 1): void => {
    const idx = screens.findIndex((s) => s.rank === selectedRank);
    const nextIdx = Math.max(0, Math.min(screens.length - 1, idx + delta));
    const target = screens[nextIdx];
    if (target) jumpToScreen(target.rank);
  };

  const visibleScreens = isMobile ? screens.filter((s) => s.rank === selectedRank) : screens;

  const dockSlotMap = useMemo(() => {
    const map = new Map<number, LayoutItem>();
    for (const item of layout.hotseat) {
      map.set(Math.round(item.placement.cellX), item);
    }
    return map;
  }, [layout.hotseat]);

  const searchMatchedCatalog = useMemo(() => {
    const list = layout.appCatalog ?? [];
    const q = appSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (app) => app.title.toLowerCase().includes(q) || app.packageName.toLowerCase().includes(q),
    );
  }, [layout.appCatalog, appSearch]);

  const categoryCounts = useMemo(() => {
    const counts: Record<ExclusiveCatalogFilter, number> = {
      all: searchMatchedCatalog.length,
      user: 0,
      google: 0,
      samsung: 0,
      system: 0,
    };
    for (const app of searchMatchedCatalog) {
      counts[classifyAppPackage(app.packageName)] += 1;
    }
    return counts;
  }, [searchMatchedCatalog]);

  const filteredCatalog = useMemo(() => {
    if (selectedCategory === "all") return searchMatchedCatalog;
    return searchMatchedCatalog.filter(
      (app) => classifyAppPackage(app.packageName) === selectedCategory,
    );
  }, [searchMatchedCatalog, selectedCategory]);

  const totalCatalogCount = layout.appCatalog?.length ?? 0;
  const isCatalogFiltered = Boolean(appSearch.trim()) || selectedCategory !== "all";

  const canShrinkRows = layout.grid.rows > GRID_MIN_ROWS;
  const canExpandRows = layout.grid.rows < GRID_MAX_ROWS;
  const canShrinkCols = layout.grid.cols > GRID_MIN_COLS;
  const canExpandCols = layout.grid.cols < GRID_MAX_COLS;
  const canShrinkDock =
    layout.grid.dockCols > DOCK_MIN_COLS && layout.hotseat.length < layout.grid.dockCols;
  const canExpandDock = layout.grid.dockCols < DOCK_MAX_COLS;

  const isTrashHovered = hoverTarget?.kind === "trash" && hoverTarget.allowed;
  const canDraggedItemGroup = dragSession ? dragSession.item.kind !== "widget" : false;
  const shiftReplaceActive = Boolean(dragSession?.shiftKey);

  const openFolderDims = openFolder
    ? folderDisplay.resolveOpenGrid(openFolder.children.length)
    : { cols: 4, rows: 4 };

  return (
    <div className="pages-view">
      {editable ? (
        dragSession?.origin === "primary" ? (
          <div
            className={`trash-drop-zone${isTrashHovered ? " trash-hovered" : ""}`}
            data-drop-zone="trash"
          >
            <i className="fas fa-trash-alt me-2" />
            Drop here to remove &ldquo;{dragSession.item.title || dragSession.item.kind}&rdquo; from
            Home
          </div>
        ) : (
          <div className="editor-gesture-hint">
            <span>
              <i className="fas fa-arrows-alt me-1" />
              Drag to icon edges to push or swap
            </span>
            <span>
              <i className="fas fa-folder-plus me-1" />
              Drop on an icon&rsquo;s center for a folder
            </span>
            <span>
              <kbd>Shift</kbd> + Drop to replace an item
            </span>
            <span>
              <i className="fas fa-folder-open me-1" />
              Click any folder to open or edit
            </span>
          </div>
        )
      ) : (
        <div className="editor-gesture-hint">
          <span>
            <i className="fas fa-hand-rock me-1" />
            Drag any app or folder up into your Primary workspace
          </span>
          <span>
            <i className="fas fa-folder-open me-1" />
            Click any folder to inspect its contents
          </span>
          <span>
            <i className="fas fa-check-circle text-success me-1" />
            Dimmed items are already placed on Primary
          </span>
        </div>
      )}

      <div className="workspace-matrix">
        {/* Top Full-Width Row Edge Control */}
        {editable && onResizeGrid && (
          <div className="grid-edge-bar grid-edge-horizontal">
            <button
              type="button"
              className="edge-btn"
              disabled={!canShrinkRows}
              onClick={() => onResizeGrid("top", -1)}
              title="Remove top row"
              aria-label="Remove top row"
            >
              <i className="fas fa-minus" aria-hidden="true" />
            </button>
            <span className="edge-label">Top Row ({layout.grid.rows} rows)</span>
            <button
              type="button"
              className="edge-btn"
              disabled={!canExpandRows}
              onClick={() => onResizeGrid("top", 1)}
              title="Add row at top"
              aria-label="Add row at top"
            >
              <i className="fas fa-plus" aria-hidden="true" />
            </button>
          </div>
        )}

        <div className="workspace-middle-band">
          {/* Left Almost-Full-Height Column Edge Control */}
          {editable && onResizeGrid && (
            <div className="grid-edge-bar grid-edge-vertical">
              <button
                type="button"
                className="edge-btn"
                disabled={!canExpandCols}
                onClick={() => onResizeGrid("left", 1)}
                title="Add column on left"
                aria-label="Add column on left"
              >
                <i className="fas fa-plus" aria-hidden="true" />
              </button>
              <span className="edge-label-vertical">{layout.grid.cols} Cols</span>
              <button
                type="button"
                className="edge-btn"
                disabled={!canShrinkCols}
                onClick={() => onResizeGrid("left", -1)}
                title="Remove left column"
                aria-label="Remove left column"
              >
                <i className="fas fa-minus" aria-hidden="true" />
              </button>
            </div>
          )}

          {/* Side-by-Side Screens Strip (Desktop) / Single Screen Selector (Mobile) */}
          <div className="screens-strip" ref={stripRef}>
            {visibleScreens.map((screen) => {
              const pageIdx = screens.findIndex((s) => s.rank === screen.rank);
              return (
                <ScreenCanvas
                  key={screen.id}
                  screen={screen}
                  pageNumber={pageIdx + 1}
                  isDefault={screen.rank === layout.grid.defaultScreenRank}
                  rows={layout.grid.rows}
                  cols={layout.grid.cols}
                  folderPreviewCols={folderDisplay.previewGridCols}
                  editable={editable}
                  canDelete={screens.length > 1}
                  origin={origin}
                  placedPrimaryKeys={placedPrimaryKeys}
                  dragSession={dragSession}
                  hoverTarget={hoverTarget}
                  onBeginDrag={onBeginDrag}
                  onOpenFolder={onOpenFolderChange}
                  onRemoveScreen={onRemoveScreen}
                />
              );
            })}
          </div>

          {/* Right Almost-Full-Height Column Edge Control */}
          {editable && onResizeGrid && (
            <div className="grid-edge-bar grid-edge-vertical">
              <button
                type="button"
                className="edge-btn"
                disabled={!canExpandCols}
                onClick={() => onResizeGrid("right", 1)}
                title="Add column on right"
                aria-label="Add column on right"
              >
                <i className="fas fa-plus" aria-hidden="true" />
              </button>
              <span className="edge-label-vertical">{layout.grid.cols} Cols</span>
              <button
                type="button"
                className="edge-btn"
                disabled={!canShrinkCols}
                onClick={() => onResizeGrid("right", -1)}
                title="Remove right column"
                aria-label="Remove right column"
              >
                <i className="fas fa-minus" aria-hidden="true" />
              </button>
            </div>
          )}
        </div>

        {/* Bottom Full-Width Row Edge Control */}
        {editable && onResizeGrid && (
          <div className="grid-edge-bar grid-edge-horizontal">
            <button
              type="button"
              className="edge-btn"
              disabled={!canShrinkRows}
              onClick={() => onResizeGrid("bottom", -1)}
              title="Remove bottom row"
              aria-label="Remove bottom row"
            >
              <i className="fas fa-minus" aria-hidden="true" />
            </button>
            <span className="edge-label">Bottom Row ({layout.grid.rows} rows)</span>
            <button
              type="button"
              className="edge-btn"
              disabled={!canExpandRows}
              onClick={() => onResizeGrid("bottom", 1)}
              title="Add row at bottom"
              aria-label="Add row at bottom"
            >
              <i className="fas fa-plus" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {/* Shared Hotseat / Dock with Left & Right Expand/Shrink Controls */}
      <div className="dock-band">
        {editable && onResizeDock && (
          <div className="dock-edge-controls">
            <button
              type="button"
              className="edge-btn"
              disabled={!canExpandDock}
              onClick={() => onResizeDock("left", 1)}
              title="Add dock slot on left"
              aria-label="Add dock slot on left"
            >
              <i className="fas fa-plus" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="edge-btn"
              disabled={!canShrinkDock}
              onClick={() => onResizeDock("left", -1)}
              title="Remove left dock slot"
              aria-label="Remove left dock slot"
            >
              <i className="fas fa-minus" aria-hidden="true" />
            </button>
          </div>
        )}

        <div className="dock-surface" style={{ backgroundImage: "url(/phone_wallpaper.jpg)" }}>
          <div className="dock-surface-overlay">
            <DockArrow />
            <div
              className={`desktop-grid drawer-grid${dragSession && editable ? " drag-active-surface" : ""}`}
              style={{
                width: layout.grid.dockCols * CELL_SIZE,
                height: CELL_SIZE,
                position: "relative",
              }}
            >
              {Array.from({ length: layout.grid.dockCols }, (_, slot) => {
                const slotItem = dockSlotMap.get(slot);
                const isOccupied = Boolean(slotItem);
                const canGroup = Boolean(slotItem && slotItem.kind !== "widget");
                const isSelf = Boolean(dragSession && slotItem?.id === dragSession.item.id);
                const showReplaceHint =
                  editable && Boolean(dragSession) && shiftReplaceActive && isOccupied && !isSelf;
                const showCenterFolderHint =
                  editable &&
                  Boolean(dragSession) &&
                  !shiftReplaceActive &&
                  canDraggedItemGroup &&
                  canGroup &&
                  !isSelf;

                const isHovered =
                  editable &&
                  Boolean(dragSession) &&
                  hoverTarget?.kind === "dock-slot" &&
                  hoverTarget.slot === slot;
                const slotClasses = ["grid-cell-slot"];
                if (isHovered && hoverTarget) {
                  if (!hoverTarget.allowed) {
                    slotClasses.push("drop-blocked");
                  } else if (hoverTarget.action === "replace") {
                    slotClasses.push("drop-replace");
                  } else if (hoverTarget.action === "folder-merge") {
                    slotClasses.push("drop-folder-merge");
                  } else if (
                    (hoverTarget.action === "push" || hoverTarget.action === "swap") &&
                    hoverTarget.effectiveDirection
                  ) {
                    slotClasses.push(`drop-push-${hoverTarget.effectiveDirection}`);
                  } else {
                    slotClasses.push("drop-empty");
                  }
                }
                return (
                  <div
                    key={`dock-slot-${slot}`}
                    className={slotClasses.join(" ")}
                    style={{
                      left: slot * CELL_SIZE,
                      top: 0,
                      width: CELL_SIZE,
                      height: CELL_SIZE,
                    }}
                    data-dock-slot={slot}
                    data-editable={editable ? "true" : "false"}
                    data-occupied={isOccupied ? "true" : "false"}
                    data-can-group={canGroup ? "true" : "false"}
                    data-occupant-id={slotItem?.id}
                  >
                    {showReplaceHint && (
                      <div
                        className={`cell-center-replace-zone${
                          isHovered && hoverTarget?.action === "replace" && hoverTarget.allowed
                            ? " active"
                            : ""
                        }`}
                      >
                        {isHovered && hoverTarget?.action === "replace" && hoverTarget.allowed ? (
                          <span className="replace-merge-pill">
                            <i className="fas fa-exchange-alt me-1" />
                            Replace
                          </span>
                        ) : (
                          <i className="fas fa-exchange-alt" aria-hidden="true" />
                        )}
                      </div>
                    )}
                    {showCenterFolderHint && (
                      <div
                        className={`cell-center-folder-zone${
                          isHovered && hoverTarget?.action === "folder-merge" && hoverTarget.allowed
                            ? " active"
                            : ""
                        }`}
                      >
                        {isHovered &&
                        hoverTarget?.action === "folder-merge" &&
                        hoverTarget.allowed ? (
                          <span className="folder-merge-pill">
                            <i className="fas fa-folder-plus me-1" />
                            Folder
                          </span>
                        ) : (
                          <i className="fas fa-folder-plus" aria-hidden="true" />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {layout.hotseat.map((item) => (
                <GridAppItem
                  key={item.id}
                  item={item}
                  origin={origin}
                  folderPreviewCols={folderDisplay.previewGridCols}
                  isBeingDragged={dragSession?.origin === origin && dragSession.item.id === item.id}
                  alreadyPlaced={!editable && isItemAlreadyInPrimary(item, placedPrimaryKeys)}
                  onBeginDrag={onBeginDrag}
                  onOpenFolder={onOpenFolderChange}
                />
              ))}
            </div>
            <div className="dock-caption">Dock ({layout.grid.dockCols} slots)</div>
          </div>
        </div>

        {editable && onResizeDock && (
          <div className="dock-edge-controls">
            <button
              type="button"
              className="edge-btn"
              disabled={!canExpandDock}
              onClick={() => onResizeDock("right", 1)}
              title="Add dock slot on right"
              aria-label="Add dock slot on right"
            >
              <i className="fas fa-plus" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="edge-btn"
              disabled={!canShrinkDock}
              onClick={() => onResizeDock("right", -1)}
              title="Remove right dock slot"
              aria-label="Remove right dock slot"
            >
              <i className="fas fa-minus" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {/* Screen Navigation Bar + Arrows + Add Page */}
      <div className="screen-nav-bar">
        <div className="btn-group">
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={() => stepScreen(-1)}
            disabled={selectedRank === screens[0]?.rank}
            aria-label="Previous screen"
          >
            <i className="fas fa-chevron-left" aria-hidden="true" />
          </button>
          {screens.map((screen, index) => (
            <button
              key={screen.id}
              type="button"
              className={`btn btn-sm ${
                screen.rank === selectedRank ? "btn-primary active" : "btn-outline-primary"
              }`}
              onClick={() => jumpToScreen(screen.rank)}
            >
              {index + 1}
            </button>
          ))}
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={() => stepScreen(1)}
            disabled={selectedRank === screens[screens.length - 1]?.rank}
            aria-label="Next screen"
          >
            <i className="fas fa-chevron-right" aria-hidden="true" />
          </button>
        </div>

        {editable && onAddScreen && (
          <button
            type="button"
            className="btn btn-sm btn-outline-primary ms-2"
            onClick={onAddScreen}
          >
            <i className="fas fa-plus me-1" aria-hidden="true" />
            Add Page
          </button>
        )}
      </div>

      {/* Collapsible App Drawer / Installed Apps Catalog */}
      {layout.appCatalog && totalCatalogCount > 0 && (
        <details className="app-catalog-drawer mt-3">
          <summary>
            Installed Apps in Backup (
            {isCatalogFiltered
              ? `${filteredCatalog.length} of ${totalCatalogCount}`
              : totalCatalogCount}
            ) — drag any app onto a screen or dock
          </summary>
          <div className="app-catalog-body">
            <div className="app-catalog-toolbar mb-2">
              <input
                type="search"
                className="form-control form-control-sm app-catalog-search"
                placeholder="Search apps by name or package..."
                value={appSearch}
                onChange={(e) => setAppSearch(e.target.value)}
              />
              <div className="app-filter-chips" role="tablist" aria-label="Filter apps by source">
                {APP_CATEGORY_TABS.map((tab) => {
                  const isActive = selectedCategory === tab.key;
                  const count = categoryCounts[tab.key];
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      className={`app-filter-chip${isActive ? " active" : ""}`}
                      title={tab.tooltip}
                      onClick={() => setSelectedCategory(tab.key)}
                    >
                      {tab.label} <span className="chip-count">{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="app-catalog-grid">
              {filteredCatalog.map((app, idx) => {
                const draggableItem = catalogAppToDraggableItem(app, idx);
                const alreadyPlaced = isAppItemPlaced(draggableItem, placedPrimaryKeys);
                return (
                  <div
                    key={`${app.packageName}/${app.activityName}:${app.isWorkProfile ? "w" : "m"}`}
                    className={`app-catalog-chip${alreadyPlaced ? " item-already-placed" : ""}`}
                    onPointerDown={(e) =>
                      attachDragThreshold(e, (cx, cy, shift) =>
                        onBeginDrag("donor", draggableItem, cx, cy, shift),
                      )
                    }
                    title={
                      alreadyPlaced
                        ? `${app.title} (Already on Primary)\n${app.packageName}`
                        : `${app.title}\n${app.packageName}`
                    }
                  >
                    <IconGraphic item={draggableItem} className="catalog-chip-icon" showWorkBadge />
                    <span className="catalog-chip-label">{app.title}</span>
                    {alreadyPlaced && (
                      <span className="catalog-placed-pill" title="Already on Primary">
                        <i className="fas fa-check" aria-hidden="true" />
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </details>
      )}

      {/* Open Folder Modal */}
      {openFolder && (
        <FolderModal
          folder={openFolder}
          openGridCols={openFolderDims.cols}
          openGridRows={openFolderDims.rows}
          gridModeLabel={folderDisplay.summaryLabel}
          readOnly={!editable}
          isHiddenForOutsideDrag={isFolderHiddenDuringOutsideDrag}
          draggingItemId={dragSession?.origin === origin ? dragSession.item.id : undefined}
          hoverTarget={hoverTarget}
          placedPrimaryKeys={placedPrimaryKeys}
          onClose={() => onOpenFolderChange(null)}
          onRename={onRenameFolder}
          onUnwrapSingle={onUnwrapFolder}
          onBeginPointerDrag={(child, cx, cy, shift, cardBounds) =>
            onBeginDrag(origin, child, cx, cy, shift, {
              folderId: openFolder.id,
              cardRect: cardBounds,
              exitedBounds: isIconFullyOutsideRect(cx, cy, cardBounds),
            })
          }
        />
      )}
    </div>
  );
};

export default PagesView;
