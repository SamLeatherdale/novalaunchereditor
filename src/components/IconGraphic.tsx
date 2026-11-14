import React, { useEffect, useState } from "react";
import type { LayoutItem } from "../core/model/types";

export const IconGraphic: React.FC<{
  item: LayoutItem;
  className?: string;
  showWorkBadge?: boolean;
}> = ({ item, className = "grid-app-icon", showWorkBadge = false }) => {
  const [blobUrl, setBlobUrl] = useState<string>();
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!item.iconBytes || item.iconBytes.byteLength === 0) {
      setBlobUrl(undefined);
      return;
    }
    const objectUrl = URL.createObjectURL(
      new Blob([item.iconBytes as unknown as BlobPart], { type: "image/png" }),
    );
    setBlobUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [item.iconBytes]);

  const hasEmbeddedBytes = Boolean(item.iconBytes && item.iconBytes.byteLength > 0);
  const remoteIconUrl =
    !hasEmbeddedBytes && item.iconUrl && failedIconUrl !== item.iconUrl ? item.iconUrl : undefined;
  const showFallback = !blobUrl && !remoteIconUrl;
  const fallbackInitial = (item.title || item.packageName || "?").trim().charAt(0).toUpperCase();
  const showPwaBadge =
    showWorkBadge &&
    item.packageName.startsWith("org.chromium.webapk.") &&
    !hasEmbeddedBytes &&
    !item.isWorkProfile;

  return (
    <div
      className={`${className}${showFallback ? " grid-app-icon-fallback" : ""}`}
      style={blobUrl ? { backgroundImage: `url(${blobUrl})` } : undefined}
    >
      {remoteIconUrl && (
        <img
          src={remoteIconUrl}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          decoding="async"
          draggable={false}
          className="grid-app-icon-img"
          onError={() => setFailedIconUrl(remoteIconUrl)}
        />
      )}
      {showFallback && <span className="icon-fallback-letter">{fallbackInitial}</span>}
      {showWorkBadge && item.isWorkProfile && (
        <span className="work-profile-badge" title="Work Profile app">
          <i className="fas fa-briefcase" />
        </span>
      )}
      {showPwaBadge && (
        <span className="pwa-chrome-badge" title="Installed Web App (PWA)">
          <i className="fab fa-chrome" aria-hidden="true" />
        </span>
      )}
    </div>
  );
};
