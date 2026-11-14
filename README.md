# Launcher Layout Editor & Converter

Edit and convert Android home screen backups between **Nova Launcher** (`.novabackup`) and **Samsung One UI Home / Good Lock Home Up** (`.exml`) in your browser at [launcher.samleatherdale.com](https://launcher.samleatherdale.com) or from the command line.

Your backup files stay on your device: the web app parses, edits, and exports layouts locally in the browser using WebAssembly SQLite, `JSZip`, and Web Streams PNG encoding.

## Key features

### Four-way bidirectional conversion

- **Nova Launcher to Samsung Home Up**: Exports a ready-to-restore `.zip` bundle containing `.AutoBackup/TIMESTAMP.exml` and a rendered 360×780 `.AutoBackupPreview/TIMESTAMP.png` preview card required by Home Up's restore screen.
- **Samsung Home Up to Nova Launcher**: Exports a `.novabackup` archive with a synthesized v38 `launcher.db` SQLite database and matching `nova.xml` grid, dock, and folder preferences.
- **Same-launcher editing**: Edit Nova → Nova or Samsung → Samsung backups while preserving launcher-specific metadata on untouched items.

### Visual grid and folder editor

- **Side-by-side multi-page canvas**: View all home screen pages at once, add blank pages, and remove empty pages.
- **Live grid and dock resizing**: Expand or shrink the desktop grid (`4×4` to `7×7`) from any edge and resize the dock (`3` to `7` slots) while keeping existing items anchored.
- **Pointer drag-and-drop**: Move apps, folders, and widgets across pages, dock slots, and open folders. Drop on a cell edge to push or swap neighbors, drop in the center to create or merge a folder, hold `Shift` while dropping to replace an existing item, or drag to the trash zone to delete.
- **Target-accurate folder modals**: Rename folders, unwrap single-item folders, reorder icons, and preview exact target folder layouts — Samsung open grids (`3×3` through `7×7`, with One UI Home's `3×3` closed icon preview) or Nova folder modes (**Window** auto-sizing up to `4×4` or **Immersive** custom `2×2`–`7×7` grids, with `2×2` or `3×3` closed previews).
- **Dual-workspace Reference Backup**: Load a second `.novabackup` or `.exml` file via **Load Reference Backup** to drag apps, folders, or widgets into your primary workspace and automatically cross-fill missing app icons and labels.

### Smart compatibility handling

- **Subgrid widget snapping**: Rounds Nova half-cell widgets to non-overlapping integer grid coordinates required by One UI Home.
- **Widget re-binding**: Emits `<appwidget appWidgetID="-1">` entries for One UI Home so Samsung automatically re-binds matching widget providers on restore, preserves widget placements as tap-to-bind placeholders in Nova, and flattens Samsung widget stacks to their primary widget when targeting Nova.
- **App-drawer folders and tabs**: Converts Nova app-drawer folders and custom drawer tabs (`TAB_APP_GROUP`) into Samsung `<appOrder>` folders.
- **Work Profile awareness**: Distinguishes Android Work Profile shortcuts installed in both profiles from Work-only apps, and keeps Personal icons separate from briefcase-badged Work icons.
- **Resolving unknown apps via Google Play**: Samsung `.exml` backups store package and activity names without embedded PNG icons or localized labels. Enable **Resolve unknown apps via Google Play** (remembered in `localStorage`, off by default) to automatically look up public display names and icon URLs by package ID (`com.spotify.music`, for example) without uploading your backup file. Only lightweight `{ title, iconUrl }` mappings are cached in `localStorage` (`nova-editor:play-app-cache`, 30-day TTL for found apps and 7-day TTL for non-Play apps), while app icon images are cached natively by your browser from `play-lh.googleusercontent.com`.

### Local persistence and privacy

- **Client-side processing**: Backup archives are parsed and built in browser memory (`sql.js`, `JSZip`, and `CompressionStream("deflate")`).
- **Autosave and snapshots**: Edits automatically save to your browser's IndexedDB **Autosave** slot. Use the **Save Snapshot** tab to create named checkpoints you can revisit or compare in **Saved Workspaces**.

---

## Get backup files and restore layouts on Android

In the paths and commands below, `TIMESTAMP` represents the 13-digit epoch millisecond basename used by Home Up (for example, `1760000000000`).

### Nova Launcher (`.novabackup`)

#### Export a backup from Nova Launcher

1. On your Android phone, open **Nova Settings → Backup & restore → Backup**.
2. Save the `.novabackup` file to device storage or share it to your computer.

#### Restore an exported `.novabackup` file

1. Copy the exported `.novabackup` file to your phone over USB, cloud storage, or ADB:

   ```bash
   adb push ./my-layout.novabackup /sdcard/Download/my-layout.novabackup
   ```

2. Open **Nova Settings → Backup & restore → Restore or manage backups** and select the `.novabackup` file.
3. If your layout includes widgets migrated from another device or launcher, tap each widget placeholder once on the home screen to grant Android widget-binding permission.

### Samsung One UI Home / Good Lock Home Up (`.exml`)

Install [Home Up](https://galaxystore.samsung.com/detail/com.samsung.android.app.homestar) (or [Good Lock](https://galaxystore.samsung.com/detail/com.samsung.android.goodlock)) from the Samsung Galaxy Store. Open it via **Good Lock → Home Up** or **Home screen settings → More customizations** (One UI 7+).

#### Export a backup from Home Up

1. On your phone, open **Home Up → Home screen → Backup and Restore** and tap **Immediate** to snapshot your current layout.
2. Copy the newest `TIMESTAMP.exml` file to your computer using USB File Transfer or ADB:
   - **USB File Transfer**: Connect your phone in **Transferring files** mode, enable hidden files in your computer's file manager (both backup folders begin with `.`), and open:

     ```text
     Internal storage/Android/data/com.samsung.android.app.homestar/files/.AutoBackup/
     ```

     Copy the `.exml` file with the highest number to your computer.

   - **ADB (macOS / Linux)**:

     ```bash
     latest=$(adb shell 'ls -1 /sdcard/Android/data/com.samsung.android.app.homestar/files/.AutoBackup/*.exml | sort | tail -n 1' | tr -d '\r')
     adb pull "$latest" .
     ```

   - **ADB (Windows PowerShell)**:

     ```powershell
     $latest = (adb shell "ls -1 /sdcard/Android/data/com.samsung.android.app.homestar/files/.AutoBackup/*.exml | sort | tail -n 1").Trim()
     adb pull $latest .
     ```

#### Restore an exported Home Up bundle (`.zip`)

Each **Export Home Up Bundle (.zip)** download contains two sibling files with matching timestamps (Home Up requires the `.png` preview card to list the backup on its restore screen):

```text
Android/data/com.samsung.android.app.homestar/files/
├── .AutoBackup/TIMESTAMP.exml
└── .AutoBackupPreview/TIMESTAMP.png
```

1. Extract `homeup-backup-TIMESTAMP.zip` on your computer with hidden files visible.
2. Copy both files onto your phone via USB File Transfer into the matching `.AutoBackup` and `.AutoBackupPreview` directories under `Internal storage/Android/data/com.samsung.android.app.homestar/files/`, or push them with ADB:

   ```bash
   unzip -o homeup-backup-TIMESTAMP.zip -d ./homeup-extracted
   adb push ./homeup-extracted/.AutoBackup/TIMESTAMP.exml /sdcard/Android/data/com.samsung.android.app.homestar/files/.AutoBackup/TIMESTAMP.exml
   adb push ./homeup-extracted/.AutoBackupPreview/TIMESTAMP.png /sdcard/Android/data/com.samsung.android.app.homestar/files/.AutoBackupPreview/TIMESTAMP.png
   ```

3. Open **Home Up → Home screen → Backup and Restore** on your phone and tap the new backup entry to apply it.

---

## Use the CLI

The repository includes an isomorphic Node.js/TypeScript CLI (`pnpm cli`) powered by the same core parser, converter, PNG renderer, and Smart Switch AES-CBC codec as the web app.

### Inspect a backup

Print a human-readable summary or structured JSON breakdown of a `.novabackup`, `.exml`, or `.xml` file:

```bash
pnpm cli inspect ./my-layout.novabackup
pnpm cli inspect ./1760000000000.exml --json --summary-only
```

### Convert between Nova Launcher and Samsung One UI Home

Convert a Nova backup into a ready-to-push Home Up directory pair (`.AutoBackup/TIMESTAMP.exml` and `.AutoBackupPreview/TIMESTAMP.png`), a standalone `.exml`, or convert a Samsung backup into a `.novabackup` archive:

```bash
# Nova (.novabackup) -> complete Home Up directory (.AutoBackup + .AutoBackupPreview)
pnpm cli convert ./my-layout.novabackup --homeup-dir ./homeup-out

# Nova (.novabackup) -> standalone Samsung .exml with explicit target grid dimensions
pnpm cli convert ./my-layout.novabackup -o ./converted.exml --rows 6 --cols 5 --dock-cols 5

# Samsung (.exml) -> Nova Launcher (.novabackup)
pnpm cli convert ./1760000000000.exml -o ./converted.novabackup
```

Pass `pnpm cli convert --help` to see all options, including `--no-keep-widgets`, `--no-include-drawer-folders`, `--no-include-drawer-tabs`, `--home-only`, and `--scale <proportional|clamp>`.

### Decrypt or encrypt Smart Switch `.exml` files

Home Up writes plaintext XML `.exml` files, whereas Samsung Smart Switch encrypts `.exml` payloads with AES-CBC using a session key (`SESSION_KEY`):

```bash
# Decode a Home Up .exml or decrypt a Smart Switch .exml to UTF-8 XML
pnpm cli decrypt ./home_layout.exml -k SESSION_KEY -o ./home_layout.xml

# Encrypt a Samsung XML file into Smart Switch AES-CBC .exml format
pnpm cli encrypt ./home_layout.xml -k SESSION_KEY -o ./home_layout_encrypted.exml --gzip
```

---

## Local development and deployment

This project uses `pnpm` and [Vite+](https://viteplus.dev) (`vp` / `vpx`) for local development, formatting, type-aware linting, testing, and production builds.

### Commands

Install dependencies and run the development workflow:

```bash
pnpm install          # Install dependencies
pnpm dev              # Start the local Vite+ dev server (http://localhost:5173)
pnpm test             # Run the Vitest unit and round-trip suite
pnpm check            # Run formatting and type-aware oxlint checks
pnpm typecheck        # Run TypeScript --noEmit across src/, api/, and vite.config.ts
pnpm build            # Build static assets into dist/
pnpm exec vp fmt      # Format repository files
```

### Deployment on Vercel

The production site at [launcher.samleatherdale.com](https://launcher.samleatherdale.com) deploys on Vercel:

- **Static frontend (`dist/`)**: Built by `vp build` and served globally from Vercel's CDN, with SPA fallback routing configured in `vercel.json`.
- **Play Store metadata endpoint (`api/play-app.ts`)**: Runs on Vercel Fluid Compute (Node.js 24 LTS) as a Web `Request`/`Response` `GET` handler. Successful lookups return `Cache-Control: public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800` (1-day browser disk cache and 30-day Vercel CDN cache), and resolved app icons load directly from `play-lh.googleusercontent.com`. In local development (`pnpm dev`), `vite.config.ts` serves `/api/play-app` on the same origin.
