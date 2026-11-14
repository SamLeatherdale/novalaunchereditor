import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import {
  evaluateDropOutcome,
  type DropTarget,
  type PushDirection,
} from "../core/editor/layoutOperations";
import type { LauncherLayout, LayoutItem } from "../core/model/types";
import { IconGraphic } from "./IconGraphic";

export interface FolderCardBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FolderModalDragContext {
  folderId: string;
  cardRect: FolderCardBounds;
  exitedBounds: boolean;
}

export interface PointerDragSession {
  origin: "primary" | "donor";
  item: LayoutItem;
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  folderModal?: FolderModalDragContext;
}

export interface HoverTargetState {
  kind: "desktop-cell" | "dock-slot" | "trash" | "folder-interior" | "folder-item";
  screenRank?: number;
  cellX?: number;
  cellY?: number;
  slot?: number;
  folderId?: string;
  folderItemIndex?: number;
  occupied?: boolean;
  mergeIntoFolder?: boolean;
  replaceOccupant?: boolean;
  pushDirection?: PushDirection;
  /** Pre-validated against `primaryLayout`: false when the drop would be rejected! */
  allowed: boolean;
  action?:
    | "empty"
    | "push"
    | "swap"
    | "replace"
    | "folder-merge"
    | "folder-reorder"
    | "trash"
    | "rejected";
  effectiveDirection?: PushDirection;
  rejectionReason?: string;
}

const FOLDER_ICON_HALF_SIZE = 22;

/**
 * Center 44% (`|offset| < 0.22`) of an occupied 1×1 icon/folder cell merges into a folder,
 * leaving 28% outer side bands on every edge for directional push/swap.
 */
const CENTER_FOLDER_RADIUS = 0.22;

export function isIconFullyOutsideRect(
  clientX: number,
  clientY: number,
  rect: FolderCardBounds,
): boolean {
  return (
    clientX + FOLDER_ICON_HALF_SIZE < rect.left ||
    clientX - FOLDER_ICON_HALF_SIZE > rect.right ||
    clientY + FOLDER_ICON_HALF_SIZE < rect.top ||
    clientY - FOLDER_ICON_HALF_SIZE > rect.bottom
  );
}

export function hoverToDropTarget(hover: HoverTargetState | null): DropTarget | "trash" | null {
  if (!hover) return null;
  if (hover.kind === "trash") return "trash";
  if (hover.kind === "folder-item" && hover.folderId) {
    return {
      kind: "folder-interior",
      folderId: hover.folderId,
      index: hover.folderItemIndex,
    };
  }
  if (hover.kind === "folder-interior" && hover.folderId) {
    return {
      kind: "folder-interior",
      folderId: hover.folderId,
    };
  }
  if (hover.kind === "dock-slot" && typeof hover.slot === "number") {
    return {
      kind: "dock-slot",
      slot: hover.slot,
      pushDirection: hover.pushDirection === "left" ? "left" : "right",
      mergeIntoFolder: Boolean(hover.mergeIntoFolder),
      replaceOccupant: Boolean(hover.replaceOccupant),
    };
  }
  if (
    hover.kind === "desktop-cell" &&
    typeof hover.screenRank === "number" &&
    typeof hover.cellX === "number" &&
    typeof hover.cellY === "number"
  ) {
    return {
      kind: "desktop-cell",
      screenRank: hover.screenRank,
      cellX: hover.cellX,
      cellY: hover.cellY,
      pushDirection: hover.pushDirection,
      mergeIntoFolder: Boolean(hover.mergeIntoFolder),
      replaceOccupant: Boolean(hover.replaceOccupant),
    };
  }
  return null;
}

function validateHoverAgainstLayout(
  rawHover: HoverTargetState | null,
  session: PointerDragSession,
  primaryLayout: LauncherLayout | undefined,
): HoverTargetState | null {
  if (!rawHover) return null;
  if (rawHover.kind === "trash") {
    const allowed = session.origin === "primary";
    return {
      ...rawHover,
      allowed,
      action: allowed ? "trash" : "rejected",
      rejectionReason: allowed ? undefined : "Reference items are not on your Primary workspace.",
    };
  }
  if (!primaryLayout) return rawHover;

  const target = hoverToDropTarget(rawHover);
  if (!target || target === "trash") return rawHover;

  const dragSource =
    session.origin === "primary"
      ? ({ origin: "primary", itemId: session.item.id } as const)
      : ({ origin: "donor", item: session.item } as const);

  const outcome = evaluateDropOutcome(primaryLayout, dragSource, target);
  return {
    ...rawHover,
    allowed: outcome.accepted,
    action: outcome.action,
    effectiveDirection: outcome.effectiveDirection ?? rawHover.pushDirection,
    rejectionReason: outcome.rejectionReason,
  };
}

function resolveRawHoverFromPoint(
  clientX: number,
  clientY: number,
  shiftKey: boolean,
  draggingItem: LayoutItem,
  folderModal?: FolderModalDragContext,
): HoverTargetState | null {
  const insideOpenModal = Boolean(folderModal && !folderModal.exitedBounds);
  const exitedModal = Boolean(folderModal?.exitedBounds);
  const canDragIntoFolder = draggingItem.kind !== "widget";

  const elements = document.elementsFromPoint(clientX, clientY);
  for (const el of elements) {
    if (!(el instanceof HTMLElement)) continue;

    if (!exitedModal) {
      if (el.dataset.folderChildIndex && el.dataset.folderId) {
        return {
          kind: "folder-item",
          folderId: el.dataset.folderId,
          folderItemIndex: Number(el.dataset.folderChildIndex),
          allowed: true,
        };
      }

      if (el.dataset.dropZone === "folder-interior" && el.dataset.folderId) {
        return {
          kind: "folder-interior",
          folderId: el.dataset.folderId,
          allowed: true,
        };
      }
    }

    if (insideOpenModal) {
      continue;
    }

    if (el.dataset.dropZone === "trash") {
      return { kind: "trash", allowed: true };
    }

    if (el.dataset.dockSlot !== undefined && el.dataset.editable === "true") {
      const slot = Number(el.dataset.dockSlot);
      const occupied = el.dataset.occupied === "true";
      const occupantIsSelf = el.dataset.occupantId === draggingItem.id;
      const canGroup = el.dataset.canGroup === "true" && !occupantIsSelf;
      const rect = el.getBoundingClientRect();
      const relX = (clientX - rect.left) / Math.max(1, rect.width) - 0.5;
      const replaceOccupant = occupied && !occupantIsSelf && shiftKey;
      const inCenterZone = Math.abs(relX) < CENTER_FOLDER_RADIUS;
      const mergeIntoFolder =
        !replaceOccupant && occupied && canDragIntoFolder && canGroup && inCenterZone;
      const pushDirection: PushDirection = relX < 0 ? "right" : "left";
      return {
        kind: "dock-slot",
        slot,
        occupied,
        mergeIntoFolder,
        replaceOccupant,
        pushDirection,
        allowed: true,
      };
    }

    if (el.dataset.cell && el.dataset.editable === "true") {
      const [sr, cx, cy] = el.dataset.cell.split(":").map(Number);
      const occupied = el.dataset.occupied === "true";
      const occupantIsSelf = el.dataset.occupantId === draggingItem.id;
      const canGroup = el.dataset.canGroup === "true" && !occupantIsSelf;
      const rect = el.getBoundingClientRect();
      const relX = (clientX - rect.left) / Math.max(1, rect.width) - 0.5;
      const relY = (clientY - rect.top) / Math.max(1, rect.height) - 0.5;
      const replaceOccupant = occupied && !occupantIsSelf && shiftKey;
      const inCenterZone =
        Math.abs(relX) < CENTER_FOLDER_RADIUS && Math.abs(relY) < CENTER_FOLDER_RADIUS;
      const mergeIntoFolder =
        !replaceOccupant && occupied && canDragIntoFolder && canGroup && inCenterZone;
      const pushDirection: PushDirection =
        Math.abs(relX) >= Math.abs(relY) ? (relX < 0 ? "right" : "left") : relY < 0 ? "down" : "up";
      return {
        kind: "desktop-cell",
        screenRank: sr,
        cellX: cx,
        cellY: cy,
        occupied,
        mergeIntoFolder,
        replaceOccupant,
        pushDirection,
        allowed: true,
      };
    }
  }
  return null;
}

export function resolveDragCursor(
  session: PointerDragSession,
  hover: HoverTargetState | null,
): string {
  if (!hover) {
    return session.origin === "donor" ? "copy" : "grabbing";
  }
  if (!hover.allowed) {
    return "no-drop";
  }
  if (hover.kind === "trash" || hover.action === "replace") {
    return "pointer";
  }
  if (hover.action === "folder-merge" || hover.action === "folder-reorder") {
    return session.origin === "donor" ? "copy" : "cell";
  }
  if (hover.action === "push" || hover.action === "swap") {
    switch (hover.effectiveDirection) {
      case "up":
        return "n-resize";
      case "down":
        return "s-resize";
      case "left":
        return "w-resize";
      case "right":
        return "e-resize";
      default:
        break;
    }
  }
  return session.origin === "donor" ? "copy" : "grabbing";
}

interface PointerDragLayerProps {
  session: PointerDragSession;
  hoverTarget: HoverTargetState | null;
  primaryLayout?: LauncherLayout;
  folderPreviewCols?: 2 | 3 | 4 | 5;
  onUpdate: (next: PointerDragSession, hover: HoverTargetState | null) => void;
  onCommit: (finalSession: PointerDragSession, hover: HoverTargetState | null) => void;
  onCancel: () => void;
}

export const PointerDragLayer: React.FC<PointerDragLayerProps> = ({
  session,
  hoverTarget,
  primaryLayout,
  folderPreviewCols = 2,
  onUpdate,
  onCommit,
  onCancel,
}) => {
  const activeCursor = resolveDragCursor(session, hoverTarget);

  useEffect(() => {
    const prevBodyCursor = document.body.style.cursor;
    document.body.style.cursor = activeCursor;
    return () => {
      document.body.style.cursor = prevBodyCursor;
    };
  }, [activeCursor]);

  useEffect(() => {
    const computeUpdatedFolderModal = (
      clientX: number,
      clientY: number,
    ): FolderModalDragContext | undefined => {
      if (!session.folderModal) return undefined;
      if (session.folderModal.exitedBounds) return session.folderModal;
      const exited = isIconFullyOutsideRect(clientX, clientY, session.folderModal.cardRect);
      return exited ? { ...session.folderModal, exitedBounds: true } : session.folderModal;
    };

    const evaluatePoint = (
      clientX: number,
      clientY: number,
      shiftKey: boolean,
    ): { nextSession: PointerDragSession; hover: HoverTargetState | null } => {
      const nextFolderModal = computeUpdatedFolderModal(clientX, clientY);
      const nextSession: PointerDragSession = {
        ...session,
        clientX,
        clientY,
        shiftKey,
        folderModal: nextFolderModal,
      };
      const rawHover = resolveRawHoverFromPoint(
        clientX,
        clientY,
        shiftKey,
        session.item,
        nextFolderModal,
      );
      const hover = validateHoverAgainstLayout(rawHover, nextSession, primaryLayout);
      return { nextSession, hover };
    };

    const onPointerMove = (e: PointerEvent): void => {
      const { nextSession, hover } = evaluatePoint(e.clientX, e.clientY, e.shiftKey);
      onUpdate(nextSession, hover);
    };

    const onPointerUp = (e: PointerEvent): void => {
      const { nextSession, hover } = evaluatePoint(e.clientX, e.clientY, e.shiftKey);
      onCommit(nextSession, hover);
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onCancel();
        return;
      }
      if (e.key === "Shift" && !session.shiftKey) {
        const { nextSession, hover } = evaluatePoint(session.clientX, session.clientY, true);
        onUpdate(nextSession, hover);
      }
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === "Shift" && session.shiftKey) {
        const { nextSession, hover } = evaluatePoint(session.clientX, session.clientY, false);
        onUpdate(nextSession, hover);
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [session, primaryLayout, onUpdate, onCommit, onCancel]);

  const item = session.item;
  const maxMini = folderPreviewCols * folderPreviewCols;
  const isRejected = Boolean(hoverTarget && !hoverTarget.allowed);
  const isFolderMerge = hoverTarget?.allowed && hoverTarget.action === "folder-merge";
  const isReplace = Boolean(
    (hoverTarget?.allowed && hoverTarget.action === "replace") || session.shiftKey,
  );

  return createPortal(
    <div
      className={`floating-drag-ghost${isRejected ? " ghost-rejected" : ""}`}
      style={{
        transform: `translate3d(${session.clientX + 8}px, ${session.clientY + 8}px, 0)`,
      }}
    >
      <div className="ghost-icon-body">
        {item.kind === "folder" ? (
          <div className="grid-app-icon ghost-folder-shell">
            <div
              className="grid-folder-container"
              style={{
                gridTemplateColumns: `repeat(${folderPreviewCols}, 1fr)`,
                gridTemplateRows: `repeat(${folderPreviewCols}, 1fr)`,
              }}
            >
              {item.children.slice(0, maxMini).map((child) => (
                <IconGraphic item={child} className="grid-folder-item" key={child.id} />
              ))}
            </div>
          </div>
        ) : item.kind === "widget" ? (
          <div className="ghost-widget-pill">
            <i className="fas fa-th-large me-1" />
            {item.title}
          </div>
        ) : (
          <IconGraphic item={item} showWorkBadge />
        )}
        {item.kind !== "widget" && (
          <div className="ghost-drag-label">{item.title || "Unnamed"}</div>
        )}
      </div>
      {isReplace && !isRejected && (
        <span className="ghost-replace-badge">
          <i className="fas fa-exchange-alt me-1" />
          Replace
        </span>
      )}
      {isFolderMerge && !isReplace && (
        <span className="ghost-shift-badge">
          <i className="fas fa-folder-plus me-1" />
          Folder
        </span>
      )}
      {isRejected && (
        <span className="ghost-rejected-badge">
          <i className="fas fa-ban me-1" />
          Blocked
        </span>
      )}
    </div>,
    document.body,
  );
};
