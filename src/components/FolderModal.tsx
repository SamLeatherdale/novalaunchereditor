import React, { useRef } from "react";
import { isAppItemPlaced } from "../core/editor/layoutOperations";
import type { FolderItem, LayoutItem } from "../core/model/types";
import { IconGraphic } from "./IconGraphic";
import type { FolderCardBounds, HoverTargetState } from "./PointerDragLayer";

interface FolderModalProps {
  folder: FolderItem;
  openGridCols: number;
  openGridRows: number;
  gridModeLabel?: string;
  readOnly?: boolean;
  isHiddenForOutsideDrag?: boolean;
  draggingItemId?: string;
  hoverTarget: HoverTargetState | null;
  placedPrimaryKeys?: Set<string>;
  onClose: () => void;
  onRename?: (folderId: string, newTitle: string) => void;
  onUnwrapSingle?: (folderId: string) => void;
  onBeginPointerDrag: (
    item: LayoutItem,
    clientX: number,
    clientY: number,
    shiftKey: boolean,
    cardBounds: FolderCardBounds,
  ) => void;
}

const FolderModal: React.FC<FolderModalProps> = ({
  folder,
  openGridCols,
  openGridRows,
  gridModeLabel,
  readOnly = false,
  isHiddenForOutsideDrag = false,
  draggingItemId,
  hoverTarget,
  placedPrimaryKeys,
  onClose,
  onRename,
  onUnwrapSingle,
  onBeginPointerDrag,
}) => {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef<{
    item: LayoutItem;
    startX: number;
    startY: number;
    pointerId: number;
  } | null>(null);

  const cols = Math.max(1, Math.min(7, openGridCols));
  const rows = Math.max(1, Math.min(7, openGridRows));
  const pageSize = Math.max(1, cols * rows);
  const totalPages = Math.max(1, Math.ceil(folder.children.length / pageSize));
  const modalMaxWidth = Math.min(620, Math.max(336, cols * 78 + 44));
  const showUnwrapSingle = !readOnly && folder.children.length === 1 && Boolean(onUnwrapSingle);
  const showSubheader = Boolean(gridModeLabel) || showUnwrapSingle;

  return (
    <div
      className={`folder-modal-backdrop${
        isHiddenForOutsideDrag ? " folder-hidden-during-drag" : ""
      }`}
      onClick={onClose}
    >
      <div
        ref={cardRef}
        className="folder-modal-card"
        style={{ width: `min(${modalMaxWidth}px, 94vw)` }}
        data-drop-zone={!readOnly ? "folder-interior" : undefined}
        data-folder-id={!readOnly ? folder.id : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="folder-modal-header">
          {readOnly ? (
            <h5 className="folder-title-readonly mb-0">{folder.title || "Unnamed Folder"}</h5>
          ) : (
            <input
              type="text"
              className="folder-title-input"
              aria-label="Folder name"
              placeholder="Unnamed Folder"
              value={folder.title}
              onChange={(e) => onRename?.(folder.id, e.target.value)}
            />
          )}
          <button
            type="button"
            className="btn btn-sm btn-outline-light folder-close-btn"
            onClick={onClose}
            aria-label="Close folder"
          >
            <i className="fas fa-times" aria-hidden="true" />
          </button>
        </div>

        {showSubheader && (
          <div className="folder-modal-subheader">
            {gridModeLabel && (
              <span className="folder-grid-pill" title="Target folder interior grid">
                <i className="fas fa-th me-1" aria-hidden="true" />
                {cols} × {rows} grid
              </span>
            )}
            {showUnwrapSingle && onUnwrapSingle && (
              <button
                type="button"
                className="btn btn-sm btn-outline-info"
                onClick={() => {
                  onUnwrapSingle(folder.id);
                  onClose();
                }}
                title="Replace this 1-item folder with the standalone app icon"
              >
                <i className="fas fa-compress-arrows-alt me-1" aria-hidden="true" />
                Unwrap single icon
              </button>
            )}
          </div>
        )}

        <div className="folder-modal-hints">
          {readOnly ? (
            <>
              <span>
                <i className="fas fa-hand-rock me-1" />
                Drag any icon outside up into Primary
              </span>
              <span>
                <i className="fas fa-times-circle me-1" />
                Drop on empty space or press <kbd>Esc</kbd> to cancel
              </span>
            </>
          ) : (
            <>
              <span>
                <i className="fas fa-pen me-1" />
                Edit title above
              </span>
              <span>
                <i className="fas fa-arrows-alt me-1" />
                Drag inside to reorder
              </span>
              <span>
                <i className="fas fa-external-link-alt me-1" />
                Drag outside onto screen or dock (<kbd>Esc</kbd> to cancel)
              </span>
            </>
          )}
        </div>

        <div
          className="folder-modal-pages"
          data-drop-zone={!readOnly ? "folder-interior" : undefined}
          data-folder-id={!readOnly ? folder.id : undefined}
        >
          {Array.from({ length: totalPages }, (_, pageIdx) => {
            const startIdx = pageIdx * pageSize;
            const pageItems = folder.children.slice(startIdx, startIdx + pageSize);

            return (
              <div key={`folder-page-${pageIdx}`} className="folder-page-section">
                {totalPages > 1 && (
                  <div className="folder-page-divider">
                    Folder Page {pageIdx + 1} of {totalPages} ({cols}×{rows})
                  </div>
                )}
                <div
                  className="folder-modal-grid"
                  style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
                  data-drop-zone={!readOnly ? "folder-interior" : undefined}
                  data-folder-id={!readOnly ? folder.id : undefined}
                >
                  {pageItems.map((child, localIdx) => {
                    const idx = startIdx + localIdx;
                    const alreadyPlaced = readOnly && isAppItemPlaced(child, placedPrimaryKeys);
                    const isBeingDragged = draggingItemId === child.id;
                    const isDropBefore =
                      !readOnly &&
                      !isHiddenForOutsideDrag &&
                      hoverTarget?.kind === "folder-item" &&
                      hoverTarget.folderId === folder.id &&
                      hoverTarget.folderItemIndex === idx;

                    return (
                      <div
                        key={child.id}
                        className={`folder-modal-item${isDropBefore ? " drop-before" : ""}${
                          alreadyPlaced ? " item-already-placed" : ""
                        }${isBeingDragged ? " item-dragging-source" : ""}`}
                        data-folder-id={!readOnly ? folder.id : undefined}
                        data-folder-child-index={!readOnly ? idx : undefined}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          e.preventDefault();
                          pendingRef.current = {
                            item: child,
                            startX: e.clientX,
                            startY: e.clientY,
                            pointerId: e.pointerId,
                          };
                          const onMove = (me: PointerEvent) => {
                            const p = pendingRef.current;
                            if (!p || me.pointerId !== p.pointerId) return;
                            if (Math.hypot(me.clientX - p.startX, me.clientY - p.startY) >= 5) {
                              pendingRef.current = null;
                              window.removeEventListener("pointermove", onMove);
                              window.removeEventListener("pointerup", onUp);
                              const rawRect = cardRef.current?.getBoundingClientRect();
                              const bounds: FolderCardBounds = rawRect
                                ? {
                                    left: rawRect.left,
                                    top: rawRect.top,
                                    right: rawRect.right,
                                    bottom: rawRect.bottom,
                                  }
                                : { left: 0, top: 0, right: 0, bottom: 0 };
                              onBeginPointerDrag(
                                p.item,
                                me.clientX,
                                me.clientY,
                                me.shiftKey,
                                bounds,
                              );
                            }
                          };
                          const onUp = () => {
                            pendingRef.current = null;
                            window.removeEventListener("pointermove", onMove);
                            window.removeEventListener("pointerup", onUp);
                          };
                          window.addEventListener("pointermove", onMove);
                          window.addEventListener("pointerup", onUp);
                        }}
                        title={
                          alreadyPlaced
                            ? `${child.title} (Already on Primary)`
                            : child.isWorkProfile
                              ? `${child.title} (Work Profile)`
                              : child.title
                        }
                      >
                        <div className="position-relative">
                          <IconGraphic item={child} showWorkBadge />
                          {alreadyPlaced && (
                            <span className="placed-check-badge" title="Already on Primary">
                              <i className="fas fa-check" aria-hidden="true" />
                            </span>
                          )}
                        </div>
                        <div className="grid-app-title">{child.title}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default FolderModal;
