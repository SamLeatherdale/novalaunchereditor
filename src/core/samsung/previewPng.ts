import type { LauncherLayout, LayoutItem } from "../model/types";

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32BE(value: number): Uint8Array {
  const out = new Uint8Array(4);
  const view = new DataView(out.buffer);
  view.setUint32(0, value >>> 0, false);
  return out;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);

  const chunk = new Uint8Array(4 + body.length + 4);
  chunk.set(uint32BE(data.length), 0);
  chunk.set(body, 4);
  chunk.set(uint32BE(crc32(body)), 4 + body.length);
  return chunk;
}

async function zlibCompress(raw: Uint8Array): Promise<Uint8Array> {
  const blob = new Blob([raw as unknown as BlobPart]);
  const stream = blob.stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function zlibDecompress(compressed: Uint8Array): Promise<Uint8Array> {
  const blob = new Blob([compressed as unknown as BlobPart]);
  const stream = blob.stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode a non-interlaced 8-bit PNG (`RGBA`, `RGB`, `Grayscale`, `Grayscale+Alpha`, or `Indexed`)
 * into an RGBA pixel buffer using Web Streams `DecompressionStream("deflate")`.
 */
async function decodePng(bytes: Uint8Array): Promise<DecodedImage | undefined> {
  if (bytes.byteLength < 33) return undefined;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return undefined;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | undefined;
  let paletteAlpha: Uint8Array | undefined;
  const idatParts: Uint8Array[] = [];

  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.byteLength) break;
    const chunkData = bytes.subarray(dataStart, dataEnd);

    if (type === "IHDR" && length >= 13) {
      width = view.getUint32(dataStart, false);
      height = view.getUint32(dataStart + 4, false);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
      interlace = chunkData[12];
    } else if (type === "PLTE") {
      palette = chunkData;
    } else if (type === "tRNS") {
      paletteAlpha = chunkData;
    } else if (type === "IDAT") {
      idatParts.push(chunkData);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0 || bitDepth !== 8 || interlace !== 0 || idatParts.length === 0) {
    return undefined;
  }

  const bpp =
    colorType === 6
      ? 4
      : colorType === 2
        ? 3
        : colorType === 4
          ? 2
          : colorType === 0 || colorType === 3
            ? 1
            : 0;
  if (bpp === 0) return undefined;

  const totalIdat = idatParts.reduce((sum, part) => sum + part.byteLength, 0);
  const combinedIdat = new Uint8Array(totalIdat);
  let pos = 0;
  for (const part of idatParts) {
    combinedIdat.set(part, pos);
    pos += part.byteLength;
  }

  let inflated: Uint8Array;
  try {
    inflated = await zlibDecompress(combinedIdat);
  } catch {
    return undefined;
  }

  const stride = width * bpp;
  if (inflated.byteLength < (stride + 1) * height) return undefined;

  const recon = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * (stride + 1)];
    const srcRow = y * (stride + 1) + 1;
    const dstRow = y * stride;
    const prevRow = (y - 1) * stride;

    for (let i = 0; i < stride; i += 1) {
      const raw = inflated[srcRow + i];
      const a = i >= bpp ? recon[dstRow + i - bpp] : 0;
      const b = y > 0 ? recon[prevRow + i] : 0;
      const c = y > 0 && i >= bpp ? recon[prevRow + i - bpp] : 0;

      if (filter === 0) recon[dstRow + i] = raw;
      else if (filter === 1) recon[dstRow + i] = (raw + a) & 0xff;
      else if (filter === 2) recon[dstRow + i] = (raw + b) & 0xff;
      else if (filter === 3) recon[dstRow + i] = (raw + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) recon[dstRow + i] = (raw + paethPredictor(a, b, c)) & 0xff;
      else return undefined;
    }
  }

  if (colorType === 6) {
    return { width, height, rgba: recon };
  }

  const rgba = new Uint8Array(width * height * 4);
  const pixelCount = width * height;
  for (let p = 0; p < pixelCount; p += 1) {
    const out = p * 4;
    if (colorType === 2) {
      rgba[out] = recon[p * 3];
      rgba[out + 1] = recon[p * 3 + 1];
      rgba[out + 2] = recon[p * 3 + 2];
      rgba[out + 3] = 255;
    } else if (colorType === 4) {
      const g = recon[p * 2];
      rgba[out] = g;
      rgba[out + 1] = g;
      rgba[out + 2] = g;
      rgba[out + 3] = recon[p * 2 + 1];
    } else if (colorType === 0) {
      const g = recon[p];
      rgba[out] = g;
      rgba[out + 1] = g;
      rgba[out + 2] = g;
      rgba[out + 3] = 255;
    } else if (colorType === 3 && palette) {
      const idx = recon[p];
      rgba[out] = palette[idx * 3] ?? 0;
      rgba[out + 1] = palette[idx * 3 + 1] ?? 0;
      rgba[out + 2] = palette[idx * 3 + 2] ?? 0;
      rgba[out + 3] = paletteAlpha?.[idx] ?? 255;
    }
  }
  return { width, height, rgba };
}

function blendPixel(
  dst: Uint8Array,
  idx: number,
  sr: number,
  sg: number,
  sb: number,
  sa: number,
): void {
  if (sa <= 0) return;
  if (sa >= 255) {
    dst[idx] = sr;
    dst[idx + 1] = sg;
    dst[idx + 2] = sb;
    dst[idx + 3] = 255;
    return;
  }
  const alpha = sa / 255;
  const inv = 1 - alpha;
  dst[idx] = Math.round(sr * alpha + dst[idx] * inv);
  dst[idx + 1] = Math.round(sg * alpha + dst[idx + 1] * inv);
  dst[idx + 2] = Math.round(sb * alpha + dst[idx + 2] * inv);
  dst[idx + 3] = Math.min(255, Math.round(sa + dst[idx + 3] * inv));
}

function fillRoundedRect(
  rgba: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  color: [number, number, number, number],
  radius = 0,
): void {
  const xStart = Math.max(0, Math.floor(x0));
  const yStart = Math.max(0, Math.floor(y0));
  const xEnd = Math.min(width, Math.ceil(x0 + w));
  const yEnd = Math.min(height, Math.ceil(y0 + h));

  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      let coverage = 1;
      if (radius > 0) {
        const cx =
          x + 0.5 < x0 + radius
            ? x0 + radius
            : x + 0.5 > x0 + w - radius
              ? x0 + w - radius
              : x + 0.5;
        const cy =
          y + 0.5 < y0 + radius
            ? y0 + radius
            : y + 0.5 > y0 + h - radius
              ? y0 + h - radius
              : y + 0.5;
        const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (dist > radius + 0.5) continue;
        if (dist > radius - 0.5) coverage = radius + 0.5 - dist;
      }
      const idx = (y * width + x) * 4;
      blendPixel(rgba, idx, color[0], color[1], color[2], Math.round(color[3] * coverage));
    }
  }
}

/**
 * Downsample and alpha-composite `src` onto `dst` inside `(dx, dy, dw, dh)` using
 * premultiplied area-averaging so high-res app icons scale cleanly to small thumbnails.
 */
function blitImage(
  dst: Uint8Array,
  dstWidth: number,
  dstHeight: number,
  src: DecodedImage,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  if (dw <= 0 || dh <= 0) return;
  const xStart = Math.max(0, Math.floor(dx));
  const yStart = Math.max(0, Math.floor(dy));
  const xEnd = Math.min(dstWidth, Math.ceil(dx + dw));
  const yEnd = Math.min(dstHeight, Math.ceil(dy + dh));
  const scaleX = src.width / dw;
  const scaleY = src.height / dh;

  for (let y = yStart; y < yEnd; y += 1) {
    const sy0 = Math.max(0, Math.floor((y - dy) * scaleY));
    const sy1 = Math.min(src.height, Math.max(sy0 + 1, Math.ceil((y + 1 - dy) * scaleY)));
    for (let x = xStart; x < xEnd; x += 1) {
      const sx0 = Math.max(0, Math.floor((x - dx) * scaleX));
      const sx1 = Math.min(src.width, Math.max(sx0 + 1, Math.ceil((x + 1 - dx) * scaleX)));

      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      let count = 0;

      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          const sIdx = (sy * src.width + sx) * 4;
          const a = src.rgba[sIdx + 3];
          pr += src.rgba[sIdx] * a;
          pg += src.rgba[sIdx + 1] * a;
          pb += src.rgba[sIdx + 2] * a;
          pa += a;
          count += 1;
        }
      }

      if (count === 0 || pa === 0) continue;
      const avgA = pa / count;
      const r = Math.round(pr / pa);
      const g = Math.round(pg / pa);
      const b = Math.round(pb / pa);
      blendPixel(dst, (y * dstWidth + x) * 4, r, g, b, Math.round(avgA));
    }
  }
}

async function decodeIconMap(
  defaultScreenItems: readonly LayoutItem[],
  hotseatItems: readonly LayoutItem[],
  previewCols: number,
  fetchImpl?: typeof fetch,
): Promise<Map<string, DecodedImage>> {
  const decoded = new Map<string, DecodedImage>();
  const maxFolderPreviewItems = previewCols * previewCols;
  const fetchFn = fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
  const inFlightUrlImages = new Map<string, Promise<DecodedImage | undefined>>();

  const fetchAndDecodeUrl = (url: string): Promise<DecodedImage | undefined> => {
    const existing = inFlightUrlImages.get(url);
    if (existing) return existing;
    const promise = (async (): Promise<DecodedImage | undefined> => {
      if (!fetchFn) return undefined;
      try {
        const res = await fetchFn(url, { mode: "cors", referrerPolicy: "no-referrer" });
        if (!res.ok) return undefined;
        const bytes = new Uint8Array(await res.arrayBuffer());
        return await decodePng(bytes);
      } catch {
        return undefined;
      }
    })();
    inFlightUrlImages.set(url, promise);
    return promise;
  };

  const visit = async (item: LayoutItem): Promise<void> => {
    if (!decoded.has(item.id)) {
      if (item.iconBytes && item.iconBytes.byteLength > 0) {
        const img = await decodePng(item.iconBytes);
        if (img) decoded.set(item.id, img);
      } else if (item.iconUrl) {
        const img = await fetchAndDecodeUrl(item.iconUrl);
        if (img) decoded.set(item.id, img);
      }
    }
    if (item.kind === "folder") {
      await Promise.all(item.children.slice(0, maxFolderPreviewItems).map(visit));
    }
  };

  await Promise.all([...defaultScreenItems.map(visit), ...hotseatItems.map(visit)]);
  return decoded;
}

function drawAppOrFolderIcon(
  rgba: Uint8Array,
  width: number,
  height: number,
  item: LayoutItem,
  icons: Map<string, DecodedImage>,
  cx: number,
  cy: number,
  iconSize: number,
  previewCols: number,
): void {
  const x0 = cx - iconSize / 2;
  const y0 = cy - iconSize / 2;

  if (item.kind === "folder") {
    fillRoundedRect(
      rgba,
      width,
      height,
      x0,
      y0,
      iconSize,
      iconSize,
      [56, 70, 96, 215],
      iconSize * 0.34,
    );
    const n = Math.max(2, Math.min(5, previewCols));
    const pad = iconSize * (n >= 4 ? 0.12 : 0.15);
    const gap = iconSize * (n >= 4 ? 0.03 : 0.05);
    const miniSize = Math.max(2, (iconSize - pad * 2 - gap * (n - 1)) / n);
    item.children.slice(0, n * n).forEach((child, idx) => {
      const col = idx % n;
      const row = Math.floor(idx / n);
      const mx = x0 + pad + col * (miniSize + gap);
      const my = y0 + pad + row * (miniSize + gap);
      const childImg = icons.get(child.id);
      if (childImg) {
        blitImage(rgba, width, height, childImg, mx, my, miniSize, miniSize);
      } else {
        fillRoundedRect(
          rgba,
          width,
          height,
          mx,
          my,
          miniSize,
          miniSize,
          [136, 192, 208, 230],
          miniSize * 0.3,
        );
      }
    });
    return;
  }

  const iconImg = icons.get(item.id);
  if (iconImg) {
    blitImage(rgba, width, height, iconImg, x0, y0, iconSize, iconSize);
  } else {
    fillRoundedRect(
      rgba,
      width,
      height,
      x0,
      y0,
      iconSize,
      iconSize,
      [136, 192, 208, 240],
      iconSize * 0.32,
    );
  }
}

/**
 * Render a 360×780 PNG preview thumbnail matching Samsung Home Up's
 * `.AutoBackupPreview/{millis}.png` dimensions (`0x168 × 0x30c`), compositing
 * actual decoded PNG app icons and 2×2 folder mini-icon previews.
 */
export async function renderSamsungPreviewPng(
  layout: LauncherLayout,
  width = 360,
  height = 780,
  fetchImpl?: typeof fetch,
): Promise<Uint8Array> {
  const rgba = new Uint8Array(width * height * 4);
  const previewCols = Math.max(2, Math.min(5, layout.grid.folderPreviewCols ?? 3));
  const defaultScreen =
    layout.screens.find((s) => s.rank === layout.grid.defaultScreenRank) ?? layout.screens[0];
  const icons = await decodeIconMap(
    defaultScreen?.items ?? [],
    layout.hotseat,
    previewCols,
    fetchImpl,
  );

  // Smooth dark-blue gradient wallpaper matching One UI Home aesthetics
  for (let y = 0; y < height; y += 1) {
    const t = y / Math.max(1, height - 1);
    const r = Math.round(14 + t * 20);
    const g = Math.round(24 + t * 38);
    const b = Math.round(46 + t * 62);
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = 255;
    }
  }

  const padX = 20;
  const topY = 52;
  const gridHeight = height - topY - 144;
  const gridWidth = width - padX * 2;
  const cellW = gridWidth / Math.max(1, layout.grid.cols);
  const cellH = gridHeight / Math.max(1, layout.grid.rows);
  const homeIconSize = Math.min(48, Math.min(cellW, cellH) * 0.76);

  if (defaultScreen) {
    for (const item of defaultScreen.items) {
      if (item.kind === "widget") {
        const wx = padX + item.placement.cellX * cellW + 5;
        const wy = topY + item.placement.cellY * cellH + 5;
        const ww = Math.max(20, item.placement.spanX * cellW - 10);
        const wh = Math.max(20, item.placement.spanY * cellH - 14);
        fillRoundedRect(rgba, width, height, wx, wy, ww, wh, [30, 38, 54, 195], 16);
        const widgetIcon = icons.get(item.id);
        if (widgetIcon) {
          const wIconSize = Math.min(32, Math.min(ww, wh) * 0.55);
          blitImage(
            rgba,
            width,
            height,
            widgetIcon,
            wx + 12,
            wy + (wh - wIconSize) / 2,
            wIconSize,
            wIconSize,
          );
        }
        continue;
      }

      const cx = padX + (item.placement.cellX + 0.5) * cellW;
      const cy = topY + (item.placement.cellY + 0.42) * cellH;
      drawAppOrFolderIcon(rgba, width, height, item, icons, cx, cy, homeIconSize, previewCols);
      // Subtle label bar underneath each desktop icon/folder
      fillRoundedRect(
        rgba,
        width,
        height,
        cx - homeIconSize * 0.36,
        cy + homeIconSize * 0.56,
        homeIconSize * 0.72,
        4,
        [226, 232, 240, 130],
        2,
      );
    }
  }

  // Page indicator dots
  const pageCount = Math.max(1, layout.screens.length);
  const dotSpacing = 14;
  const dotsStartX = width / 2 - ((pageCount - 1) * dotSpacing) / 2;
  for (let p = 0; p < pageCount; p += 1) {
    const active = p === (defaultScreen?.rank ?? 0);
    fillRoundedRect(
      rgba,
      width,
      height,
      dotsStartX + p * dotSpacing - 4,
      height - 112,
      8,
      8,
      active ? [240, 244, 248, 255] : [148, 163, 184, 140],
      4,
    );
  }

  // Dock tray + hotseat icons
  const dockY = height - 88;
  fillRoundedRect(rgba, width, height, 16, dockY - 8, width - 32, 68, [28, 36, 52, 165], 22);
  const dockCellW = (width - 44) / Math.max(1, layout.grid.dockCols);
  const dockIconSize = Math.min(46, dockCellW * 0.78);
  for (const item of layout.hotseat) {
    const slot = Math.max(0, Math.min(layout.grid.dockCols - 1, Math.round(item.placement.cellX)));
    const cx = 22 + (slot + 0.5) * dockCellW;
    const cy = dockY + 26;
    drawAppOrFolderIcon(rgba, width, height, item, icons, cx, cy, dockIconSize, previewCols);
  }

  // Encode PNG scanlines (filter 0)
  const stride = width * 4;
  const rawScanlines = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1);
    rawScanlines[rowOffset] = 0;
    rawScanlines.set(rgba.subarray(y * stride, (y + 1) * stride), rowOffset + 1);
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const compressed = await zlibCompress(rawScanlines);
  const ihdrChunk = makeChunk("IHDR", ihdr);
  const idatChunk = makeChunk("IDAT", compressed);
  const iendChunk = makeChunk("IEND", new Uint8Array(0));

  const png = new Uint8Array(
    PNG_SIGNATURE.length + ihdrChunk.length + idatChunk.length + iendChunk.length,
  );
  let outOffset = 0;
  for (const part of [PNG_SIGNATURE, ihdrChunk, idatChunk, iendChunk]) {
    png.set(part, outOffset);
    outOffset += part.length;
  }
  return png;
}
