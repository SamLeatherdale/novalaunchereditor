import React, { useEffect, useMemo, useState } from "react";
import {
  formatBackupDate,
  formatRelativeTimeAgo,
  type SavedWorkspaceRecord,
} from "../core/persistence";

interface LoadSaveModalProps {
  saves: SavedWorkspaceRecord[];
  onLoadSave: (record: SavedWorkspaceRecord) => void;
  onDeleteSave: (id: string) => void;
  onClose: () => void;
}

const SavePreviewThumb: React.FC<{ bytes?: Uint8Array }> = ({ bytes }) => {
  const url = useMemo(() => {
    if (!bytes || bytes.byteLength === 0) return undefined;
    return URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: "image/png" }));
  }, [bytes]);

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  if (!url) {
    return (
      <div className="save-card-thumb save-card-thumb-placeholder">
        <i className="fas fa-mobile-alt" />
      </div>
    );
  }

  return <img src={url} alt="" className="save-card-thumb" />;
};

const LoadSaveModal: React.FC<LoadSaveModalProps> = ({
  saves,
  onLoadSave,
  onDeleteSave,
  onClose,
}) => {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="folder-modal-backdrop" onClick={onClose}>
      <div
        className="help-modal-card saves-modal-card"
        role="dialog"
        aria-modal="true"
        aria-label="Saved Workspaces"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="folder-modal-header mb-3">
          <h5 className="mb-0">Saved Workspaces ({saves.length})</h5>
          <button
            type="button"
            className="btn btn-sm btn-outline-light ms-2"
            onClick={onClose}
            aria-label="Close saved workspaces"
          >
            <i className="fas fa-times" aria-hidden="true" />
          </button>
        </div>

        {saves.length === 0 ? (
          <p className="text-muted mb-0">
            No saved workspaces yet. Your edits autosave automatically once you load a backup, or
            you can create named snapshots under the <strong>Save Snapshot</strong> tab.
          </p>
        ) : (
          <div className="saves-list">
            {saves.map((save) => {
              const title = save.isAutosave
                ? "Autosave"
                : save.name.trim() || save.sourceFilename || "Unnamed Save";
              const origDateStr = save.originalBackupTimestamp
                ? formatBackupDate(save.originalBackupTimestamp)
                : "Unknown backup date";
              const relModified = formatRelativeTimeAgo(save.updatedAt, nowMs);

              return (
                <div
                  key={save.id}
                  className={`save-entry-card${save.isAutosave ? " save-entry-autosave" : ""}`}
                >
                  <SavePreviewThumb bytes={save.previewPngBytes} />
                  <div className="save-entry-meta">
                    <div className="save-entry-title-row">
                      <strong className="save-entry-title">{title}</strong>
                      {save.isAutosave && <span className="save-autosave-badge">Auto</span>}
                      <span className={`format-badge format-${save.sourceFormat}`}>
                        {save.sourceFormat === "nova" ? "Nova" : "Samsung"}
                      </span>
                    </div>
                    <div className="save-entry-sub">
                      <span title="Source backup file">
                        <i className="fas fa-file-archive me-1" />
                        {save.sourceFilename}
                      </span>
                      {save.donorFilename && (
                        <span title="Bundled reference backup">
                          <i className="fas fa-layer-group me-1" aria-hidden="true" />
                          Ref: {save.donorFilename}
                        </span>
                      )}
                    </div>
                    <div className="save-entry-timestamps">
                      <span>
                        Original backup: <strong>{origDateStr}</strong>
                      </span>
                      <span className="save-dot">•</span>
                      <span>
                        Modified <strong>{relModified}</strong>
                      </span>
                    </div>
                  </div>
                  <div className="save-entry-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => onLoadSave(save)}
                    >
                      Load
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-danger"
                      onClick={() => onDeleteSave(save.id)}
                      title="Delete this saved workspace"
                      aria-label={`Delete ${title}`}
                    >
                      <i className="fas fa-trash-alt" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default LoadSaveModal;
