export const SAMSUNG_FOLDER_GRIDS = [
  "3X3",
  "3X4",
  "4X4",
  "4X5",
  "5X5",
  "5X6",
  "6X6",
  "6X7",
  "7X7",
] as const;

export type SamsungFolderGrid = (typeof SAMSUNG_FOLDER_GRIDS)[number];

export type NovaFolderStyle = "WINDOW" | "IMMERSIVE";
export type NovaFolderScroll = "VERTICAL" | "HORIZONTAL";

export type NovaFolderPreviewEnum =
  | "GRID"
  | "GRID_PLATFORM"
  | "GRID_9"
  | "RADIAL_5"
  | "RADIAL_9"
  | "LINE"
  | "STACK"
  | "FAN"
  | "FAN_PLATFORM"
  | "FIRST_ITEM_ICON"
  | "DISABLED";

export interface NovaFolderWindowConfig {
  style: NovaFolderStyle;
  rows: number;
  cols: number;
  scrollDirection: NovaFolderScroll;
  rawString?: string;
}

export interface NovaFolderIconConfig {
  preview: NovaFolderPreviewEnum | (string & {});
  /** Preview mini-icon grid dimension (`2` for 2×2 or unsupported styles, `3` for `GRID_9`). */
  previewGridCols: 2 | 3;
  rawString?: string;
}

export function parseSamsungFolderGrid(value: string | undefined): {
  cols: number;
  rows: number;
  normalized: SamsungFolderGrid;
} {
  const match = value?.trim().match(/^(\d+)\s*[xX]\s*(\d+)$/);
  if (match) {
    const cols = Number(match[1]);
    const rows = Number(match[2]);
    return snapToSamsungFolderGrid(cols, rows);
  }
  return { cols: 3, rows: 4, normalized: "3X4" };
}

export function snapToSamsungFolderGrid(
  cols: number,
  rows: number,
): { cols: number; rows: number; normalized: SamsungFolderGrid } {
  let best: SamsungFolderGrid = "3X4";
  let bestDist = Infinity;

  for (const candidate of SAMSUNG_FOLDER_GRIDS) {
    const [cx, cy] = candidate.split("X").map(Number);
    const dist = Math.abs(cx - cols) * 1.1 + Math.abs(cy - rows);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  const [finalCols, finalRows] = best.split("X").map(Number);
  return { cols: finalCols, rows: finalRows, normalized: best };
}

/**
 * Parse Nova's `folder_window_config` colon-delimited preference string:
 * `style:bgAlpha:bgColor:cornerRadiusDp:cardBg:showFolderName:rows:cols:scrollDirection[:shadow:pinToBottom:followNight]`
 * Default in Nova (`Lb10/p0.n`): `WINDOW:255:-1:24:true:true:3:4:HORIZONTAL:true:false:true`
 */
export function parseNovaFolderWindowConfig(raw: unknown): NovaFolderWindowConfig {
  if (typeof raw !== "string" || !raw.trim()) {
    return {
      style: "WINDOW",
      rows: 3,
      cols: 4,
      scrollDirection: "HORIZONTAL",
    };
  }
  const parts = raw.split(":");
  const style: NovaFolderStyle = parts[0]?.toUpperCase() === "IMMERSIVE" ? "IMMERSIVE" : "WINDOW";
  const rows = Math.max(2, Math.min(9, Number(parts[6]) || 3));
  const cols = Math.max(2, Math.min(9, Number(parts[7]) || 4));
  const scrollDirection: NovaFolderScroll =
    parts[8]?.toUpperCase() === "VERTICAL" ? "VERTICAL" : "HORIZONTAL";

  return {
    style,
    rows,
    cols,
    scrollDirection,
    rawString: raw,
  };
}

export function serializeNovaFolderWindowConfig(
  style: NovaFolderStyle,
  rows: number,
  cols: number,
  existingRaw?: string,
  scrollDirection?: NovaFolderScroll,
): string {
  const parts = existingRaw
    ? existingRaw.split(":")
    : [
        "WINDOW",
        "229",
        "#ffffffff",
        "18",
        "true",
        "true",
        "4",
        "4",
        "VERTICAL",
        "true",
        "false",
        "true",
      ];

  while (parts.length < 9) {
    const defaults = ["WINDOW", "255", "-1", "24", "true", "true", "3", "4", "HORIZONTAL"];
    parts.push(defaults[parts.length]);
  }

  parts[0] = style;
  parts[6] = String(Math.max(2, Math.min(9, Math.round(rows))));
  parts[7] = String(Math.max(2, Math.min(9, Math.round(cols))));
  if (scrollDirection) {
    parts[8] = scrollDirection;
  }
  return parts.join(":");
}

/**
 * Parse Nova's `folder_icon_config` colon-delimited preference string:
 * `shape:preview:clipToBounds:color:unusedAlpha:outline:prioritizeFirstIcon`
 * Only `GRID_9` is a 3×3 grid preview; `GRID` / `GRID_PLATFORM` and all non-grid styles
 * (`RADIAL_*`, `STACK`, `FAN`, `LINE`) fall back to 2×2 in the visual grid preview.
 */
export function parseNovaFolderIconConfig(raw: unknown): NovaFolderIconConfig {
  if (typeof raw !== "string" || !raw.trim()) {
    return {
      preview: "GRID",
      previewGridCols: 2,
    };
  }
  const parts = raw.split(":");
  const preview = (parts[1] || "GRID").trim().toUpperCase();
  const previewGridCols: 2 | 3 = preview === "GRID_9" ? 3 : 2;
  return {
    preview,
    previewGridCols,
    rawString: raw,
  };
}

export function serializeNovaFolderIconConfig(
  previewGridCols: 2 | 3,
  existingRaw?: string,
): string {
  const targetEnum = previewGridCols === 3 ? "GRID_9" : "GRID";
  if (existingRaw && existingRaw.includes(":")) {
    const parts = existingRaw.split(":");
    parts[1] = targetEnum;
    return parts.join(":");
  }
  return `ROUNDED_SQUARE:${targetEnum}:true:#40302:0:false:false`;
}

/**
 * Exact Nova Launcher `FolderGridOrganizer` (`Lz9/r.c(itemCount)`) shrink algorithm
 * used when `folder_window_config` style is `WINDOW`.
 */
export function computeNovaWindowFolderDimensions(
  itemCount: number,
  maxCols = 4,
  maxRows = 4,
): { cols: number; rows: number } {
  const count = Math.max(1, itemCount);
  const capX = Math.max(2, maxCols);
  const capY = Math.max(2, maxRows);

  if (count >= capX * capY) {
    return { cols: capX, rows: capY };
  }

  let x = 0;
  let y = 0;
  for (let guard = 0; guard < 32; guard += 1) {
    const prevX = x;
    const prevY = y;

    if (x * y < count) {
      if ((x <= y || y === capY) && x < capX) {
        x += 1;
      } else if (y < capY) {
        y += 1;
      }
      if (y === 0) {
        y = 1;
      }
    } else if ((y - 1) * x >= count && y >= x) {
      y -= 1;
    } else if ((x - 1) * y >= count) {
      x -= 1;
    }

    if (x === prevX && y === prevY) {
      break;
    }
  }

  return {
    cols: Math.max(1, x),
    rows: Math.max(1, y),
  };
}

export interface EffectiveFolderDisplayConfig {
  /** Number of columns in the open folder modal for a folder with `itemCount` children. */
  resolveOpenGrid: (itemCount: number) => { cols: number; rows: number; pageSize: number };
  /** Mini-icon grid dimension (`2`..`5`) inside closed 1×1 folder icons on home/dock. */
  previewGridCols: 2 | 3 | 4 | 5;
  summaryLabel: string;
}

export function buildEffectiveFolderDisplayConfig(params: {
  targetFormat: "samsung" | "nova";
  samsungFolderGrid: SamsungFolderGrid;
  samsungPreviewCols: 2 | 3 | 4 | 5;
  novaStyle: NovaFolderStyle;
  novaRows: number;
  novaCols: number;
  novaPreviewCols: 2 | 3;
}): EffectiveFolderDisplayConfig {
  if (params.targetFormat === "samsung") {
    const { cols, rows, normalized } = parseSamsungFolderGrid(params.samsungFolderGrid);
    return {
      resolveOpenGrid: () => ({ cols, rows, pageSize: cols * rows }),
      previewGridCols: params.samsungPreviewCols,
      summaryLabel: `${normalized.replace("X", "×")} folder (${params.samsungPreviewCols}×${params.samsungPreviewCols} icon)`,
    };
  }

  if (params.novaStyle === "IMMERSIVE") {
    const cols = Math.max(2, Math.min(7, params.novaCols));
    const rows = Math.max(2, Math.min(7, params.novaRows));
    return {
      resolveOpenGrid: () => ({ cols, rows, pageSize: cols * rows }),
      previewGridCols: params.novaPreviewCols,
      summaryLabel: `Immersive ${cols}×${rows} (${params.novaPreviewCols}×${params.novaPreviewCols} icon)`,
    };
  }

  // Nova WINDOW mode shrinks dynamically up to 4×4 max viewport capacity
  return {
    resolveOpenGrid: (itemCount: number) => {
      const { cols, rows } = computeNovaWindowFolderDimensions(itemCount, 4, 4);
      return { cols, rows, pageSize: 16 };
    },
    previewGridCols: params.novaPreviewCols,
    summaryLabel: `Window auto ≤4×4 (${params.novaPreviewCols}×${params.novaPreviewCols} icon)`,
  };
}
