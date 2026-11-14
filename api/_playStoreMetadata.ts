const PLAY_PACKAGE_ID_REGEX = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const MAX_PACKAGE_ID_LENGTH = 150;

const PLAY_STORE_ANDROID_ALLOWLIST = new Set(["com.android.chrome", "com.android.vending"]);
const NON_PLAY_STORE_EXACT = new Set(["android", "com.teslacoilsw.launcher"]);
const NON_PLAY_STORE_PREFIXES = ["com.sec.android.app.", "org.chromium.webapk."];

const PLAY_STORE_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "\u2013",
  mdash: "\u2014",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201C",
  rdquo: "\u201D",
  trade: "\u2122",
  reg: "\u00AE",
  copy: "\u00A9",
};

export interface PlayStoreAppMetaResult {
  packageName: string;
  found: boolean;
  title?: string;
  iconUrl?: string;
  transientError?: boolean;
}

export function isValidAndroidPackageId(packageName: string): boolean {
  return (
    Boolean(packageName) &&
    packageName.length <= MAX_PACKAGE_ID_LENGTH &&
    PLAY_PACKAGE_ID_REGEX.test(packageName)
  );
}

/**
 * Returns `true` when `packageName` is invalid or belongs to an Android/OEM/WebAPK
 * namespace guaranteed never to exist on the Google Play Store.
 */
export function isNonPlayStorePackage(packageName: string): boolean {
  const pkg = packageName.trim();
  if (!isValidAndroidPackageId(pkg)) return true;
  if (NON_PLAY_STORE_EXACT.has(pkg)) return true;
  if (pkg.startsWith("com.android.") && !PLAY_STORE_ANDROID_ALLOWLIST.has(pkg)) {
    return true;
  }
  return NON_PLAY_STORE_PREFIXES.some((prefix) => pkg.startsWith(prefix));
}

export function decodeHtmlEntities(raw: string): string {
  if (!raw || !raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (full, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
    }
    return NAMED_HTML_ENTITIES[entity] ?? NAMED_HTML_ENTITIES[entity.toLowerCase()] ?? full;
  });
}

/**
 * Normalize a Google Play icon URL so Google's `play-lh.googleusercontent.com` CDN
 * serves a compact (~5 KB) 128×128 PNG with `Access-Control-Allow-Origin: *`.
 */
export function normalizePlayStoreIconUrl(rawUrl: string): string | undefined {
  const decoded = decodeHtmlEntities(rawUrl).trim();
  if (!decoded) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(decoded.startsWith("http://") ? `https://${decoded.slice(7)}` : decoded);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== "https:") return undefined;

  if (parsed.hostname.endsWith(".googleusercontent.com")) {
    const cleanPath = parsed.pathname.replace(/=[^/]*$/, "");
    return `${parsed.origin}${cleanPath}=s128-rp`;
  }

  return parsed.toString();
}

/**
 * Trim verbose Play Store marketing subtitles (e.g. `"Spotify: Music and Podcasts"` -> `"Spotify"`)
 * when total title length exceeds 22 chars so launcher home-screen labels fit cleanly underneath 72px icons.
 */
export function cleanPlayStoreAppTitle(rawName: string): string {
  const cleaned = decodeHtmlEntities(rawName)
    .replace(/\s*-\s*Apps on Google Play\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length <= 22) {
    return cleaned;
  }

  const separators = [": ", " - ", " \u2013 ", " \u2014 ", " | "];
  let earliestIdx = -1;
  for (const sep of separators) {
    const idx = cleaned.indexOf(sep);
    if (idx >= 2 && (earliestIdx === -1 || idx < earliestIdx)) {
      earliestIdx = idx;
    }
  }

  if (earliestIdx >= 2) {
    const prefix = cleaned.slice(0, earliestIdx).trim();
    if (prefix.length >= 2) {
      return prefix;
    }
  }

  return cleaned;
}

function findSoftwareApplicationNode(node: unknown): Record<string, unknown> | undefined {
  if (!node || typeof node !== "object") return undefined;

  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = findSoftwareApplicationNode(entry);
      if (found) return found;
    }
    return undefined;
  }

  const record = node as Record<string, unknown>;
  const rawType = record["@type"];
  const isSoftwareApp =
    rawType === "SoftwareApplication" ||
    (Array.isArray(rawType) && rawType.includes("SoftwareApplication"));
  if (isSoftwareApp) {
    return record;
  }

  if (Array.isArray(record["@graph"])) {
    return findSoftwareApplicationNode(record["@graph"]);
  }

  return undefined;
}

function extractImageField(imageField: unknown): string | undefined {
  if (typeof imageField === "string" && imageField.trim()) {
    return imageField.trim();
  }
  if (Array.isArray(imageField)) {
    for (const item of imageField) {
      const extracted = extractImageField(item);
      if (extracted) return extracted;
    }
    return undefined;
  }
  if (imageField && typeof imageField === "object") {
    const url = (imageField as Record<string, unknown>).url;
    if (typeof url === "string" && url.trim()) return url.trim();
  }
  return undefined;
}

function extractMetaPropertyContent(html: string, propertyName: string): string | undefined {
  const escapedProp = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const metaTagRegex = /<meta\b[^>]*>/gi;
  const propRegex = new RegExp(`\\bproperty\\s*=\\s*["']${escapedProp}["']`, "i");
  const contentDoubleRegex = /\bcontent\s*=\s*"([^"]*)"/i;
  const contentSingleRegex = /\bcontent\s*=\s*'([^']*)'/i;

  let match: RegExpExecArray | null;
  while ((match = metaTagRegex.exec(html)) !== null) {
    const tag = match[0];
    if (!propRegex.test(tag)) continue;
    const contentMatch = contentDoubleRegex.exec(tag) ?? contentSingleRegex.exec(tag);
    if (contentMatch?.[1]) {
      return contentMatch[1];
    }
  }
  return undefined;
}

export function parsePlayStoreHtml(html: string): {
  title?: string;
  rawTitle?: string;
  iconUrl?: string;
} {
  let rawTitle: string | undefined;
  let rawIcon: string | undefined;

  const ldJsonRegex =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch: RegExpExecArray | null;
  while ((scriptMatch = ldJsonRegex.exec(html)) !== null) {
    const jsonBody = scriptMatch[1]?.trim();
    if (!jsonBody) continue;
    try {
      const parsed: unknown = JSON.parse(jsonBody);
      const appNode = findSoftwareApplicationNode(parsed);
      if (appNode) {
        if (typeof appNode.name === "string" && appNode.name.trim()) {
          rawTitle = appNode.name.trim();
        }
        const img = extractImageField(appNode.image);
        if (img) {
          rawIcon = img;
        }
        if (rawTitle && rawIcon) break;
      }
    } catch {
      // Ignore malformed JSON-LD script blocks and fall through to next block / OpenGraph tags
    }
  }

  if (!rawTitle) {
    const ogTitle = extractMetaPropertyContent(html, "og:title");
    if (ogTitle) {
      rawTitle = decodeHtmlEntities(ogTitle)
        .replace(/\s*-\s*Apps on Google Play\s*$/i, "")
        .trim();
    }
  }

  if (!rawIcon) {
    const ogImage = extractMetaPropertyContent(html, "og:image");
    if (ogImage) {
      rawIcon = ogImage;
    }
  }

  const title = rawTitle ? cleanPlayStoreAppTitle(rawTitle) : undefined;
  const iconUrl = rawIcon ? normalizePlayStoreIconUrl(rawIcon) : undefined;

  return {
    ...(title ? { title } : {}),
    ...(rawTitle ? { rawTitle: decodeHtmlEntities(rawTitle).trim() } : {}),
    ...(iconUrl ? { iconUrl: parsedIconFallback(iconUrl) } : {}),
  };
}

function parsedIconFallback(url: string): string {
  return url;
}

export async function fetchPlayStoreAppMeta(
  packageName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PlayStoreAppMetaResult> {
  const pkg = packageName.trim();
  if (isNonPlayStorePackage(pkg)) {
    return { packageName: pkg, found: false };
  }

  const playUrl = `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en&gl=US`;
  let res: Response;
  try {
    res = await fetchImpl(playUrl, {
      method: "GET",
      headers: {
        "User-Agent": PLAY_STORE_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml",
      },
    });
  } catch {
    return { packageName: pkg, found: false, transientError: true };
  }

  if (res.status === 404) {
    return { packageName: pkg, found: false };
  }

  if (!res.ok) {
    return { packageName: pkg, found: false, transientError: true };
  }

  const html = await res.text();
  const parsed = parsePlayStoreHtml(html);

  if (!parsed.title && !parsed.iconUrl) {
    if (
      html.includes('id="error-section"') ||
      html.includes("requested URL was not found on this server")
    ) {
      return { packageName: pkg, found: false };
    }
    return { packageName: pkg, found: false, transientError: true };
  }

  return {
    packageName: pkg,
    found: true,
    ...(parsed.title ? { title: parsed.title } : {}),
    ...(parsed.iconUrl ? { iconUrl: parsed.iconUrl } : {}),
  };
}
