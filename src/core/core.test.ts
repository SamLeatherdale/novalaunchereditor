import JSZip from "jszip";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { GET as getAppIcon } from "../../api/app-icon";
import { GET as getPlayApp } from "../../api/play-app";
import { IconGraphic } from "../components/IconGraphic";
import {
  APP_ICON_CACHE_CONTROL,
  applyExternalAppMetadata,
  classifyAppPackage,
  cleanPlayStoreAppTitle,
  clearSessionPlayStoreCache,
  collectMissingMetadataPackages,
  collectPersonalPackages,
  collectPlacedAppKeys,
  computeNovaWindowFolderDimensions,
  conciseItemDetail,
  convertLayout,
  convertToNovaLayout,
  decodePng,
  decodeSamsungExml,
  deletePrimaryItem,
  encryptSamsung,
  enrichLayoutIcons,
  evaluateDropOutcome,
  fetchMissingPlayStoreMetadata,
  fetchPlayStoreAppMeta,
  fetchProxiedAppIcon,
  formatRelativeTimeAgo,
  getBundledSystemIconUrl,
  getSessionPlayStoreCache,
  hydrateExternalIconBytesForExport,
  inferBackupTimestamp,
  inferFriendlyAppLabel,
  isAppItemPlaced,
  isNonPlayStorePackage,
  isPlayCacheEntryFresh,
  isUnresolvableOnlinePackage,
  itemAppIdentityKey,
  MAX_APP_ICON_BYTES,
  moveOrInsertItem,
  normalizeFossIconUpstreamUrl,
  normalizePlayStoreIconUrl,
  parseNovaBackup,
  parsePlayStoreHtml,
  parseSamsungXml,
  PLAY_AUTO_FETCH_STORAGE_KEY,
  PLAY_CACHE_FOUND_TTL_MS,
  PLAY_CACHE_NOT_FOUND_TTL_MS,
  PLAY_METADATA_CACHE_STORAGE_KEY,
  readAutoFetchPlayPreference,
  readCachedPlayStoreMetadata,
  renameFolder,
  renderSamsungPreviewPng,
  resizeDesktopGrid,
  resizeDockSlots,
  serializeNovaBackup,
  serializeSamsungXml,
  snapToSamsungFolderGrid,
  unwrapSingleItemFolder,
  validateAllowedAppIconUrl,
  writeAutoFetchPlayPreference,
  writeCachedPlayStoreMetadata,
} from "./index";
import { groupConversionWarnings } from "../App";
import { isIconFullyOutsideRect, resolveDragCursor } from "../components/PointerDragLayer";
import { detectPreferredShell } from "../components/HelpModal";

function findFirstLocalFixture(dir: string, extension: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const match = readdirSync(dir)
    .sort((a, b) => a.localeCompare(b))
    .find((name) => name.toLowerCase().endsWith(extension));
  return match ? join(dir, match) : undefined;
}

const localNovaFixture = findFirstLocalFixture("backups/nova", ".novabackup");
const localSamsungFixture = findFirstLocalFixture("backups/samsung/raw", ".exml");

describe("isomorphic Nova <-> Samsung core & editor operations", () => {
  it("parses sample.novabackup and round-trips grid resize, folder creation, rename, and donor insert", async () => {
    const sampleBytes = new Uint8Array(await readFile("public/sample/sample.novabackup"));
    let layout = await parseNovaBackup(sampleBytes);

    expect(layout.sourceFormat).toBe("nova");
    expect(layout.grid.rows).toBe(5);
    expect(layout.grid.cols).toBe(4);
    expect(layout.screens).toHaveLength(2);
    expect(layout.hotseat).toHaveLength(5);

    // 1. Expand top row (5 -> 6 rows; existing items shift cellY + 1)
    const firstItemBefore = layout.screens[0].items[0];
    const origY = firstItemBefore.placement.cellY;
    layout = resizeDesktopGrid(layout, "top", 1);
    expect(layout.grid.rows).toBe(6);
    const movedDown = layout.screens[0].items.find((i) => i.id === firstItemBefore.id)!;
    expect(movedDown.placement.cellY).toBe(Math.round(origY) + 1);

    // 2. Expand right column (4 -> 5 cols; existing items keep cellX)
    const origX = movedDown.placement.cellX;
    layout = resizeDesktopGrid(layout, "right", 1);
    expect(layout.grid.cols).toBe(5);
    expect(layout.screens[0].items.find((i) => i.id === firstItemBefore.id)!.placement.cellX).toBe(
      Math.round(origX),
    );

    // 3. Expand dock on left (5 -> 6 slots; existing dock items shift +1)
    layout = resizeDockSlots(layout, "left", 1);
    expect(layout.grid.dockCols).toBe(6);
    expect(layout.hotseat[0].placement.cellX).toBe(1);

    // 4. Shift-merge two desktop apps into a new unnamed folder, rename it, then clear back to unnamed
    const appsOnScreen0 = layout.screens[0].items.filter((i) => i.kind === "app");
    expect(appsOnScreen0.length).toBeGreaterThanOrEqual(2);
    const [appA, appB] = appsOnScreen0;
    layout = moveOrInsertItem(
      layout,
      { origin: "primary", itemId: appA.id },
      {
        kind: "desktop-cell",
        screenRank: 0,
        cellX: Math.round(appB.placement.cellX),
        cellY: Math.round(appB.placement.cellY),
        mergeIntoFolder: true,
      },
    );
    const createdFolder = layout.screens[0].items.find(
      (i) =>
        i.kind === "folder" &&
        Math.round(i.placement.cellX) === Math.round(appB.placement.cellX) &&
        Math.round(i.placement.cellY) === Math.round(appB.placement.cellY),
    );
    expect(createdFolder?.kind).toBe("folder");
    expect(createdFolder?.title).toBe("");

    layout = renameFolder(layout, createdFolder!.id, "Temp Name");
    expect(layout.screens[0].items.find((i) => i.id === createdFolder!.id)?.title).toBe(
      "Temp Name",
    );
    layout = renameFolder(layout, createdFolder!.id, "");
    expect(layout.screens[0].items.find((i) => i.id === createdFolder!.id)?.title).toBe("");

    // 5. Directional push: drop a donor app onto an occupied cell without Shift
    const targetApp = layout.screens[0].items.find((i) => i.kind === "app")!;
    const tx = Math.round(targetApp.placement.cellX);
    const ty = Math.round(targetApp.placement.cellY);
    layout = moveOrInsertItem(
      layout,
      { origin: "donor", item: targetApp },
      {
        kind: "desktop-cell",
        screenRank: 0,
        cellX: tx,
        cellY: ty,
        pushDirection: "right",
        mergeIntoFolder: false,
      },
    );
    const displaced = layout.screens[0].items.find((i) => i.id === targetApp.id)!;
    expect(
      Math.round(displaced.placement.cellX) !== tx || Math.round(displaced.placement.cellY) !== ty,
    ).toBe(true);

    // 6. Lossless Nova-to-Nova serialization preserves grid 6x5, dock 6, new folder, and donor item
    const repacked = await serializeNovaBackup(layout);
    const reparsed = await parseNovaBackup(repacked);
    expect(reparsed.grid.rows).toBe(6);
    expect(reparsed.grid.cols).toBe(5);
    expect(reparsed.grid.dockCols).toBe(6);
    const reparsedUnnamed = reparsed.screens[0].items.find(
      (i) => i.kind === "folder" && i.title === "",
    );
    expect(reparsedUnnamed).toBeDefined();
  });

  it("converts Nova layout to Samsung Home Up XML + PNG preview and preserves unnamed folders", async () => {
    const sampleBytes = new Uint8Array(await readFile("public/sample/sample.novabackup"));
    const nova = await parseNovaBackup(sampleBytes);
    const folder = nova.screens[0].items.find((i) => i.kind === "folder")!;
    const unnamedNova = renameFolder(nova, folder.id, "");

    const { layout: converted } = convertLayout(unnamedNova, {
      targetRows: 6,
      targetCols: 5,
      targetDockCols: 5,
    });

    const xml = serializeSamsungXml(converted);
    expect(xml.startsWith("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>")).toBe(true);

    const parsedSamsung = parseSamsungXml(xml);
    expect(parsedSamsung.sourceFormat).toBe("samsung");
    const parsedFolder = parsedSamsung.screens[0].items.find((i) => i.kind === "folder");
    expect(parsedFolder?.title).toBe("");

    // Cross-backup icon enrichment fills missing Samsung icons from Nova
    const enriched = enrichLayoutIcons(parsedSamsung, nova);
    const enrichedAppsWithIcons = enriched.screens[0].items.filter(
      (i) => i.kind === "app" && Boolean(i.iconBytes),
    );
    expect(enrichedAppsWithIcons.length).toBeGreaterThan(0);

    // Plaintext + encrypted round-trip
    const plainExml = await decodeSamsungExml(new TextEncoder().encode(xml));
    expect(plainExml.encrypted).toBe(false);

    const encrypted = await encryptSamsung(xml, "test-session-key", { securityLevel: 1 });
    const decrypted = await decodeSamsungExml(encrypted, "test-session-key", { securityLevel: 1 });
    expect(decrypted.xml).toBe(xml);

    const png = await renderSamsungPreviewPng(converted);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(view.getUint32(16, false)).toBe(360);
    expect(view.getUint32(20, false)).toBe(780);

    // Synthetic Samsung `<stackedwidget>` -> Nova `.novabackup` flattens widget stacks and synthesizes v38 DB
    const stackedSamsungXml = [
      "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>",
      "<Rows>6</Rows>",
      "<Columns>5</Columns>",
      "<PageCount>1</PageCount>",
      "<ScreenIndex>0</ScreenIndex>",
      "<home>",
      '  <stackedwidget screen="0" x="0" y="0" spanX="4" spanY="2" options="0">',
      '    <internalwidget type="widget" screen="0" packageName="com.google.android.deskclock" className="com.android.alarmclock.DigitalAppWidgetProvider" spanX="4" spanY="2" appWidgetID="10" />',
      '    <internalwidget type="widget" screen="1" packageName="com.google.android.calendar" className="com.android.calendar.widget.CalendarAppWidgetProvider" spanX="4" spanY="2" appWidgetID="11" />',
      "  </stackedwidget>",
      "</home>",
      "<hotseat />",
    ].join("\n");
    const parsedStacked = parseSamsungXml(stackedSamsungXml);
    const { layout: flattenedNova, warnings: flattenWarnings } = convertToNovaLayout(parsedStacked);
    expect(flattenWarnings.some((w) => w.code === "stacked-widget-flattened")).toBe(true);
    const reparsedStackedNova = await parseNovaBackup(await serializeNovaBackup(flattenedNova));
    expect(reparsedStackedNova.sourceFormat).toBe("nova");
    expect(reparsedStackedNova.screens[0].items.some((i) => i.kind === "widget")).toBe(true);
  });

  it.runIf(Boolean(localNovaFixture))(
    "round-trips optional local Nova fixture in backups/nova when present",
    async () => {
      const bytes = new Uint8Array(await readFile(localNovaFixture!));
      const nova = await parseNovaBackup(bytes);
      expect(nova.screens.length).toBeGreaterThan(0);

      const { layout: samsung } = convertLayout(nova, {
        targetRows: nova.grid.rows,
        targetCols: nova.grid.cols,
        targetDockCols: nova.grid.dockCols,
      });
      expect(samsung.screens.length).toBeGreaterThan(0);

      const reparsedSamsung = parseSamsungXml(serializeSamsungXml(samsung));
      expect(reparsedSamsung.screens.length).toBeGreaterThan(0);

      const reparsedNova = await parseNovaBackup(await serializeNovaBackup(nova));
      expect(reparsedNova.screens.length).toBe(nova.screens.length);
    },
  );

  it.runIf(Boolean(localSamsungFixture))(
    "round-trips optional local Samsung .exml fixture in backups/samsung/raw when present",
    async () => {
      const exmlBytes = new Uint8Array(await readFile(localSamsungFixture!));
      const decoded = await decodeSamsungExml(exmlBytes);
      const samsungLayout = parseSamsungXml(decoded.xml);
      expect(samsungLayout.screens.length).toBeGreaterThan(0);

      const { layout: novaReady } = convertToNovaLayout(samsungLayout);
      const novaZipBytes = await serializeNovaBackup(novaReady);
      const reparsedNova = await parseNovaBackup(novaZipBytes);
      expect(reparsedNova.sourceFormat).toBe("nova");
      expect(reparsedNova.screens.length).toBeGreaterThan(0);
    },
  );

  it("supports trash deletion, 1-item folder unwrap (via button or drag-to-same-cell), donor folder dedupe, and placed-key tracking", async () => {
    const sampleBytes = new Uint8Array(await readFile("public/sample/sample.novabackup"));
    let layout = await parseNovaBackup(sampleBytes);

    const apps = layout.screens[0].items.filter((i) => i.kind === "app");
    const [app1, app2] = apps;
    const fx = Math.round(app2.placement.cellX);
    const fy = Math.round(app2.placement.cellY);

    // Create a 2-item folder via Shift-merge
    layout = moveOrInsertItem(
      layout,
      { origin: "primary", itemId: app1.id },
      { kind: "desktop-cell", screenRank: 0, cellX: fx, cellY: fy, mergeIntoFolder: true },
    );
    const folder = layout.screens[0].items.find(
      (i) =>
        i.kind === "folder" &&
        Math.round(i.placement.cellX) === fx &&
        Math.round(i.placement.cellY) === fy,
    )!;
    expect(folder.kind).toBe("folder");

    // Delete one child via trash -> 1-item folder remains intact!
    layout = deletePrimaryItem(layout, app1.id);
    const oneItemFolder = layout.screens[0].items.find((i) => i.id === folder.id)!;
    expect(oneItemFolder.kind).toBe("folder");
    if (oneItemFolder.kind === "folder") {
      expect(oneItemFolder.children).toHaveLength(1);
    }

    // Option 1: Unwrap via explicit button
    const unwrappedByBtn = unwrapSingleItemFolder(layout, folder.id);
    const restoredByBtn = unwrappedByBtn.screens[0].items.find((i) => i.id === app2.id);
    expect(restoredByBtn?.kind).toBe("app");
    expect(Math.round(restoredByBtn!.placement.cellX)).toBe(fx);
    expect(Math.round(restoredByBtn!.placement.cellY)).toBe(fy);

    // Option 2: Unwrap naturally by dragging the sole child onto the same cell occupied by its folder
    const unwrappedByDrag = moveOrInsertItem(
      layout,
      { origin: "primary", itemId: app2.id },
      { kind: "desktop-cell", screenRank: 0, cellX: fx, cellY: fy, mergeIntoFolder: false },
    );
    const restoredByDrag = unwrappedByDrag.screens[0].items.find((i) => i.id === app2.id);
    expect(restoredByDrag?.kind).toBe("app");
    expect(unwrappedByDrag.screens[0].items.some((i) => i.id === folder.id)).toBe(false);

    // Placed-app identity keys & deduplicated donor folder merge
    const placedKeys = collectPlacedAppKeys(unwrappedByBtn);
    expect(placedKeys.has(itemAppIdentityKey(app2))).toBe(true);
    expect(placedKeys.has(itemAppIdentityKey(app1))).toBe(false);

    const existingFolder = unwrappedByBtn.screens[0].items.find((i) => i.kind === "folder")!;
    if (existingFolder.kind === "folder") {
      const beforeCount = existingFolder.children.length;
      // Shift-merging the exact same donor folder onto itself adds 0 duplicate children
      const merged = moveOrInsertItem(
        unwrappedByBtn,
        { origin: "donor", item: existingFolder },
        {
          kind: "desktop-cell",
          screenRank: 0,
          cellX: Math.round(existingFolder.placement.cellX),
          cellY: Math.round(existingFolder.placement.cellY),
          mergeIntoFolder: true,
        },
      );
      const afterFolder = merged.screens[0].items.find((i) => i.id === existingFolder.id);
      if (afterFolder?.kind === "folder") {
        expect(afterFolder.children).toHaveLength(beforeCount);
      }
    }
  });

  it("classifies Google/Samsung/System/User packages, formats single-level folder brackets, and detects folder modal drag-out bounds", async () => {
    expect(classifyAppPackage("com.samsung.android.app.homestar")).toBe("samsung");
    expect(classifyAppPackage("com.sec.android.gallery3d")).toBe("samsung");
    expect(classifyAppPackage("com.google.android.keep")).toBe("google");
    expect(classifyAppPackage("com.android.chrome")).toBe("google");
    expect(classifyAppPackage("com.android.vending")).toBe("google");
    expect(classifyAppPackage("com.android.settings")).toBe("system");
    expect(classifyAppPackage("android")).toBe("system");
    expect(classifyAppPackage("com.spotify.music")).toBe("user");

    // Folder modal drag-out rectangle check (44x44 icon => 22px half-size)
    const rect = { left: 100, top: 100, right: 400, bottom: 350 };
    expect(isIconFullyOutsideRect(250, 200, rect)).toBe(false);
    // Straddling right edge (410 - 22 = 388 <= 400) -> still overlapping modal
    expect(isIconFullyOutsideRect(410, 200, rect)).toBe(false);
    // Fully outside right edge (425 - 22 = 403 > 400) -> modal hides!
    expect(isIconFullyOutsideRect(425, 200, rect)).toBe(true);

    // Work profile split: Work-only (`work-only-skipped`) vs Personal copy present (`work-profile-downgraded`), with concise "Teams" detail
    const sampleBytes = new Uint8Array(await readFile("public/sample/sample.novabackup"));
    const layout = await parseNovaBackup(sampleBytes);
    layout.hotseat = [
      {
        kind: "folder",
        id: "dock-work-folder",
        title: "",
        packageName: "",
        activityName: "",
        intentUri: "",
        placement: {
          container: "hotseat",
          cellX: 2,
          cellY: 0,
          spanX: 1,
          spanY: 1,
          rank: 2,
          screenRank: 2,
        },
        children: [
          {
            kind: "app",
            id: "work-teams",
            title: "Teams",
            packageName: "com.microsoft.teams",
            activityName: "com.microsoft.skype.teams.Launcher",
            intentUri: "",
            isWorkProfile: true,
            placement: {
              container: "folder",
              cellX: 0,
              cellY: 0,
              spanX: 1,
              spanY: 1,
              rank: 0,
              screenRank: 0,
            },
          },
          {
            kind: "app",
            id: "work-intranet",
            title: "Intranet",
            packageName: "com.example.intranet",
            activityName: "com.example.intranet.MainActivity",
            intentUri: "",
            isWorkProfile: true,
            placement: {
              container: "folder",
              cellX: 0,
              cellY: 0,
              spanX: 1,
              spanY: 1,
              rank: 1,
              screenRank: 1,
            },
          },
        ],
      },
    ];

    // Without Personal Teams, both are Work-only (`work-only-skipped`) with concise names
    const workOnlyConverted = convertLayout(layout, {
      targetRows: 6,
      targetCols: 5,
      targetDockCols: 5,
      scaleMode: "clamp",
    });
    expect(
      workOnlyConverted.warnings.find(
        (w) => w.itemId === "work-teams" && w.code === "work-only-skipped",
      )?.detail,
    ).toBe("Teams");

    // When Personal Teams is known (e.g. from donor backup), Teams emits `work-profile-downgraded` while Intranet stays `work-only-skipped`
    const splitConverted = convertLayout(layout, {
      targetRows: 6,
      targetCols: 5,
      targetDockCols: 5,
      scaleMode: "clamp",
      knownPersonalPackages: new Set(["com.microsoft.teams"]),
    });
    const teamsWarning = splitConverted.warnings.find((w) => w.itemId === "work-teams");
    const intranetWarning = splitConverted.warnings.find((w) => w.itemId === "work-intranet");
    expect(teamsWarning?.code).toBe("work-profile-downgraded");
    expect(teamsWarning?.detail).toBe("Teams");
    expect(intranetWarning?.code).toBe("work-only-skipped");
    expect(intranetWarning?.detail).toBe("Intranet");

    // Concise fallback labels for unnamed folders/items & grouped warning deduplication (`APP_DRAWER (×4)`)
    expect(conciseItemDetail("", "Page 2", true)).toBe("Unnamed folder (Page 2)");
    expect(conciseItemDetail("", "dock slot 4", false)).toBe("Unnamed (dock slot 4)");
    const grouped = groupConversionWarnings([
      { code: "extra-dock-page-dropped", detail: "APP_DRAWER", message: "m1" },
      { code: "extra-dock-page-dropped", detail: "APP_DRAWER", message: "m2" },
      { code: "extra-dock-page-dropped", detail: "APP_DRAWER", message: "m3" },
      { code: "extra-dock-page-dropped", detail: "APP_DRAWER", message: "m4" },
      { code: "extra-dock-page-dropped", detail: "Gmail", message: "m5" },
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].totalCount).toBe(5);
    expect(grouped[0].entries).toEqual(["APP_DRAWER (×4)", "Gmail"]);
  });

  it("computes Nova Window folder shrink sizes, round-trips custom folder grids & previews, and reports drop rejection reasons & cursors", async () => {
    // Exact Nova FolderGridOrganizer shrink curve up to 4x4 max
    expect(computeNovaWindowFolderDimensions(2, 4, 4)).toEqual({ cols: 2, rows: 1 });
    expect(computeNovaWindowFolderDimensions(4, 4, 4)).toEqual({ cols: 2, rows: 2 });
    expect(computeNovaWindowFolderDimensions(6, 4, 4)).toEqual({ cols: 3, rows: 2 });
    expect(computeNovaWindowFolderDimensions(9, 4, 4)).toEqual({ cols: 3, rows: 3 });
    expect(computeNovaWindowFolderDimensions(12, 4, 4)).toEqual({ cols: 4, rows: 3 });
    expect(computeNovaWindowFolderDimensions(16, 4, 4)).toEqual({ cols: 4, rows: 4 });

    expect(snapToSamsungFolderGrid(5, 5).normalized).toBe("5X5");
    expect(snapToSamsungFolderGrid(7, 7).normalized).toBe("7X7");

    // Timestamp & relative time helpers for workspace saves
    expect(inferBackupTimestamp("1700000000000.exml")).toBe(1700000000000);
    expect(inferBackupTimestamp("2026-01-15_09-30.novabackup")).toBeGreaterThan(1700000000000);
    expect(formatRelativeTimeAgo(995_000, 1_000_000)).toBe("just now");
    expect(formatRelativeTimestampHelper()).toBe("5m ago");

    // Round-trip custom Nova Immersive 5x6 + Grid 3x3 preview in nova.xml
    const sampleBytes = new Uint8Array(await readFile("public/sample/sample.novabackup"));
    const sample = await parseNovaBackup(sampleBytes);
    const novaPrep = convertToNovaLayout(sample, {
      novaFolderStyle: "IMMERSIVE",
      novaFolderCols: 5,
      novaFolderRows: 6,
      folderPreviewCols: 3,
    });
    const reserializedBytes = await serializeNovaBackup(novaPrep.layout);
    const reparsed = await parseNovaBackup(reserializedBytes);
    expect(reparsed.grid.novaFolderStyle).toBe("IMMERSIVE");
    expect(reparsed.grid.novaFolderCols).toBe(5);
    expect(reparsed.grid.novaFolderRows).toBe(6);
    expect(reparsed.grid.folderPreviewCols).toBe(3);

    // Full screen drop rejection + cursor resolution
    const fullScreenItems = [];
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        fullScreenItems.push({
          kind: "app" as const,
          id: `cell-${x}-${y}`,
          title: `App ${x},${y}`,
          packageName: `com.example.app${x}${y}`,
          activityName: "MainActivity",
          intentUri: "",
          placement: {
            container: "desktop" as const,
            screenRank: 0,
            cellX: x,
            cellY: y,
            spanX: 1,
            spanY: 1,
          },
        });
      }
    }
    const fullLayout = {
      ...sample,
      grid: { ...sample.grid, cols: 4, rows: 4 },
      screens: [{ id: 0, rank: 0, items: fullScreenItems }],
    };
    const donorApp = {
      ...fullScreenItems[0],
      id: "donor-extra",
      packageName: "com.example.extra",
    };
    const rejected = evaluateDropOutcome(
      fullLayout,
      { origin: "donor", item: donorApp },
      { kind: "desktop-cell", screenRank: 0, cellX: 1, cellY: 1, pushDirection: "right" },
    );
    expect(rejected.accepted).toBe(false);
    expect(rejected.rejectionReason).toContain("Page 1 is completely full");

    // Dropping in the center (mergeIntoFolder: true) on the exact same full screen SUCCEEDS!
    const mergedOnFull = evaluateDropOutcome(
      fullLayout,
      { origin: "donor", item: donorApp },
      { kind: "desktop-cell", screenRank: 0, cellX: 1, cellY: 1, mergeIntoFolder: true },
    );
    expect(mergedOnFull.accepted).toBe(true);
    expect(mergedOnFull.action).toBe("folder-merge");

    // Shift + Drop (replaceOccupant: true) replaces the item at (1, 1) even when the page is 100% full!
    const replacedOnFull = evaluateDropOutcome(
      fullLayout,
      { origin: "donor", item: donorApp },
      { kind: "desktop-cell", screenRank: 0, cellX: 1, cellY: 1, replaceOccupant: true },
    );
    expect(replacedOnFull.accepted).toBe(true);
    expect(replacedOnFull.action).toBe("replace");
    expect(replacedOnFull.layout.screens[0].items).toHaveLength(16);
    expect(
      replacedOnFull.layout.screens[0].items.some(
        (it) =>
          it.packageName === "com.example.extra" &&
          it.placement.cellX === 1 &&
          it.placement.cellY === 1,
      ),
    ).toBe(true);
    expect(
      replacedOnFull.layout.screens[0].items.some((it) => it.packageName === "com.example.app11"),
    ).toBe(false);

    // Archive internal backupTimestamp fallback + OS shell autodetection
    expect(sample.backupTimestamp).toBeGreaterThan(1700000000000);
    expect(inferBackupTimestamp("sample.novabackup", undefined, sample.backupTimestamp)).toBe(
      sample.backupTimestamp,
    );
    expect(
      detectPreferredShell({ userAgentData: { platform: "Windows" } } as unknown as Navigator),
    ).toBe("powershell");
    expect(
      detectPreferredShell({ userAgentData: { platform: "macOS" } } as unknown as Navigator),
    ).toBe("bash");
    expect(
      detectPreferredShell({
        platform: "Win32",
        userAgent: "Mozilla/5.0 (Windows NT 10.0)",
      } as unknown as Navigator),
    ).toBe("powershell");
    expect(
      detectPreferredShell({
        platform: "Linux x86_64",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      } as unknown as Navigator),
    ).toBe("bash");

    expect(
      resolveDragCursor(
        { origin: "donor", item: donorApp, clientX: 0, clientY: 0, shiftKey: false },
        null,
      ),
    ).toBe("copy");
    expect(
      resolveDragCursor(
        { origin: "primary", item: donorApp, clientX: 0, clientY: 0, shiftKey: false },
        { kind: "desktop-cell", allowed: false },
      ),
    ).toBe("no-drop");
    expect(
      resolveDragCursor(
        { origin: "primary", item: donorApp, clientX: 0, clientY: 0, shiftKey: false },
        { kind: "desktop-cell", allowed: true, action: "push", effectiveDirection: "right" },
      ),
    ).toBe("e-resize");
  });

  it("isolates personal vs work-profile iconBytes during cross-backup enrichment and folder dedupe", async () => {
    const sampleBytes = new Uint8Array(await readFile("public/sample/sample.novabackup"));
    const base = await parseNovaBackup(sampleBytes);

    const workBadgedPng = new Uint8Array([1, 2, 3, 4]);
    const cleanPersonalPng = new Uint8Array([9, 8, 7]);

    // Donor has Work Chrome earlier in hotseat (slot 2) than Personal Chrome (slot 3)
    const donorWithBothProfiles = {
      ...base,
      screens: [],
      hotseat: [
        {
          kind: "app" as const,
          id: "nova:work-chrome",
          title: "Chrome",
          packageName: "com.android.chrome",
          activityName: "com.google.android.apps.chrome.Main",
          intentUri: "",
          isWorkProfile: true,
          iconBytes: workBadgedPng,
          placement: {
            container: "hotseat" as const,
            cellX: 2,
            cellY: 0,
            spanX: 1,
            spanY: 1,
            screenRank: 2,
          },
        },
        {
          kind: "app" as const,
          id: "nova:personal-chrome",
          title: "Chrome",
          packageName: "com.android.chrome",
          activityName: "com.google.android.apps.chrome.Main",
          intentUri: "",
          iconBytes: cleanPersonalPng,
          placement: {
            container: "hotseat" as const,
            cellX: 3,
            cellY: 0,
            spanX: 1,
            spanY: 1,
            screenRank: 3,
          },
        },
      ],
      appCatalog: [],
    };

    const samsungTarget = {
      ...base,
      sourceFormat: "samsung" as const,
      screens: [],
      hotseat: [
        {
          kind: "app" as const,
          id: "samsung:chrome",
          title: "Chrome",
          packageName: "com.android.chrome",
          activityName: "com.google.android.apps.chrome.Main",
          intentUri: "",
          placement: {
            container: "hotseat" as const,
            cellX: 3,
            cellY: 0,
            spanX: 1,
            spanY: 1,
            screenRank: 3,
          },
        },
      ],
      appCatalog: [],
    };

    const enriched = enrichLayoutIcons(samsungTarget, donorWithBothProfiles);
    expect(enriched.hotseat[0].iconBytes).toBe(cleanPersonalPng);
    expect(enriched.hotseat[0].isWorkProfile).toBeUndefined();

    // If only a work-badged PNG exists in the donor, a personal target item must NOT inherit the work PNG
    const donorOnlyWork = {
      ...donorWithBothProfiles,
      hotseat: [donorWithBothProfiles.hotseat[0]],
    };
    const enrichedFromWorkOnly = enrichLayoutIcons(samsungTarget, donorOnlyWork);
    expect(enrichedFromWorkOnly.hotseat[0].iconBytes).toBeUndefined();
  });

  it("matches activity-alias apps via isAppItemPlaced while keeping Work vs Personal distinct, enriches real app labels over heuristics, and preserves Nova folder_icon_config byte-for-byte unless modified", async () => {
    expect(inferFriendlyAppLabel("com.spotify.music", "com.spotify.music.MainActivity")).toBe(
      "Spotify",
    );
    expect(
      inferFriendlyAppLabel(
        "com.paypal.android.p2pmobile",
        "com.paypal.android.p2pmobile.startup.activities.StartupActivity",
      ),
    ).toBe("PayPal");

    const sampleBytes = new Uint8Array(await readFile("public/sample/sample.novabackup"));
    const base = await parseNovaBackup(sampleBytes);

    const samsungPrimary = {
      ...base,
      sourceFormat: "samsung" as const,
      screens: [
        {
          id: 0,
          rank: 0,
          items: [
            {
              kind: "app" as const,
              id: "sam:spotify",
              title: "Music",
              packageName: "com.spotify.music",
              activityName: "com.spotify.music.MainActivity",
              intentUri: "",
              placement: {
                container: "desktop" as const,
                screenRank: 0,
                cellX: 0,
                cellY: 0,
                spanX: 1,
                spanY: 1,
              },
            },
            {
              kind: "app" as const,
              id: "sam:whatsapp",
              title: "WhatsApp",
              packageName: "com.whatsapp",
              activityName: "com.whatsapp.Main",
              intentUri: "",
              placement: {
                container: "desktop" as const,
                screenRank: 0,
                cellX: 1,
                cellY: 0,
                spanX: 1,
                spanY: 1,
              },
            },
            {
              kind: "app" as const,
              id: "sam:paypal",
              title: "P2pmobile",
              packageName: "com.paypal.android.p2pmobile",
              activityName: "com.paypal.oslo.app.MainActivity",
              intentUri: "",
              placement: {
                container: "desktop" as const,
                screenRank: 0,
                cellX: 2,
                cellY: 0,
                spanX: 1,
                spanY: 1,
              },
            },
            {
              kind: "app" as const,
              id: "sam:custom-bank",
              title: "Money",
              packageName: "com.example.custombank.money",
              activityName: "com.example.custombank.money.MainActivity",
              intentUri: "",
              placement: {
                container: "desktop" as const,
                screenRank: 0,
                cellX: 3,
                cellY: 0,
                spanX: 1,
                spanY: 1,
              },
            },
            {
              kind: "app" as const,
              id: "sam:personal-chrome",
              title: "Chrome",
              packageName: "com.android.chrome",
              activityName: "com.google.android.apps.chrome.Main",
              intentUri: "",
              placement: {
                container: "desktop" as const,
                screenRank: 0,
                cellX: 0,
                cellY: 1,
                spanX: 1,
                spanY: 1,
              },
            },
          ],
        },
      ],
      hotseat: [],
      appCatalog: [],
    };

    const novaDonor = {
      ...base,
      screens: [
        {
          id: 0,
          rank: 0,
          items: [
            {
              kind: "app" as const,
              id: "nova:spotify-alias",
              title: "Spotify",
              packageName: "com.spotify.music",
              activityName: "com.spotify.music.MainActivityAlias",
              intentUri: "",
              placement: {
                container: "desktop" as const,
                screenRank: 0,
                cellX: 0,
                cellY: 0,
                spanX: 1,
                spanY: 1,
              },
            },
            {
              kind: "app" as const,
              id: "nova:whatsapp-home",
              title: "WhatsApp",
              packageName: "com.whatsapp",
              activityName: "com.whatsapp.HomeActivity",
              intentUri: "",
              placement: {
                container: "desktop" as const,
                screenRank: 0,
                cellX: 1,
                cellY: 0,
                spanX: 1,
                spanY: 1,
              },
            },
            {
              kind: "app" as const,
              id: "nova:paypal-startup",
              title: "PayPal",
              packageName: "com.paypal.android.p2pmobile",
              activityName: "com.paypal.android.p2pmobile.startup.activities.StartupActivity",
              intentUri: "",
              placement: {
                container: "desktop" as const,
                screenRank: 0,
                cellX: 2,
                cellY: 0,
                spanX: 1,
                spanY: 1,
              },
            },
            {
              kind: "app" as const,
              id: "nova:custom-bank",
              title: "CustomBank",
              packageName: "com.example.custombank.money",
              activityName: "com.example.custombank.money.EarlyActivity",
              intentUri: "",
              placement: {
                container: "desktop" as const,
                screenRank: 0,
                cellX: 3,
                cellY: 0,
                spanX: 1,
                spanY: 1,
              },
            },
            {
              kind: "app" as const,
              id: "nova:work-chrome",
              title: "Chrome",
              packageName: "com.android.chrome",
              activityName: "com.google.android.apps.chrome.Main",
              intentUri: "",
              isWorkProfile: true,
              placement: {
                container: "desktop" as const,
                screenRank: 0,
                cellX: 0,
                cellY: 1,
                spanX: 1,
                spanY: 1,
              },
            },
          ],
        },
      ],
      hotseat: [],
      appCatalog: [],
    };

    // Title enrichment upgrades Samsung's inferred "Music" / "P2pmobile" / "Money" to Nova's real stored titles
    const enrichedPrimary = enrichLayoutIcons(samsungPrimary, novaDonor);
    expect(enrichedPrimary.screens[0].items.find((i) => i.id === "sam:spotify")?.title).toBe(
      "Spotify",
    );
    expect(enrichedPrimary.screens[0].items.find((i) => i.id === "sam:paypal")?.title).toBe(
      "PayPal",
    );
    expect(enrichedPrimary.screens[0].items.find((i) => i.id === "sam:custom-bank")?.title).toBe(
      "CustomBank",
    );

    // Placed-app checkmarks match across activity-aliases while keeping Work vs Personal Chrome strictly separate!
    const placedKeys = collectPlacedAppKeys(enrichedPrimary);
    const [donorSpotify, donorWhatsApp, donorPayPal, , donorWorkChrome] =
      novaDonor.screens[0].items;
    expect(isAppItemPlaced(donorSpotify, placedKeys)).toBe(true);
    expect(isAppItemPlaced(donorWhatsApp, placedKeys)).toBe(true);
    expect(isAppItemPlaced(donorPayPal, placedKeys)).toBe(true);
    expect(donorWorkChrome.isWorkProfile).toBe(true);
    expect(isAppItemPlaced(donorWorkChrome, placedKeys)).toBe(false);
    expect(
      isAppItemPlaced(
        {
          packageName: "com.android.chrome",
          activityName: "com.google.android.apps.chrome.Main",
          isWorkProfile: false,
        },
        placedKeys,
      ),
    ).toBe(true);

    // collectPersonalPackages aggregates personal packages across both layouts
    const personalSet = collectPersonalPackages(enrichedPrimary, novaDonor);
    expect(personalSet.has("com.android.chrome")).toBe(true);
    expect(personalSet.has("com.spotify.music")).toBe(true);

    // Lossless Nova -> Nova `nova.xml` preservation of `folder_icon_config` (e.g. RADIAL_5) when unmodified
    const customRadialConfig = "ROUNDED_SQUARE:RADIAL_5:true:#11223344:200:true:false";
    const customWindowConfig = "WINDOW:240:#12345678:20:true:false:3:4:HORIZONTAL:true:true:false";
    const origArchive = base.novaArchive!;
    const patchedOrigXml = (origArchive.prefsXml ?? "").includes('name="folder_icon_config"')
      ? origArchive.prefsXml!.replace(
          /<string\s+name="folder_icon_config">[^<]*<\/string>/,
          `<string name="folder_icon_config">${customRadialConfig}</string>`,
        )
      : origArchive.prefsXml!.replace(
          /<\/map>/,
          `    <string name="folder_icon_config">${customRadialConfig}</string>\n    <string name="folder_window_config">${customWindowConfig}</string>\n</map>`,
        );

    const radialNova = {
      ...base,
      novaArchive: {
        ...origArchive,
        prefsXml: patchedOrigXml,
      },
    };

    // Unmodified export (`novaFolderPreviewModified: false`) keeps `RADIAL_5` 100% byte-identical!
    const unmodifiedPrep = convertToNovaLayout(radialNova, {
      novaFolderStyle: "WINDOW",
      novaFolderCols: 4,
      novaFolderRows: 4,
      folderPreviewCols: 2,
      novaFolderConfigModified: false,
      novaFolderPreviewModified: false,
    });
    const unmodifiedZip = await JSZip.loadAsync(await serializeNovaBackup(unmodifiedPrep.layout));
    const unmodifiedXml = await unmodifiedZip.file(origArchive.prefsEntryName!)!.async("string");
    expect(unmodifiedXml).toContain(
      `<string name="folder_icon_config">${customRadialConfig}</string>`,
    );

    // Modified export (`novaFolderPreviewModified: true`, `folderPreviewCols: 3`) updates to `GRID_9` while preserving other fields!
    const modifiedPrep = convertToNovaLayout(radialNova, {
      novaFolderStyle: "WINDOW",
      novaFolderCols: 4,
      novaFolderRows: 4,
      folderPreviewCols: 3,
      novaFolderConfigModified: false,
      novaFolderPreviewModified: true,
    });
    const modifiedZip = await JSZip.loadAsync(await serializeNovaBackup(modifiedPrep.layout));
    const modifiedXml = await modifiedZip.file(origArchive.prefsEntryName!)!.async("string");
    expect(modifiedXml).toContain(
      `<string name="folder_icon_config">ROUNDED_SQUARE:GRID_9:true:#11223344:200:true:false</string>`,
    );
  });

  it("extracts Google Play metadata, normalizes =s128-rp icon URLs, cleans marketing taglines, and handles 404/transient/invalid packages", async () => {
    // Marketing tagline stripping & short-title preservation
    expect(cleanPlayStoreAppTitle("Spotify: Music and Podcasts")).toBe("Spotify");
    expect(cleanPlayStoreAppTitle("Up - Superpowered Banking")).toBe("Up");
    expect(cleanPlayStoreAppTitle("Signal \u2013 Private Messenger")).toBe("Signal");
    expect(cleanPlayStoreAppTitle("Discord - Talk, Play, Hang Out")).toBe("Discord");
    expect(cleanPlayStoreAppTitle("X")).toBe("X");
    expect(cleanPlayStoreAppTitle("Counter-Strike: Source")).toBe("Counter-Strike: Source");

    // Icon URL =s128-rp normalization
    expect(
      normalizePlayStoreIconUrl("https://play-lh.googleusercontent.com/abc123XYZ=w240-h480-rw"),
    ).toBe("https://play-lh.googleusercontent.com/abc123XYZ=s128-rp");
    expect(normalizePlayStoreIconUrl("https://play-lh.googleusercontent.com/abc123XYZ")).toBe(
      "https://play-lh.googleusercontent.com/abc123XYZ=s128-rp",
    );

    // JSON-LD SoftwareApplication extraction
    const ldJsonHtml = `
      <!doctype html>
      <html><head>
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"SoftwareApplication","name":"Spotify: Music and Podcasts","image":"https://play-lh.googleusercontent.com/eN0IexSzxpUDMfFtm-OyM-nNs44Y74Q3k51bxAMhTvrTnuA4OGnTi_fodN4cl-XxDQc=w240-h480-rw"}
        </script>
      </head><body></body></html>
    `;
    expect(parsePlayStoreHtml(ldJsonHtml)).toEqual({
      title: "Spotify",
      rawTitle: "Spotify: Music and Podcasts",
      iconUrl:
        "https://play-lh.googleusercontent.com/eN0IexSzxpUDMfFtm-OyM-nNs44Y74Q3k51bxAMhTvrTnuA4OGnTi_fodN4cl-XxDQc=s128-rp",
    });

    // OpenGraph fallback + HTML entity decoding + attribute order independence
    const ogHtml = `
      <!doctype html>
      <html><head>
        <meta content="Q&amp;A Notes &#39;Pro&#39; &ndash; Fast Sync &amp; Backup - Apps on Google Play" property="og:title">
        <meta property="og:image" content="https://play-lh.googleusercontent.com/ogIconPath=s180">
      </head><body></body></html>
    `;
    expect(parsePlayStoreHtml(ogHtml)).toEqual({
      title: "Q&A Notes 'Pro'",
      rawTitle: "Q&A Notes 'Pro' \u2013 Fast Sync & Backup",
      iconUrl: "https://play-lh.googleusercontent.com/ogIconPath=s128-rp",
    });

    // Package ID validation & ROM-only/AOSP/WebAPK exclusion without network calls
    expect(isNonPlayStorePackage("android")).toBe(true);
    expect(isNonPlayStorePackage("com.teslacoilsw.launcher")).toBe(true);
    expect(isNonPlayStorePackage("com.sec.android.app.camera")).toBe(true);
    expect(isNonPlayStorePackage("com.sec.android.gallery3d")).toBe(true);
    expect(isNonPlayStorePackage("com.sec.android.daemonapp")).toBe(true);
    expect(isNonPlayStorePackage("com.samsung.android.messaging")).toBe(true);
    expect(isNonPlayStorePackage("com.android.settings")).toBe(true);
    expect(isNonPlayStorePackage("com.android.chrome")).toBe(false);
    expect(isNonPlayStorePackage("com.android.vending")).toBe(false);
    expect(isNonPlayStorePackage("com.sec.android.app.clockpackage")).toBe(false);
    expect(isNonPlayStorePackage("com.sec.android.app.sbrowser")).toBe(false);
    expect(isNonPlayStorePackage("org.chromium.webapk.abcd1234")).toBe(true);
    expect(isNonPlayStorePackage("not_a_package")).toBe(true);
    expect(isNonPlayStorePackage("com.twitter.android;rm -rf")).toBe(true);
    expect(isNonPlayStorePackage("com.twitter.android")).toBe(false);
    expect(isUnresolvableOnlinePackage("com.sec.android.app.myfiles")).toBe(false);

    let fetchCalls = 0;
    const rejectingFetch: typeof fetch = async () => {
      fetchCalls += 1;
      throw new Error("Should not fetch for unresolvable ROM/AOSP package");
    };
    expect(await fetchPlayStoreAppMeta("com.sec.android.app.camera", rejectingFetch)).toEqual({
      packageName: "com.sec.android.app.camera",
      found: false,
    });
    expect(await fetchPlayStoreAppMeta("../bad/pkg", rejectingFetch)).toEqual({
      packageName: "../bad/pkg",
      found: false,
    });
    expect(fetchCalls).toBe(0);

    // 404 vs 429 transient error distinction
    const notFoundRes = await fetchPlayStoreAppMeta("com.example.missing", async () => {
      return new Response("Not Found", { status: 404 });
    });
    expect(notFoundRes).toEqual({ packageName: "com.example.missing", found: false });

    const rateLimitedRes = await fetchPlayStoreAppMeta("com.example.ratelimited", async () => {
      return new Response("Too Many Requests", { status: 429 });
    });
    expect(rateLimitedRes).toEqual({
      packageName: "com.example.ratelimited",
      found: false,
      transientError: true,
    });
  });

  it("prioritizes desktop & dock packages in collectMissingMetadataPackages, skips OEM prefixes, enriches iconUrl without downloading PNG bytes during lookup, and lazily hydrates PNG bytes on export", async () => {
    clearSessionPlayStoreCache();
    const sampleBytes = new Uint8Array(await readFile("public/sample/sample.novabackup"));
    const base = await parseNovaBackup(sampleBytes);

    const existingPng = base.screens[0].items.find((i) => Boolean(i.iconBytes))!.iconBytes!;

    const samsungLayout = {
      ...base,
      sourceFormat: "samsung" as const,
      screens: [
        {
          id: 0,
          rank: 0,
          items: [
            {
              kind: "app" as const,
              id: "desk:sec-camera",
              title: "Camera",
              packageName: "com.sec.android.app.camera",
              activityName: "com.sec.android.app.camera.Camera",
              intentUri: "",
              placement: {
                container: "desktop" as const,
                screenRank: 0,
                cellX: 0,
                cellY: 0,
                spanX: 1,
                spanY: 1,
              },
            },
            {
              kind: "app" as const,
              id: "desk:twitter",
              title: "X",
              packageName: "com.twitter.android",
              activityName: "com.twitter.android.StartActivity",
              intentUri: "",
              placement: {
                container: "desktop" as const,
                screenRank: 0,
                cellX: 1,
                cellY: 0,
                spanX: 1,
                spanY: 1,
              },
            },
            {
              kind: "app" as const,
              id: "desk:custom-label",
              title: "My Custom Reader",
              packageName: "com.example.reader",
              activityName: "com.example.reader.MainActivity",
              intentUri: "",
              placement: {
                container: "desktop" as const,
                screenRank: 0,
                cellX: 2,
                cellY: 0,
                spanX: 1,
                spanY: 1,
              },
            },
          ],
        },
        {
          id: 1,
          rank: 1,
          items: [
            {
              kind: "app" as const,
              id: "page2:offscreen",
              title: "Offscreen App",
              packageName: "com.example.offscreen",
              activityName: "com.example.offscreen.MainActivity",
              intentUri: "",
              iconUrl: "https://play-lh.googleusercontent.com/offscreen=s128-rp",
              placement: {
                container: "desktop" as const,
                screenRank: 1,
                cellX: 0,
                cellY: 0,
                spanX: 1,
                spanY: 1,
              },
            },
          ],
        },
      ],
      hotseat: [
        {
          kind: "folder" as const,
          id: "dock:folder",
          title: "Social",
          packageName: "",
          activityName: "",
          intentUri: "",
          placement: {
            container: "hotseat" as const,
            cellX: 0,
            cellY: 0,
            spanX: 1,
            spanY: 1,
            screenRank: 0,
          },
          children: [
            {
              kind: "app" as const,
              id: "dock:webapk",
              title: "Web App",
              packageName: "org.chromium.webapk.12345",
              activityName: "org.chromium.webapk.shell_apk.MainActivity",
              intentUri: "",
              placement: {
                container: "folder" as const,
                cellX: 0,
                cellY: 0,
                spanX: 1,
                spanY: 1,
                screenRank: 0,
              },
            },
            {
              kind: "app" as const,
              id: "dock:heuristic-app",
              title: "News",
              packageName: "com.example.news.client",
              activityName: "com.example.news.client.MainActivity",
              intentUri: "",
              iconBytes: existingPng,
              placement: {
                container: "folder" as const,
                cellX: 0,
                cellY: 0,
                spanX: 1,
                spanY: 1,
                screenRank: 1,
              },
            },
          ],
        },
      ],
      dockPages: undefined,
      drawerGroups: [
        {
          id: 1,
          title: "Extras",
          groupType: "FOLDER",
          tabOrder: 0,
          items: [
            {
              kind: "app" as const,
              id: "drawer:extra",
              title: "Extra",
              packageName: "com.example.draweronly",
              activityName: "com.example.draweronly.MainActivity",
              intentUri: "",
              placement: {
                container: "drawer" as const,
                cellX: 0,
                cellY: 0,
                spanX: 1,
                spanY: 1,
                screenRank: 0,
              },
            },
          ],
        },
      ],
      appCatalog: [
        {
          packageName: "com.example.catalogonly",
          activityName: "com.example.catalogonly.MainActivity",
          title: "Catalogonly",
        },
      ],
    };

    // Note: `page2:offscreen` already has BOTH `iconUrl` and non-heuristic title, so it is NOT missing!
    const missing = collectMissingMetadataPackages(samsungLayout);
    // Desktop & hotseat items come BEFORE drawerGroups & appCatalog, and OEM/WebAPK are skipped!
    expect(missing).toEqual([
      "com.twitter.android",
      "com.example.reader",
      "com.example.news.client",
      "com.example.draweronly",
      "com.example.catalogonly",
    ]);

    // Mock worker-pool fetch for Play Store metadata ONLY (must NOT download image bytes!)
    let networkCalls = 0;
    const mockStore = new Map<string, string>();
    const mockStorage = {
      getItem: (k: string) => mockStore.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mockStore.set(k, v);
      },
    };
    const mockFetch: typeof fetch = async (input) => {
      networkCalls += 1;
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://play-lh.googleusercontent.com/")) {
        throw new Error(`fetchMissingPlayStoreMetadata must not fetch image bytes: ${url}`);
      }
      if (url.includes("/api/play-app?id=com.twitter.android")) {
        return Response.json({
          packageName: "com.twitter.android",
          found: true,
          title: "X",
          iconUrl: "https://play-lh.googleusercontent.com/twitter=s128-rp",
        });
      }
      if (url.includes("/api/play-app?id=com.example.reader")) {
        return Response.json({
          packageName: "com.example.reader",
          found: true,
          title: "Pocket Reader",
          iconUrl: "https://play-lh.googleusercontent.com/reader=s128-rp",
        });
      }
      if (url.includes("/api/play-app?id=com.example.news.client")) {
        return Response.json({
          packageName: "com.example.news.client",
          found: true,
          title: "Daily News",
        });
      }
      return Response.json({ packageName: "unknown", found: false });
    };

    const progressUpdates: number[] = [];
    const summary = await fetchMissingPlayStoreMetadata(missing, {
      fetchImpl: mockFetch,
      storage: mockStorage,
      concurrency: 3,
      progressThrottleMs: 0,
      onProgress: (done) => progressUpdates.push(done),
    });

    expect(summary.foundCount).toBe(3);
    expect(summary.notFoundCount).toBe(2);
    expect(progressUpdates[progressUpdates.length - 1]).toBe(5);
    // Exactly 5 `/api/play-app` calls and ZERO `play-lh.googleusercontent.com` image downloads!
    expect(networkCalls).toBe(5);

    // Repeat call resolves synchronously from `localStorage` JSON mapping with zero extra network calls
    const cachedSummary = await fetchMissingPlayStoreMetadata(missing, {
      fetchImpl: mockFetch,
      storage: mockStorage,
      progressThrottleMs: 0,
    });
    expect(cachedSummary.foundCount).toBe(3);
    expect(cachedSummary.notFoundCount).toBe(2);
    expect(networkCalls).toBe(5);

    const enriched = applyExternalAppMetadata(samsungLayout, summary.entries);
    const enrichedTwitter = enriched.screens[0].items.find((i) => i.id === "desk:twitter")!;
    expect(enrichedTwitter.iconBytes).toBeUndefined();
    expect(enrichedTwitter.iconUrl).toBe("https://play-lh.googleusercontent.com/twitter=s128-rp");
    expect(enrichedTwitter.title).toBe("X");

    // User-customized title ("My Custom Reader" !== heuristic "Reader") is NEVER overwritten, while `iconUrl` IS filled!
    const enrichedReader = enriched.screens[0].items.find((i) => i.id === "desk:custom-label")!;
    expect(enrichedReader.iconBytes).toBeUndefined();
    expect(enrichedReader.iconUrl).toBe("https://play-lh.googleusercontent.com/reader=s128-rp");
    expect(enrichedReader.title).toBe("My Custom Reader");

    // Heuristic title ("News") inside dock folder IS upgraded to "Daily News" while keeping `existingPng`!
    const dockFolder = enriched.hotseat[0];
    if (dockFolder.kind === "folder") {
      const enrichedNews = dockFolder.children.find((c) => c.id === "dock:heuristic-app")!;
      expect(enrichedNews.title).toBe("Daily News");
      expect(enrichedNews.iconBytes).toBe(existingPng);
      expect(enrichedNews.iconUrl).toBeUndefined();
    }

    // Cross-layout `enrichLayoutIcons` also propagates donor `iconUrl` when `!item.iconBytes && !item.iconUrl`
    const unenrichedTarget = {
      ...samsungLayout,
      screens: [
        {
          id: 0,
          rank: 0,
          items: [samsungLayout.screens[0].items[1]],
        },
      ],
      hotseat: [],
      drawerGroups: undefined,
      appCatalog: [
        {
          packageName: "com.twitter.android",
          activityName: "com.twitter.android.StartActivity",
          title: "Twitter",
        },
      ],
    };
    const crossFromUrlDonor = enrichLayoutIcons(unenrichedTarget, enriched);
    expect(crossFromUrlDonor.screens[0].items[0].iconUrl).toBe(
      "https://play-lh.googleusercontent.com/twitter=s128-rp",
    );
    expect(crossFromUrlDonor.appCatalog?.[0].iconUrl).toBe(
      "https://play-lh.googleusercontent.com/twitter=s128-rp",
    );

    // Enriched layout with `iconUrl` no longer reports those found packages as missing!
    expect(collectMissingMetadataPackages(enriched)).toEqual([
      "com.example.draweronly",
      "com.example.catalogonly",
    ]);
    // Passing `summary.entries` (`playMetadataMap`) ALSO excludes already-checked `found: false` 404 packages so auto-fetch never loops!
    expect(collectMissingMetadataPackages(enriched, summary.entries)).toEqual([]);

    // Lazy export hydration:
    // 1) `renderSamsungPreviewPng` fetches `iconUrl` ONLY for `defaultScreen` (rank 0) + `hotseat`, skipping `page2:offscreen`!
    const previewFetchedUrls: string[] = [];
    const previewReferrerPolicies: (string | undefined)[] = [];
    const previewPng = await renderSamsungPreviewPng(enriched, 180, 390, async (input, init) => {
      const u =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      previewFetchedUrls.push(u);
      previewReferrerPolicies.push(init?.referrerPolicy);
      return new Response(existingPng as unknown as BodyInit, { status: 200 });
    });
    expect(previewPng.byteLength).toBeGreaterThan(100);
    expect(previewFetchedUrls).toContain("https://play-lh.googleusercontent.com/twitter=s128-rp");
    expect(previewFetchedUrls).toContain("https://play-lh.googleusercontent.com/reader=s128-rp");
    expect(previewFetchedUrls).not.toContain(
      "https://play-lh.googleusercontent.com/offscreen=s128-rp",
    );
    expect(previewReferrerPolicies.every((p) => p === "no-referrer")).toBe(true);

    // Offline / rejecting `fetch` never breaks `renderSamsungPreviewPng`
    const offlinePreviewPng = await renderSamsungPreviewPng(enriched, 90, 195, async () => {
      throw new Error("Offline");
    });
    expect(offlinePreviewPng.byteLength).toBeGreaterThan(50);

    // 2) `hydrateExternalIconBytesForExport` populates `iconBytes` for `.novabackup` export
    const { layout: novaConverted } = convertToNovaLayout(enriched);
    const hydratedNova = await hydrateExternalIconBytesForExport(novaConverted, {
      fetchImpl: async (_input, init) => {
        expect(init?.referrerPolicy).toBe("no-referrer");
        return new Response(existingPng as unknown as BodyInit, { status: 200 });
      },
    });
    const reparsedHydratedNova = await parseNovaBackup(await serializeNovaBackup(hydratedNova));
    const exportedTwitter = reparsedHydratedNova.screens[0].items.find(
      (i) => i.packageName === "com.twitter.android",
    );
    expect(exportedTwitter?.iconBytes).toEqual(existingPng);

    clearSessionPlayStoreCache();
  });

  it("enforces 30d positive / 7d negative localStorage Play cache TTLs, stores compact JSON without iconBytes, and never re-fetches 404 packages in a loop", async () => {
    const baseTime = 1_760_000_000_000;

    // Positive cache entries (`found: true`) stay fresh for 30 days
    expect(PLAY_CACHE_FOUND_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(isPlayCacheEntryFresh({ found: true, fetchedAt: baseTime }, baseTime)).toBe(true);
    expect(
      isPlayCacheEntryFresh(
        { found: true, fetchedAt: baseTime },
        baseTime + 8 * 24 * 60 * 60 * 1000,
      ),
    ).toBe(true);
    expect(
      isPlayCacheEntryFresh(
        { found: true, fetchedAt: baseTime },
        baseTime + PLAY_CACHE_FOUND_TTL_MS - 1,
      ),
    ).toBe(true);
    expect(
      isPlayCacheEntryFresh(
        { found: true, fetchedAt: baseTime },
        baseTime + PLAY_CACHE_FOUND_TTL_MS,
      ),
    ).toBe(false);

    // Negative cache entries (`found: false`) stay fresh for 7 days and expire after 7d
    expect(PLAY_CACHE_NOT_FOUND_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(
      isPlayCacheEntryFresh(
        { found: false, fetchedAt: baseTime },
        baseTime + PLAY_CACHE_NOT_FOUND_TTL_MS - 1,
      ),
    ).toBe(true);
    expect(
      isPlayCacheEntryFresh(
        { found: false, fetchedAt: baseTime },
        baseTime + PLAY_CACHE_NOT_FOUND_TTL_MS,
      ),
    ).toBe(false);
    expect(isPlayCacheEntryFresh({ found: true, fetchedAt: undefined }, baseTime)).toBe(false);
    expect(isPlayCacheEntryFresh({ found: true, fetchedAt: Number.NaN }, baseTime)).toBe(false);

    // Persistent `localStorage` auto-fetch preference defaults to `false` and handles storage errors gracefully
    const store = new Map<string, string>();
    const mockStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    expect(readAutoFetchPlayPreference(mockStorage)).toBe(false);
    writeAutoFetchPlayPreference(true, mockStorage);
    expect(store.get(PLAY_AUTO_FETCH_STORAGE_KEY)).toBe("true");
    expect(readAutoFetchPlayPreference(mockStorage)).toBe(true);
    writeAutoFetchPlayPreference(false, mockStorage);
    expect(store.get(PLAY_AUTO_FETCH_STORAGE_KEY)).toBe("false");
    expect(readAutoFetchPlayPreference(mockStorage)).toBe(false);

    const throwingStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readAutoFetchPlayPreference(throwingStorage)).toBe(false);
    expect(() => writeAutoFetchPlayPreference(true, throwingStorage)).not.toThrow();
    expect(readCachedPlayStoreMetadata(throwingStorage, baseTime).size).toBe(0);
    expect(() =>
      writeCachedPlayStoreMetadata(
        [{ packageName: "com.spotify.music", found: true, fetchedAt: baseTime }],
        throwingStorage,
        baseTime,
      ),
    ).not.toThrow();

    // Already-checked `found: false` packages in `playMetadataMap` are excluded from missing list
    const minimalLayout = parseSamsungXml(
      [
        "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>",
        "<Rows>5</Rows>",
        "<Columns>4</Columns>",
        "<PageCount>1</PageCount>",
        "<ScreenIndex>0</ScreenIndex>",
        "<home>",
        '  <favorite screen="0" x="0" y="0" packageName="com.example.sideloaded" className="com.example.sideloaded.MainActivity" />',
        '  <favorite screen="0" x="1" y="0" packageName="com.spotify.music" className="com.spotify.music.MainActivity" />',
        "</home>",
        "<hotseat />",
      ].join("\n"),
    );

    const knownPlayMap = new Map([
      ["com.example.sideloaded", { packageName: "com.example.sideloaded", found: false }],
    ]);
    const after404Pass = applyExternalAppMetadata(minimalLayout, knownPlayMap);
    expect(collectMissingMetadataPackages(after404Pass, knownPlayMap)).toEqual([
      "com.spotify.music",
    ]);

    // `localStorage` (`nova-editor:play-app-cache`) round-trip via `writeCachedPlayStoreMetadata` & `readCachedPlayStoreMetadata`
    clearSessionPlayStoreCache();
    writeCachedPlayStoreMetadata(
      [
        {
          packageName: "com.spotify.music",
          found: true,
          title: "Spotify",
          iconUrl: "https://play-lh.googleusercontent.com/spotify=s128-rp",
          fetchedAt: baseTime,
        },
        {
          packageName: "com.example.fresh404",
          found: false,
          fetchedAt: baseTime - PLAY_CACHE_NOT_FOUND_TTL_MS + 5_000,
        },
        {
          packageName: "com.example.expired404",
          found: false,
          fetchedAt: baseTime - PLAY_CACHE_NOT_FOUND_TTL_MS - 1_000,
        },
      ],
      mockStorage,
      baseTime,
    );

    const rawJson = store.get(PLAY_METADATA_CACHE_STORAGE_KEY)!;
    expect(rawJson).toBeDefined();
    expect(rawJson).not.toContain("iconBytes");
    const parsedJson = JSON.parse(rawJson) as Record<string, unknown>;
    expect(parsedJson["com.spotify.music"]).toEqual({
      found: true,
      title: "Spotify",
      iconUrl: "https://play-lh.googleusercontent.com/spotify=s128-rp",
      fetchedAt: baseTime,
    });
    expect(parsedJson["com.example.expired404"]).toBeUndefined();

    const loadedAtBase = readCachedPlayStoreMetadata(mockStorage, baseTime);
    expect(loadedAtBase.get("com.spotify.music")).toEqual({
      packageName: "com.spotify.music",
      found: true,
      title: "Spotify",
      iconUrl: "https://play-lh.googleusercontent.com/spotify=s128-rp",
      fetchedAt: baseTime,
    });
    expect(loadedAtBase.get("com.example.fresh404")?.found).toBe(false);
    expect(loadedAtBase.has("com.example.expired404")).toBe(false);

    // 10 seconds later, `com.example.fresh404` crosses its 7d TTL while `com.spotify.music` (30d TTL) stays fresh!
    const loadedAfter7d = readCachedPlayStoreMetadata(mockStorage, baseTime + 10_000);
    expect(loadedAfter7d.has("com.spotify.music")).toBe(true);
    expect(loadedAfter7d.has("com.example.fresh404")).toBe(false);
    expect(getSessionPlayStoreCache().size).toBe(0);
  });

  it("handles GET /api/play-app validation, CDN cache headers, and upstream failure logging", async () => {
    const missingIdRes = await getPlayApp(
      new Request("https://launcher.samleatherdale.com/api/play-app"),
    );
    expect(missingIdRes.status).toBe(400);

    const oemRes = await getPlayApp(
      new Request("https://launcher.samleatherdale.com/api/play-app?id=com.sec.android.app.camera"),
    );
    expect(oemRes.status).toBe(200);
    expect(oemRes.headers.get("Cache-Control")).toContain("s-maxage=604800");
    expect(await oemRes.json()).toEqual({
      packageName: "com.sec.android.app.camera",
      found: false,
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("Too Many Requests", { status: 429 }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const transientRes = await getPlayApp(
        new Request("https://launcher.samleatherdale.com/api/play-app?id=com.spotify.music"),
      );
      expect(transientRes.status).toBe(502);
      expect(transientRes.headers.get("Cache-Control")).toBe("no-store");
      expect(await transientRes.json()).toEqual({
        packageName: "com.spotify.music",
        found: false,
        transientError: true,
      });
      expect(errorSpy).toHaveBeenCalledWith("[play-app] upstream failure", {
        packageName: "com.spotify.music",
      });
    } finally {
      fetchSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("executes sequential waterfall (Play -> Galaxy Store -> IzzyOnDroid -> F-Droid), stops on first hit, and skips FOSS stores for proprietary vendors", async () => {
    // 1. Google Play hit stops after 1 fetch (zero calls to Galaxy, Izzy, or F-Droid)
    const playCalls: string[] = [];
    const playHit = await fetchPlayStoreAppMeta("com.twitter.android", async (input) => {
      const url = fetchInputToUrl(input);
      playCalls.push(url);
      return new Response(
        `<meta property="og:title" content="X - Apps on Google Play"><meta property="og:image" content="https://play-lh.googleusercontent.com/xIcon=w240">`,
        { status: 200 },
      );
    });
    expect(playCalls).toHaveLength(1);
    expect(playCalls[0]).toContain("play.google.com");
    expect(playHit).toEqual({
      packageName: "com.twitter.android",
      found: true,
      source: "play",
      title: "X",
      iconUrl: "https://play-lh.googleusercontent.com/xIcon=s128-rp",
    });

    // 2. `com.sec.*` skips Google Play completely and resolves via Galaxy Store `contentImgURL` (95x95 CORS PNG)
    const secCalls: string[] = [];
    const secHit = await fetchPlayStoreAppMeta(
      "com.sec.android.app.clockpackage",
      async (input) => {
        const url = fetchInputToUrl(input);
        secCalls.push(url);
        return Response.json({
          DetailMain: {
            contentName: "Clock",
            contentImgURL: "http://img.samsungapps.com/productNew/clock_95_95.png",
            iconURL: "https://img.samsungapps.com/productNew/ENG/clock_512_512.png",
          },
        });
      },
    );
    expect(secCalls).toHaveLength(1);
    expect(secCalls[0]).toContain(
      "galaxystore.samsung.com/api/detail/com.sec.android.app.clockpackage",
    );
    expect(secHit).toEqual({
      packageName: "com.sec.android.app.clockpackage",
      found: true,
      source: "galaxy",
      title: "Clock",
      iconUrl: "https://img.samsungapps.com/productNew/clock_95_95.png",
    });

    // 3. Galaxy Store ignores internal QA bracketed `contentName` (e.g. `"[261028] GALAXY Store..."`) while keeping `contentImgURL`
    const qaHit = await fetchPlayStoreAppMeta("com.sec.android.app.samsungapps", async () =>
      Response.json({
        DetailMain: {
          contentName: "[261028] GALAXY Store 10CR Update - US",
          contentImgURL: "https://img.samsungapps.com/productNew/store_95_95.png",
        },
      }),
    );
    expect(qaHit).toEqual({
      packageName: "com.sec.android.app.samsungapps",
      found: true,
      source: "galaxy",
      iconUrl: "https://img.samsungapps.com/productNew/store_95_95.png",
    });

    // 4. Proprietary `com.samsung.*` miss tries Play + Galaxy Store ONLY and never hits IzzyOnDroid or F-Droid
    const samsungMissCalls: string[] = [];
    const samsungMiss = await fetchPlayStoreAppMeta(
      "com.samsung.android.app.nonexistent",
      async (input) => {
        const url = fetchInputToUrl(input);
        samsungMissCalls.push(url);
        if (url.includes("play.google.com")) {
          return new Response("Not Found", { status: 404 });
        }
        if (url.includes("galaxystore.samsung.com")) {
          return Response.json({ errCode: "9900", errMsg: "Not found" });
        }
        throw new Error(`Unexpected FOSS store call for proprietary package: ${url}`);
      },
    );
    expect(samsungMiss).toEqual({
      packageName: "com.samsung.android.app.nonexistent",
      found: false,
    });
    expect(samsungMissCalls).toHaveLength(2);

    // 5. FOSS app on IzzyOnDroid: Play 404 -> Galaxy errCode -> IzzyOnDroid 200 (stops before F-Droid)
    const izzyCalls: string[] = [];
    const izzyHit = await fetchPlayStoreAppMeta("org.example.izzyapp", async (input) => {
      const url = fetchInputToUrl(input);
      izzyCalls.push(url);
      if (url.includes("play.google.com")) return new Response("Not Found", { status: 404 });
      if (url.includes("galaxystore.samsung.com")) return Response.json({ errCode: "9900" });
      if (url.includes("apt.izzysoft.de/fdroid/api/v1/packages/org.example.izzyapp")) {
        return Response.json({
          packageName: "org.example.izzyapp",
          name: "Izzy Notes: Markdown Offline",
        });
      }
      throw new Error(`Unexpected F-Droid call after IzzyOnDroid match: ${url}`);
    });
    expect(izzyCalls).toHaveLength(3);
    expect(izzyHit).toEqual({
      packageName: "org.example.izzyapp",
      found: true,
      source: "izzy",
      title: "Izzy Notes",
      iconUrl:
        "/api/app-icon?url=https%3A%2F%2Fapt.izzysoft.de%2Ffdroid%2Frepo%2Forg.example.izzyapp%2Fen-US%2Ficon.png",
    });

    // 6. FOSS app on F-Droid only: Play 404 -> Galaxy errCode -> Izzy 404 -> F-Droid exact match + canonical f-droid.org/repo rewrite
    const fdroidCalls: string[] = [];
    const fdroidHit = await fetchPlayStoreAppMeta("org.example.fossweather", async (input) => {
      const url = fetchInputToUrl(input);
      fdroidCalls.push(url);
      if (url.includes("play.google.com")) return new Response("Not Found", { status: 404 });
      if (url.includes("galaxystore.samsung.com")) return Response.json({ errCode: "9900" });
      if (url.includes("apt.izzysoft.de")) return new Response("Not Found", { status: 404 });
      if (url.includes("search.f-droid.org/api/search_apps?q=org.example.fossweather")) {
        return Response.json({
          apps: [
            {
              name: "Breezy Weather Plugin",
              icon: "https://mirror.cyberbits.eu/fdroid/repo/org.example.fossweather.plugin/en-US/icon.png",
              url: "https://f-droid.org/en/packages/org.example.fossweather.plugin",
            },
            {
              name: "Breezy Weather",
              icon: "https://mirror.cyberbits.eu/fdroid/repo/org.example.fossweather/en-US/icon_abc.png",
              url: "https://f-droid.org/en/packages/org.example.fossweather/",
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    expect(fdroidCalls).toHaveLength(4);
    expect(fdroidHit).toEqual({
      packageName: "org.example.fossweather",
      found: true,
      source: "fdroid",
      title: "Breezy Weather",
      iconUrl:
        "/api/app-icon?url=https%3A%2F%2Ff-droid.org%2Frepo%2Forg.example.fossweather%2Fen-US%2Ficon_abc.png",
    });

    // 7. Transient error in Step 1 does NOT block a subsequent store match
    const recoveredHit = await fetchPlayStoreAppMeta(
      "com.samsung.android.app.homestar",
      async (input) => {
        const url = fetchInputToUrl(input);
        if (url.includes("play.google.com")) {
          return new Response("Service Unavailable", { status: 503 });
        }
        return Response.json({
          DetailMain: {
            contentName: "Home Up",
            contentImgURL: "https://img.samsungapps.com/productNew/homeup_95_95.png",
          },
        });
      },
    );
    expect(recoveredHit.found).toBe(true);
    expect(recoveredHit.source).toBe("galaxy");
    expect(recoveredHit.transientError).toBeUndefined();
  });

  it("enforces strict SSRF hostname/protocol/port/content-type/size rules in /api/app-icon", async () => {
    // Allowlist unit checks
    expect(
      validateAllowedAppIconUrl("https://f-droid.org/repo/org.example.fossweather/en-US/icon.png")
        ?.hostname,
    ).toBe("f-droid.org");
    expect(
      validateAllowedAppIconUrl("https://cdn.f-droid.org/repo/org.fdroid.fdroid/icon.png")
        ?.hostname,
    ).toBe("cdn.f-droid.org");
    expect(
      validateAllowedAppIconUrl(
        "https://apt.izzysoft.de/fdroid/repo/org.example.fossweather/en-US/icon.png",
      )?.hostname,
    ).toBe("apt.izzysoft.de");
    expect(
      normalizeFossIconUpstreamUrl(
        "https://ftp.fau.de/fdroid/repo/org.example.fossweather/en-US/icon.png",
      ),
    ).toBe("https://f-droid.org/repo/org.example.fossweather/en-US/icon.png");

    // Reject HTTP, credentials, non-443 ports, IP literals, localhost, and third-party domains
    expect(validateAllowedAppIconUrl("http://f-droid.org/repo/icon.png")).toBeUndefined();
    expect(
      validateAllowedAppIconUrl("https://user:pass@f-droid.org/repo/icon.png"),
    ).toBeUndefined();
    expect(validateAllowedAppIconUrl("https://f-droid.org:8443/repo/icon.png")).toBeUndefined();
    expect(
      validateAllowedAppIconUrl("https://f-droid.org.evil.example/repo/icon.png"),
    ).toBeUndefined();
    expect(
      validateAllowedAppIconUrl("https://apt.izzysoft.de.evil.example/icon.png"),
    ).toBeUndefined();
    expect(validateAllowedAppIconUrl("https://169.254.169.254/latest/meta-data")).toBeUndefined();
    expect(validateAllowedAppIconUrl("https://127.0.0.1/icon.png")).toBeUndefined();
    expect(validateAllowedAppIconUrl("https://ftp.fau.de/other/path/icon.png")).toBeUndefined();

    // Missing `url` query parameter -> 400
    const missingRes = await getAppIcon(
      new Request("https://launcher.samleatherdale.com/api/app-icon"),
    );
    expect(missingRes.status).toBe(400);

    // Disallowed host -> 403 without making any outbound network call
    const disallowedRes = await getAppIcon(
      new Request(
        "https://launcher.samleatherdale.com/api/app-icon?url=https%3A%2F%2Fevil.example%2Ficon.png",
      ),
    );
    expect(disallowedRes.status).toBe(403);

    // Redirect SSRF (`302` to `127.0.0.1`) -> 403
    const redirectBlocked = await fetchProxiedAppIcon(
      "https://f-droid.org/repo/org.example/icon.png",
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/secret.png" },
        }),
    );
    expect(redirectBlocked).toEqual({
      ok: false,
      status: 403,
      error: "Disallowed redirect host",
    });

    // Non-image Content-Type -> 415
    const nonImage = await fetchProxiedAppIcon(
      "https://f-droid.org/repo/org.example/icon.png",
      async () =>
        new Response("<html>not an image</html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    expect(nonImage.ok).toBe(false);
    if (!nonImage.ok) expect(nonImage.status).toBe(415);

    // Oversized body (> 512 KB) -> 413
    const hugeBytes = new Uint8Array(MAX_APP_ICON_BYTES + 1);
    const oversized = await fetchProxiedAppIcon(
      "https://f-droid.org/repo/org.example/icon.png",
      async () =>
        new Response(hugeBytes as unknown as BodyInit, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.status).toBe(413);

    // Valid PNG -> 200 with 7d browser / 30d CDN Cache-Control
    const validIconBytes = new Uint8Array(await readFile("public/system-icons/weather.png"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(validIconBytes as unknown as BodyInit, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    try {
      const okRes = await getAppIcon(
        new Request(
          "https://launcher.samleatherdale.com/api/app-icon?url=https%3A%2F%2Fapt.izzysoft.de%2Ffdroid%2Frepo%2Forg.example.fossweather%2Fen-US%2Ficon.png",
        ),
      );
      expect(okRes.status).toBe(200);
      expect(okRes.headers.get("Content-Type")).toBe("image/png");
      expect(okRes.headers.get("Cache-Control")).toBe(APP_ICON_CACHE_CONTROL);
      expect(new Uint8Array(await okRes.arrayBuffer())).toEqual(validIconBytes);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("attaches bundled AOSP & WebAPK squircle icons offline, leaves store-listed Samsung packages for Galaxy Store, renders PWA Chrome badge, and decodes all public/system-icons/*.png in renderSamsungPreviewPng", async () => {
    const requiredIconFiles = [
      "settings.png",
      "camera.png",
      "gallery.png",
      "weather.png",
      "messages.png",
      "phone.png",
      "contacts.png",
      "clock.png",
      "calculator.png",
      "files.png",
      "webapk.png",
    ];

    const iconFileBytes = new Map<string, Uint8Array>();
    for (const filename of requiredIconFiles) {
      const bytes = new Uint8Array(await readFile(join("public/system-icons", filename)));
      expect(bytes.byteLength).toBeGreaterThan(1_000);
      expect(bytes.byteLength).toBeLessThanOrEqual(16_384);
      const decoded = await decodePng(bytes);
      expect(decoded).toBeDefined();
      expect(decoded!.width).toBe(128);
      expect(decoded!.height).toBe(128);
      iconFileBytes.set(`/system-icons/${filename}`, bytes);
    }

    // Store-listed Samsung apps must NOT receive `/system-icons/*` so Galaxy Store lookup runs for them
    expect(getBundledSystemIconUrl("com.samsung.android.dialer")).toBeUndefined();
    expect(getBundledSystemIconUrl("com.sec.android.app.clockpackage")).toBeUndefined();
    expect(getBundledSystemIconUrl("com.sec.android.app.myfiles")).toBeUndefined();
    expect(getBundledSystemIconUrl("com.sec.android.app.popupcalculator")).toBeUndefined();

    // Unlisted ROM/AOSP/WebAPK apps receive bundled icons immediately during `enrichLayoutIcons`
    const rawSamsung = parseSamsungXml(
      [
        "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>",
        "<Rows>5</Rows>",
        "<Columns>5</Columns>",
        "<PageCount>1</PageCount>",
        "<ScreenIndex>0</ScreenIndex>",
        "<home>",
        '  <favorite screen="0" x="0" y="0" packageName="com.android.settings" className="com.android.settings.Settings" />',
        '  <favorite screen="0" x="1" y="0" packageName="com.sec.android.app.camera" className="com.sec.android.app.camera.Camera" />',
        '  <favorite screen="0" x="2" y="0" packageName="com.sec.android.gallery3d" className="com.samsung.android.gallery.app.activity.GalleryActivity" />',
        '  <favorite screen="0" x="3" y="0" packageName="com.sec.android.daemonapp" className="com.sec.android.daemonapp.app.MainActivity" />',
        '  <favorite screen="0" x="4" y="0" packageName="org.chromium.webapk.abc123" className="org.chromium.webapk.shell_apk.MainActivity" />',
        '  <favorite screen="0" x="0" y="1" packageName="com.sec.android.app.clockpackage" className="com.sec.android.app.clockpackage.ClockPackage" />',
        "</home>",
        "<hotseat>",
        '  <favorite screen="0" packageName="com.samsung.android.messaging" className="com.android.mms.ui.ConversationComposer" />',
        '  <favorite screen="1" packageName="com.android.dialer" className="com.android.dialer.main.impl.MainActivity" />',
        '  <favorite screen="2" packageName="com.android.contacts" className="com.android.contacts.activities.PeopleActivity" />',
        '  <favorite screen="3" packageName="com.android.calculator2" className="com.android.calculator2.Calculator" />',
        '  <favorite screen="4" packageName="com.android.documentsui" className="com.android.documentsui.LauncherActivity" />',
        "</hotseat>",
      ].join("\n"),
    );

    const enriched = enrichLayoutIcons(rawSamsung);
    const byPkg = new Map(
      [...enriched.screens[0].items, ...enriched.hotseat].map((it) => [it.packageName, it]),
    );
    expect(byPkg.get("com.android.settings")?.iconUrl).toBe("/system-icons/settings.png");
    expect(byPkg.get("com.sec.android.app.camera")?.iconUrl).toBe("/system-icons/camera.png");
    expect(byPkg.get("com.sec.android.gallery3d")?.iconUrl).toBe("/system-icons/gallery.png");
    expect(byPkg.get("com.sec.android.daemonapp")?.iconUrl).toBe("/system-icons/weather.png");
    expect(byPkg.get("org.chromium.webapk.abc123")?.iconUrl).toBe("/system-icons/webapk.png");
    expect(byPkg.get("com.samsung.android.messaging")?.iconUrl).toBe("/system-icons/messages.png");
    expect(byPkg.get("com.android.dialer")?.iconUrl).toBe("/system-icons/phone.png");
    expect(byPkg.get("com.android.contacts")?.iconUrl).toBe("/system-icons/contacts.png");
    expect(byPkg.get("com.android.calculator2")?.iconUrl).toBe("/system-icons/calculator.png");
    expect(byPkg.get("com.android.documentsui")?.iconUrl).toBe("/system-icons/files.png");
    expect(byPkg.get("com.sec.android.app.clockpackage")?.iconUrl).toBeUndefined();

    // Only store-listed `com.sec.android.app.clockpackage` remains unresolved for online lookup!
    expect(collectMissingMetadataPackages(enriched)).toEqual(["com.sec.android.app.clockpackage"]);

    // Render Samsung Home Up preview PNG using the bundled `/system-icons/*.png` assets
    const previewBytes = await renderSamsungPreviewPng(enriched, 180, 390, async (input) => {
      const url = fetchInputToUrl(input);
      const found = iconFileBytes.get(url);
      if (!found) return new Response("Not Found", { status: 404 });
      return new Response(found as unknown as BodyInit, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });
    const decodedPreview = await decodePng(previewBytes);
    expect(decodedPreview?.width).toBe(180);
    expect(decodedPreview?.height).toBe(390);

    // Verify PWA Chrome corner badge renders on standalone WebAPK items without embedded bytes, and NOT inside mini folder thumbnails
    const webapkItem = byPkg.get("org.chromium.webapk.abc123")!;
    const standaloneHtml = renderToStaticMarkup(
      React.createElement(IconGraphic, { item: webapkItem, showWorkBadge: true }),
    );
    expect(standaloneHtml).toContain("pwa-chrome-badge");
    expect(standaloneHtml).toContain("fa-chrome");

    const folderMiniHtml = renderToStaticMarkup(
      React.createElement(IconGraphic, {
        item: webapkItem,
        className: "grid-folder-item",
        showWorkBadge: false,
      }),
    );
    expect(folderMiniHtml).not.toContain("pwa-chrome-badge");
  });
});

function formatRelativeTimestampHelper(): string {
  return formatRelativeTimeAgo(1_000_000 - 5 * 60 * 1000, 1_000_000);
}

function fetchInputToUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}
