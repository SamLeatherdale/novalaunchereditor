const KNOWN_PACKAGE_LABELS: Record<string, string> = {
  // Android AOSP
  "com.android.calculator2": "Calculator",
  "com.android.camera": "Camera",
  "com.android.camera2": "Camera",
  "com.android.chrome": "Chrome",
  "com.android.contacts": "Contacts",
  "com.android.deskclock": "Clock",
  "com.android.dialer": "Phone",
  "com.android.documentsui": "Files",
  "com.android.gallery3d": "Gallery",
  "com.android.messaging": "Messages",
  "com.android.mms": "Messages",
  "com.android.server.telecom": "Phone",
  "com.android.settings": "Settings",
  "com.android.settings.intelligence": "Settings Suggestions",
  "com.android.vending": "Play Store",

  // Google consumer suite
  "com.google.android.apps.adm": "Find Hub",
  "com.google.android.apps.authenticator2": "Authenticator",
  "com.google.android.apps.bard": "Gemini",
  "com.google.android.apps.books": "Play Books",
  "com.google.android.apps.chromecast.app": "Google Home",
  "com.google.android.apps.docs": "Drive",
  "com.google.android.apps.docs.editors.docs": "Docs",
  "com.google.android.apps.docs.editors.sheets": "Sheets",
  "com.google.android.apps.docs.editors.slides": "Slides",
  "com.google.android.apps.fitness": "Google Fit",
  "com.google.android.apps.labs.language.tailwind": "NotebookLM",
  "com.google.android.apps.magazines": "Google News",
  "com.google.android.apps.maps": "Maps",
  "com.google.android.apps.messaging": "Messages",
  "com.google.android.apps.nbu.files": "Files by Google",
  "com.google.android.apps.photos": "Photos",
  "com.google.android.apps.subscriptions.red": "Google One",
  "com.google.android.apps.tachyon": "Meet",
  "com.google.android.apps.tasks": "Tasks",
  "com.google.android.apps.translate": "Translate",
  "com.google.android.apps.walletnfcrel": "Wallet",
  "com.google.android.apps.weather": "Weather",
  "com.google.android.apps.youtube.music": "YT Music",
  "com.google.android.calculator": "Calculator",
  "com.google.android.calendar": "Calendar",
  "com.google.android.contacts": "Contacts",
  "com.google.android.deskclock": "Clock",
  "com.google.android.gm": "Gmail",
  "com.google.android.gms": "Google Play Services",
  "com.google.android.googlequicksearchbox": "Google",
  "com.google.android.inputmethod.latin": "Gboard",
  "com.google.android.keep": "Keep Notes",
  "com.google.android.play.games": "Play Games",
  "com.google.android.videos": "Google TV",
  "com.google.android.youtube": "YouTube",
  "com.google.ar.lens": "Google Lens",

  // Samsung One UI / Galaxy System / Good Lock (404 on Google Play)
  "com.samsung.android.app.cameraassistant": "Camera Assistant",
  "com.samsung.android.app.contacts": "Samsung Contacts",
  "com.samsung.android.app.find": "Samsung Find",
  "com.samsung.android.app.goodlock": "Good Lock",
  "com.samsung.android.goodlock": "Good Lock",
  "com.samsung.android.app.homestar": "Home Up",
  "com.samsung.android.app.notes": "Samsung Notes",
  "com.samsung.android.app.reminder": "Reminder",
  "com.samsung.android.app.routines": "Modes and Routines",
  "com.samsung.android.app.routineplus": "Routines +",
  "com.samsung.android.app.shealth": "Samsung Health",
  "com.samsung.android.app.sketchbook": "PENUP",
  "com.sec.android.app.shealth": "Samsung Health",
  "com.samsung.android.app.tips": "Tips",
  "com.samsung.android.app.watchmanager": "Galaxy Wearable",
  "com.samsung.android.bixby.agent": "Bixby",
  "com.samsung.android.calendar": "Samsung Calendar",
  "com.samsung.android.dialer": "Phone",
  "com.samsung.android.forest": "Digital Wellbeing",
  "com.samsung.android.game.gamehome": "Gaming Hub",
  "com.samsung.android.lool": "Device Care",
  "com.samsung.android.mdx": "Link to Windows",
  "com.samsung.android.messaging": "Messages",
  "com.samsung.android.oneconnect": "SmartThings",
  "com.samsung.android.ruler": "Quick Measure",
  "com.samsung.android.scloud": "Samsung Cloud",
  "com.samsung.android.shealthmonitor": "Samsung Health Monitor",
  "com.samsung.android.sidegesturepad": "One Hand Operation +",
  "com.samsung.android.soundassistant": "Sound Assistant",
  "com.samsung.android.spay": "Samsung Wallet",
  "com.samsung.android.themedesigner": "Theme Park",
  "com.samsung.android.voc": "Samsung Members",
  "com.samsung.knox.securefolder": "Secure Folder",
  "com.sec.android.app.camera": "Camera",
  "com.sec.android.app.clockpackage": "Clock",
  "com.sec.android.app.launcher": "One UI Home",
  "com.sec.android.app.myfiles": "My Files",
  "com.sec.android.app.popupcalculator": "Calculator",
  "com.sec.android.app.samsungapps": "Galaxy Store",
  "com.sec.android.app.sbrowser": "Samsung Internet",
  "com.sec.android.app.voicenote": "Voice Recorder",
  "com.sec.android.daemonapp": "Weather",
  "com.sec.android.easyMover": "Smart Switch",
  "com.sec.android.gallery3d": "Gallery",

  // Microsoft
  "com.microsoft.office.outlook": "Outlook",
  "com.microsoft.office.officehubrow": "Microsoft 365",
  "com.microsoft.skydrive": "OneDrive",
  "com.microsoft.teams": "Teams",
  "com.azure.authenticator": "Authenticator",

  // Global social, messaging, productivity, & AI
  "com.openai.chatgpt": "ChatGPT",
  "com.anthropic.claude": "Claude",
  "ai.x.grok": "Grok",
  "com.Slack": "Slack",
  "com.discord": "Discord",
  "com.whatsapp": "WhatsApp",
  "org.telegram.messenger": "Telegram",
  "org.thoughtcrime.securesms": "Signal",
  "com.facebook.orca": "Messenger",
  "com.facebook.katana": "Facebook",
  "com.instagram.android": "Instagram",
  "com.instagram.barcelona": "Threads",
  "com.reddit.frontpage": "Reddit",
  "com.twitter.android": "X",
  "com.linkedin.android": "LinkedIn",
  "com.zhiliaoapp.musically": "TikTok",
  "com.spotify.music": "Spotify",
  "com.ubercab": "Uber",
  "com.ubercab.eats": "Uber Eats",
  "com.paypal.android.p2pmobile": "PayPal",
  "com.github.android": "GitHub",
};

const GENERIC_SEGMENTS = new Set([
  "com",
  "org",
  "net",
  "io",
  "au",
  "uk",
  "co",
  "de",
  "me",
  "us",
  "ai",
  "xyz",
  "info",
  "gov",
  "app",
  "apps",
  "android",
  "mobile",
  "client",
  "prod",
  "production",
  "release",
  "live",
  "paid",
  "free",
  "core",
  "global",
  "international",
  "phone",
]);

function titleCaseWords(raw: string): string {
  return raw
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Returns `true` when `packageName` has a curated label in `KNOWN_PACKAGE_LABELS`.
 */
export function hasCuratedAppLabel(packageName: string): boolean {
  return Boolean(
    packageName && Object.prototype.hasOwnProperty.call(KNOWN_PACKAGE_LABELS, packageName),
  );
}

/**
 * Heuristic segment/class fallback used when no known package mapping or real
 * localized app title is available (e.g. `"com.spotify.music"` -> `"Music"`).
 */
export function inferHeuristicAppLabel(packageName: string, activityName = ""): string {
  if (!packageName) return activityName || "Unknown App";

  if (packageName.startsWith("org.chromium.webapk.")) {
    return "Web App";
  }

  // Check if activity class name itself has a meaningful non-generic prefix (e.g. Dialtacts, Browser)
  const rawClassLeaf = activityName.split(".").pop()?.replace(/\$.*$/, "") ?? "";
  const strippedClass = rawClassLeaf.replace(
    /(Main|Launcher|Launch|Splash|Start|Home|Init|Initialization|Welcome|Entry|EntryPoint|Routing|Browse|Default|OpaqueMain|Shell)?(Activity|Screen|Launcher|Alias|Provider|Widget|WidgetProvider)$/i,
    "",
  );

  const segments = packageName
    .split(".")
    .filter(
      (seg) => seg.length > 1 && !GENERIC_SEGMENTS.has(seg.toLowerCase()) && !/^v\d+$/i.test(seg),
    );

  const bestSegment = segments[segments.length - 1];
  if (bestSegment) {
    const formatted = titleCaseWords(bestSegment);
    if (formatted.length >= 2) return formatted;
  }

  if (strippedClass.length >= 3 && !/^crc64/i.test(strippedClass)) {
    return titleCaseWords(strippedClass);
  }

  return packageName;
}

/**
 * Derive a clean human-readable app or widget name when a backup format (such as
 * Samsung `.exml` `<favorite>` or Nova's `appgroups` table) stores only `packageName`
 * and `className` without an explicit localized label.
 */
export function inferFriendlyAppLabel(packageName: string, activityName = ""): string {
  if (!packageName) return activityName || "Unknown App";
  const exact = KNOWN_PACKAGE_LABELS[packageName];
  if (exact) return exact;
  return inferHeuristicAppLabel(packageName, activityName);
}

export function isGenericTechnicalLabel(
  label: string | undefined,
  packageName: string,
  activityName: string,
): boolean {
  if (!label) return true;
  if (KNOWN_PACKAGE_LABELS[packageName] === label) return false;
  if (label === packageName || label === activityName) return true;
  const leaf = activityName.split(".").pop() ?? "";
  if (
    leaf &&
    label === leaf &&
    (/(Activity|Launcher|Alias|Provider|Widget|Screen|Host|Shell|Main)$/i.test(leaf) ||
      /[a-z][A-Z]/.test(leaf))
  ) {
    return true;
  }
  return /^(MainActivity|SplashActivity|LauncherActivity|StartActivity|WelcomeActivity|HomeActivity|AppActivity|ComposeActivity|HostActivity|RoutingActivity|InitializationActivity|H2OOpaqueMainActivity|default)$/i.test(
    label,
  );
}

export type AppSourceCategory = "user" | "google" | "samsung" | "system";

/**
 * Heuristically classify an Android package name into `google` (`com.google.*`,
 * `com.android.chrome`, `com.android.vending`), `samsung` (`com.samsung.*`,
 * `com.sec.*`, `com.osp.*`), core `system` (`android`, `com.android.*`), or `user`.
 */
export function classifyAppPackage(packageName: string): AppSourceCategory {
  const pkg = packageName.trim().toLowerCase();
  if (pkg.startsWith("com.samsung.") || pkg.startsWith("com.sec.") || pkg.startsWith("com.osp.")) {
    return "samsung";
  }
  if (
    pkg.startsWith("com.google.") ||
    pkg === "com.android.chrome" ||
    pkg === "com.android.vending"
  ) {
    return "google";
  }
  if (pkg === "android" || pkg.startsWith("com.android.")) {
    return "system";
  }
  return "user";
}

const BUNDLED_SYSTEM_ICON_URLS: Record<string, string> = {
  "com.android.settings": "/system-icons/settings.png",
  "com.android.settings.intelligence": "/system-icons/settings.png",
  "com.sec.android.app.camera": "/system-icons/camera.png",
  "com.android.camera": "/system-icons/camera.png",
  "com.android.camera2": "/system-icons/camera.png",
  "com.sec.android.gallery3d": "/system-icons/gallery.png",
  "com.android.gallery3d": "/system-icons/gallery.png",
  "com.sec.android.daemonapp": "/system-icons/weather.png",
  "com.samsung.android.messaging": "/system-icons/messages.png",
  "com.android.mms": "/system-icons/messages.png",
  "com.android.messaging": "/system-icons/messages.png",
  "com.android.dialer": "/system-icons/phone.png",
  "com.android.server.telecom": "/system-icons/phone.png",
  "com.android.contacts": "/system-icons/contacts.png",
  "com.android.deskclock": "/system-icons/clock.png",
  "com.android.calculator2": "/system-icons/calculator.png",
  "com.android.documentsui": "/system-icons/files.png",
};

/**
 * Return a bundled local `/system-icons/*.png` URL for unlisted ROM, core AOSP, or
 * `org.chromium.webapk.*` PWA packages that never exist on public app stores.
 * Store-listed Samsung packages (such as `com.samsung.android.dialer`,
 * `com.sec.android.app.clockpackage`, `com.sec.android.app.myfiles`, and
 * `com.sec.android.app.popupcalculator`) return `undefined` so online lookup can
 * resolve genuine Samsung One UI icons from Galaxy Store.
 */
export function getBundledSystemIconUrl(packageName: string): string | undefined {
  const pkg = packageName.trim();
  if (!pkg) return undefined;
  if (pkg.startsWith("org.chromium.webapk.")) {
    return "/system-icons/webapk.png";
  }
  return BUNDLED_SYSTEM_ICON_URLS[pkg];
}
