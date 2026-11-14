const PLAY_PACKAGE_ID_REGEX = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const MAX_PACKAGE_ID_LENGTH = 150;

const PLAY_STORE_ANDROID_ALLOWLIST = new Set(["com.android.chrome", "com.android.vending"]);
const UNRESOLVABLE_ONLINE_EXACT = new Set([
  "android",
  "com.teslacoilsw.launcher",
  "com.sec.android.app.camera",
  "com.sec.android.gallery3d",
  "com.sec.android.daemonapp",
  "com.samsung.android.messaging",
]);
const UNRESOLVABLE_ONLINE_PREFIXES = ["org.chromium.webapk."];

const SKIP_GOOGLE_PLAY_PREFIXES = ["com.sec.", "com.osp."];
const PROPRIETARY_VENDOR_PREFIXES = [
  "com.samsung.",
  "com.sec.",
  "com.osp.",
  "com.google.",
  "com.microsoft.",
  "com.facebook.",
  "com.amazon.",
  "com.adobe.",
];

const OFFICIAL_FDROID_MIRROR_HOSTS = new Set([
  "ftp.fau.de",
  "mirrors.dotsrc.org",
  "mirror.cyberbits.eu",
  "plug-mirror.rcac.purdue.edu",
  "fdroid.tetaneutral.net",
]);

export const MAX_APP_ICON_BYTES = 524_288;
export const APP_ICON_CACHE_CONTROL =
  "public, max-age=604800, s-maxage=2592000, stale-while-revalidate=604800";

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

export type AppMetadataStoreSource = "play" | "galaxy" | "izzy" | "fdroid";

export interface PlayStoreAppMetaResult {
  packageName: string;
  found: boolean;
  source?: AppMetadataStoreSource;
  title?: string;
  iconUrl?: string;
  transientError?: boolean;
}

export type ProxiedAppIconResult =
  | {
      ok: true;
      status: 200;
      bytes: Uint8Array;
      contentType: string;
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 413 | 415 | 502;
      error: string;
    };

export function isValidAndroidPackageId(packageName: string): boolean {
  return (
    Boolean(packageName) &&
    packageName.length <= MAX_PACKAGE_ID_LENGTH &&
    PLAY_PACKAGE_ID_REGEX.test(packageName)
  );
}

/**
 * Returns `true` when `packageName` is invalid or belongs to a core Android/ROM/WebAPK
 * namespace guaranteed never to exist on any public app store (Google Play, Galaxy Store,
 * IzzyOnDroid, or F-Droid).
 */
export function isUnresolvableOnlinePackage(packageName: string): boolean {
  const pkg = packageName.trim();
  if (!isValidAndroidPackageId(pkg)) return true;
  if (UNRESOLVABLE_ONLINE_EXACT.has(pkg)) return true;
  if (pkg.startsWith("com.android.") && !PLAY_STORE_ANDROID_ALLOWLIST.has(pkg)) {
    return true;
  }
  return UNRESOLVABLE_ONLINE_PREFIXES.some((prefix) => pkg.startsWith(prefix));
}

export const isNonPlayStorePackage = isUnresolvableOnlinePackage;

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

function ensureHttpsUrl(rawUrl: string): URL | undefined {
  const decoded = decodeHtmlEntities(rawUrl).trim();
  if (!decoded) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(decoded.startsWith("http://") ? `https://${decoded.slice(7)}` : decoded);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  return parsed;
}

/**
 * Normalize a Google Play icon URL so Google's `play-lh.googleusercontent.com` CDN
 * serves a compact (~5 KB) 128×128 PNG with `Access-Control-Allow-Origin: *`.
 */
export function normalizePlayStoreIconUrl(rawUrl: string): string | undefined {
  const parsed = ensureHttpsUrl(rawUrl);
  if (!parsed) return undefined;

  if (parsed.hostname.endsWith(".googleusercontent.com")) {
    const cleanPath = parsed.pathname.replace(/=[^/]*$/, "");
    return `${parsed.origin}${cleanPath}=s128-rp`;
  }

  return parsed.toString();
}

/**
 * Normalize an F-Droid / IzzyOnDroid upstream icon URL, rewriting F-Droid mirror paths
 * (`https://<mirror>/fdroid/repo/<rest>`) onto canonical `https://f-droid.org/repo/<rest>`.
 */
export function normalizeFossIconUpstreamUrl(rawUrl: string): string | undefined {
  const trimmed = rawUrl.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.port !== "" && parsed.port !== "443")
  ) {
    return undefined;
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host !== "apt.izzysoft.de" &&
    host !== "f-droid.org" &&
    !host.endsWith(".f-droid.org") &&
    parsed.pathname.startsWith("/fdroid/repo/")
  ) {
    const rest = parsed.pathname.slice("/fdroid/repo/".length);
    return `https://f-droid.org/repo/${rest}${parsed.search}`;
  }

  const validated = validateAllowedAppIconUrl(parsed.toString());
  return validated?.toString();
}

/**
 * Validate an upstream URL for `/api/app-icon` against a strict SSRF allowlist:
 * - `https:` protocol only, standard port (`""` or `"443"`), and zero credentials.
 * - Hostname must be `f-droid.org`, `*.f-droid.org`, `apt.izzysoft.de`, or an official
 *   F-Droid mirror serving `/fdroid/repo/*`.
 */
export function validateAllowedAppIconUrl(rawUrl: string): URL | undefined {
  const trimmed = rawUrl.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  if (parsed.port !== "" && parsed.port !== "443") return undefined;

  const host = parsed.hostname.toLowerCase();
  if (host === "f-droid.org" || host.endsWith(".f-droid.org")) {
    return parsed;
  }
  if (host === "apt.izzysoft.de") {
    return parsed;
  }
  if (OFFICIAL_FDROID_MIRROR_HOSTS.has(host) && parsed.pathname.startsWith("/fdroid/repo/")) {
    return parsed;
  }
  return undefined;
}

export function buildProxiedAppIconUrl(upstreamUrl: string): string {
  return `/api/app-icon?url=${encodeURIComponent(upstreamUrl)}`;
}

/**
 * Fetch and validate an upstream FOSS store icon image for `/api/app-icon`, enforcing
 * the strict hostname allowlist (including across redirects), `image/*` content-type,
 * and `<= 512 KB` body limit.
 */
export async function fetchProxiedAppIcon(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProxiedAppIconResult> {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, status: 400, error: "Missing query parameter: url" };
  }

  let currentUrl = validateAllowedAppIconUrl(trimmed);
  if (!currentUrl) {
    return { ok: false, status: 403, error: "Disallowed upstream icon URL" };
  }

  let res: Response | undefined;
  for (let hop = 0; hop <= 3; hop += 1) {
    try {
      res = await fetchImpl(currentUrl.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": PLAY_STORE_USER_AGENT,
          Accept: "image/png,image/webp,image/*;q=0.8",
        },
      });
    } catch {
      return { ok: false, status: 502, error: "Failed to fetch upstream icon" };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location || hop === 3) {
        return { ok: false, status: 502, error: "Invalid upstream redirect" };
      }
      let nextCandidate: string;
      try {
        nextCandidate = new URL(location, currentUrl).toString();
      } catch {
        return { ok: false, status: 403, error: "Invalid redirect URL" };
      }
      const validatedNext = validateAllowedAppIconUrl(nextCandidate);
      if (!validatedNext) {
        return { ok: false, status: 403, error: "Disallowed redirect host" };
      }
      currentUrl = validatedNext;
      continue;
    }
    break;
  }

  if (!res) {
    return { ok: false, status: 502, error: "No upstream response" };
  }
  if (res.status === 404) {
    return { ok: false, status: 404, error: "Upstream icon not found" };
  }
  if (!res.ok) {
    return { ok: false, status: 502, error: `Upstream returned ${res.status}` };
  }

  const rawContentType = (res.headers.get("content-type") ?? "").trim();
  const mimeType = rawContentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!mimeType.startsWith("image/")) {
    return { ok: false, status: 415, error: "Upstream response is not an image" };
  }

  const contentLengthHeader = res.headers.get("content-length");
  if (contentLengthHeader) {
    const declaredLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_APP_ICON_BYTES) {
      return { ok: false, status: 413, error: "Upstream image exceeds 512 KB limit" };
    }
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return { ok: false, status: 502, error: "Failed reading upstream image body" };
  }

  if (bytes.byteLength === 0) {
    return { ok: false, status: 502, error: "Empty upstream image" };
  }
  if (bytes.byteLength > MAX_APP_ICON_BYTES) {
    return { ok: false, status: 413, error: "Upstream image exceeds 512 KB limit" };
  }

  return {
    ok: true,
    status: 200,
    bytes,
    contentType: mimeType,
  };
}

/**
 * Trim verbose store marketing subtitles (e.g. `"Spotify: Music and Podcasts"` -> `"Spotify"`)
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
    ...(iconUrl ? { iconUrl } : {}),
  };
}

function parseGalaxyStorePayload(payload: unknown): {
  title?: string;
  iconUrl?: string;
  isMiss?: boolean;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { isMiss: true };
  }
  const root = payload as Record<string, unknown>;
  if (root.errCode) {
    return { isMiss: true };
  }

  const detailMain =
    root.DetailMain && typeof root.DetailMain === "object" && !Array.isArray(root.DetailMain)
      ? (root.DetailMain as Record<string, unknown>)
      : undefined;
  if (!detailMain || detailMain.errCode) {
    return { isMiss: true };
  }

  // Must use `contentImgURL` (95x95 PNG on `img.samsungapps.com` with `Access-Control-Allow-Origin: *`), NOT `iconURL` (512x512 without CORS).
  const rawImg = typeof detailMain.contentImgURL === "string" ? detailMain.contentImgURL : "";
  const iconUrl = rawImg ? ensureHttpsUrl(rawImg)?.toString() : undefined;

  // Ignore internal Samsung QA strings beginning with `[` (e.g. `"[261028] GALAXY Store..."`)
  const rawName = typeof detailMain.contentName === "string" ? detailMain.contentName.trim() : "";
  const title = rawName && !rawName.startsWith("[") ? cleanPlayStoreAppTitle(rawName) : undefined;

  if (!title && !iconUrl) {
    return { isMiss: true };
  }

  return {
    ...(title ? { title } : {}),
    ...(iconUrl ? { iconUrl } : {}),
  };
}

function parseIzzyHtmlTitle(html: string): string | undefined {
  const h2Match = /<h2\b[^>]*>([^<]+)<\/h2>/i.exec(html);
  if (h2Match?.[1]?.trim()) {
    return cleanPlayStoreAppTitle(h2Match[1]);
  }
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleMatch?.[1]) {
    const stripped = decodeHtmlEntities(titleMatch[1])
      .replace(/\s*-\s*IzzyOnDroid.*$/i, "")
      .trim();
    if (stripped) return cleanPlayStoreAppTitle(stripped);
  }
  return undefined;
}

function matchesExactFDroidPackageUrl(rawAppUrl: string, pkg: string): boolean {
  try {
    const parsed = new URL(rawAppUrl, "https://f-droid.org");
    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    return cleanPath === `/packages/${pkg}` || cleanPath === `/en/packages/${pkg}`;
  } catch {
    return false;
  }
}

/**
 * Sequential multi-store app metadata waterfall (`Google Play -> Samsung Galaxy Store -> IzzyOnDroid -> F-Droid`).
 * Stops immediately at the first store that resolves `packageName`.
 */
export async function fetchPlayStoreAppMeta(
  packageName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PlayStoreAppMetaResult> {
  const pkg = packageName.trim();
  if (isUnresolvableOnlinePackage(pkg)) {
    return { packageName: pkg, found: false };
  }

  let sawTransientError = false;
  const skipGooglePlay = SKIP_GOOGLE_PLAY_PREFIXES.some((prefix) => pkg.startsWith(prefix));
  const skipFossStores = PROPRIETARY_VENDOR_PREFIXES.some((prefix) => pkg.startsWith(prefix));

  // Step 1: Google Play Store (skipped for `com.sec.*` and `com.osp.*`)
  if (!skipGooglePlay) {
    const playUrl = `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en&gl=US`;
    try {
      const res = await fetchImpl(playUrl, {
        method: "GET",
        headers: {
          "User-Agent": PLAY_STORE_USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
          Accept: "text/html,application/xhtml+xml",
        },
      });

      if (res.ok) {
        const html = await res.text();
        const parsed = parsePlayStoreHtml(html);
        if (parsed.title || parsed.iconUrl) {
          return {
            packageName: pkg,
            found: true,
            source: "play",
            ...(parsed.title ? { title: parsed.title } : {}),
            ...(parsed.iconUrl ? { iconUrl: parsed.iconUrl } : {}),
          };
        }
        if (
          !html.includes('id="error-section"') &&
          !html.includes("requested URL was not found on this server")
        ) {
          sawTransientError = true;
        }
      } else if (res.status !== 404) {
        sawTransientError = true;
      }
    } catch {
      sawTransientError = true;
    }
  }

  // Step 2: Samsung Galaxy Store
  {
    const galaxyUrl = `https://galaxystore.samsung.com/api/detail/${encodeURIComponent(pkg)}?cntyCd=USA`;
    try {
      const res = await fetchImpl(galaxyUrl, {
        method: "GET",
        headers: {
          "User-Agent": PLAY_STORE_USER_AGENT,
          Accept: "application/json",
        },
      });

      if (res.ok) {
        const text = await res.text();
        try {
          const parsedJson: unknown = JSON.parse(text);
          const galaxy = parseGalaxyStorePayload(parsedJson);
          if (!galaxy.isMiss && (galaxy.title || galaxy.iconUrl)) {
            return {
              packageName: pkg,
              found: true,
              source: "galaxy",
              ...(galaxy.title ? { title: galaxy.title } : {}),
              ...(galaxy.iconUrl ? { iconUrl: galaxy.iconUrl } : {}),
            };
          }
        } catch {
          sawTransientError = true;
        }
      } else if (res.status !== 404) {
        sawTransientError = true;
      }
    } catch {
      sawTransientError = true;
    }
  }

  // Step 3: FOSS Stores (IzzyOnDroid -> F-Droid), skipped for proprietary vendor namespaces
  if (!skipFossStores) {
    // Step 3a: IzzyOnDroid
    const izzyApiUrl = `https://apt.izzysoft.de/fdroid/api/v1/packages/${encodeURIComponent(pkg)}`;
    try {
      const res = await fetchImpl(izzyApiUrl, {
        method: "GET",
        headers: {
          "User-Agent": PLAY_STORE_USER_AGENT,
          Accept: "application/json",
        },
      });

      if (res.ok) {
        const text = await res.text();
        try {
          const parsedJson = JSON.parse(text) as Record<string, unknown>;
          if (parsedJson && typeof parsedJson === "object" && !parsedJson.error) {
            let title =
              typeof parsedJson.name === "string" && parsedJson.name.trim()
                ? cleanPlayStoreAppTitle(parsedJson.name)
                : typeof parsedJson.title === "string" && parsedJson.title.trim()
                  ? cleanPlayStoreAppTitle(parsedJson.title)
                  : undefined;

            if (!title) {
              try {
                const detailRes = await fetchImpl(
                  `https://apt.izzysoft.de/fdroid/index/apk/${encodeURIComponent(pkg)}`,
                  {
                    method: "GET",
                    headers: {
                      "User-Agent": PLAY_STORE_USER_AGENT,
                      Accept: "text/html",
                    },
                  },
                );
                if (detailRes.ok) {
                  title = parseIzzyHtmlTitle(await detailRes.text());
                }
              } catch {
                // Optional HTML title enrichment; still return iconUrl on failure
              }
            }

            const upstreamIconUrl = `https://apt.izzysoft.de/fdroid/repo/${encodeURIComponent(pkg)}/en-US/icon.png`;
            return {
              packageName: pkg,
              found: true,
              source: "izzy",
              ...(title ? { title } : {}),
              iconUrl: buildProxiedAppIconUrl(upstreamIconUrl),
            };
          }
        } catch {
          sawTransientError = true;
        }
      } else if (res.status !== 404) {
        sawTransientError = true;
      }
    } catch {
      sawTransientError = true;
    }

    // Step 3b: F-Droid Search API (strict exact package pathname match)
    const fdroidSearchUrl = `https://search.f-droid.org/api/search_apps?q=${encodeURIComponent(pkg)}`;
    try {
      const res = await fetchImpl(fdroidSearchUrl, {
        method: "GET",
        headers: {
          "User-Agent": PLAY_STORE_USER_AGENT,
          Accept: "application/json",
        },
      });

      if (res.ok) {
        const text = await res.text();
        try {
          const parsedJson = JSON.parse(text) as {
            apps?: { name?: unknown; icon?: unknown; url?: unknown }[];
          };
          const apps = Array.isArray(parsedJson?.apps) ? parsedJson.apps : [];
          const exactApp = apps.find(
            (candidate) =>
              typeof candidate?.url === "string" &&
              matchesExactFDroidPackageUrl(candidate.url, pkg),
          );
          if (exactApp) {
            const title =
              typeof exactApp.name === "string" && exactApp.name.trim()
                ? cleanPlayStoreAppTitle(exactApp.name)
                : undefined;
            const rawIcon = typeof exactApp.icon === "string" ? exactApp.icon.trim() : "";
            const normalizedUpstream = rawIcon ? normalizeFossIconUpstreamUrl(rawIcon) : undefined;
            const iconUrl = normalizedUpstream
              ? buildProxiedAppIconUrl(normalizedUpstream)
              : undefined;

            if (title || iconUrl) {
              return {
                packageName: pkg,
                found: true,
                source: "fdroid",
                ...(title ? { title } : {}),
                ...(iconUrl ? { iconUrl } : {}),
              };
            }
          }
        } catch {
          sawTransientError = true;
        }
      } else if (res.status !== 404) {
        sawTransientError = true;
      }
    } catch {
      sawTransientError = true;
    }
  }

  if (sawTransientError) {
    return { packageName: pkg, found: false, transientError: true };
  }
  return { packageName: pkg, found: false };
}
