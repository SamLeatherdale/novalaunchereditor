import JSZip from "jszip";
import {
  serializeNovaFolderIconConfig,
  serializeNovaFolderWindowConfig,
} from "../model/folderGrids";
import type { GridConfig, LauncherLayout, LayoutItem } from "../model/types";
import { getSqlJs, openSqlite } from "../sql";

function parseNovaNumericId(id: string): number | undefined {
  const match = id.match(/^nova:(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

function buildNovaIntentUri(item: LayoutItem): string | null {
  if (item.kind === "folder" || item.kind === "widget") return null;
  if (item.intentUri && item.intentUri.startsWith("#Intent;")) {
    return item.intentUri;
  }
  if (item.packageName && item.activityName) {
    return `#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;launchFlags=0x10200000;component=${item.packageName}/${item.activityName};end`;
  }
  return item.intentUri || null;
}

function novaItemTypeFor(item: LayoutItem): number {
  switch (item.kind) {
    case "folder":
      return 2;
    case "widget":
      return 4;
    case "deepShortcut":
      return 6;
    case "launcherAction":
      return 1;
    case "app":
    default:
      return 0;
  }
}

/**
 * Surgical update of grid-related `<int>` and `<string>` entries in `nova.xml`,
 * preserving exact formatting and types (`<long>`, `<float>`, etc.) of all untouched entries.
 */
function patchNovaPrefsXml(prefsXml: string, grid: GridConfig, screenCount: number): string {
  let updated = prefsXml;

  const setIntPref = (name: string, value: number): void => {
    const pattern = new RegExp(`(<int\\s+name="${name}"\\s+value=")[^"]*("\\s*/>)`);
    if (pattern.test(updated)) {
      updated = updated.replace(pattern, `$1${Math.round(value)}$2`);
    } else {
      updated = updated.replace(
        /<\/map>/,
        `    <int name="${name}" value="${Math.round(value)}" />\n</map>`,
      );
    }
  };

  setIntPref("desktop_grid_rows", grid.rows);
  setIntPref("desktop_grid_cols", grid.cols);
  setIntPref("dock_grid_cols", grid.dockCols);
  setIntPref("workspace_screen_count", Math.max(1, screenCount));
  setIntPref("desktop_default_page", Math.max(0, grid.defaultScreenRank));

  const gridStringPattern = /(<string\s+name="desktop_grid">)([^<]*)(<\/string>)/;
  if (gridStringPattern.test(updated)) {
    updated = updated.replace(
      gridStringPattern,
      (_full, open: string, prev: string, close: string) => {
        const hasSubgrid = /subgrid/i.test(prev) || grid.subgridX || grid.subgridY;
        return `${open}${Math.round(grid.rows)}x${Math.round(grid.cols)}${hasSubgrid ? " subgrid" : ""}${close}`;
      },
    );
  }

  const upsertStringPref = (
    name: string,
    computeValue: (existing: string | undefined) => string,
  ): void => {
    const strPattern = new RegExp(`(<string\\s+name="${name}">)([^<]*)(<\\/string>)`);
    const match = updated.match(strPattern);
    if (match) {
      const nextVal = computeValue(match[2]);
      updated = updated.replace(strPattern, `$1${nextVal}$3`);
    } else {
      const nextVal = computeValue(undefined);
      updated = updated.replace(
        /<\/map>/,
        `    <string name="${name}">${nextVal}</string>\n</map>`,
      );
    }
  };

  if (grid.novaFolderConfigModified === true) {
    upsertStringPref("folder_window_config", (existing) =>
      serializeNovaFolderWindowConfig(
        grid.novaFolderStyle ?? "WINDOW",
        grid.novaFolderRows ?? 4,
        grid.novaFolderCols ?? 4,
        existing,
      ),
    );
  }

  if (grid.novaFolderPreviewModified === true) {
    const clampedPreview: 2 | 3 = (grid.folderPreviewCols ?? 2) >= 3 ? 3 : 2;
    upsertStringPref("folder_icon_config", (existing) =>
      serializeNovaFolderIconConfig(clampedPreview, existing),
    );
  }

  return updated;
}

function buildFreshNovaPrefsXml(grid: GridConfig, screenCount: number): string {
  const rows = Math.round(grid.rows);
  const cols = Math.round(grid.cols);
  const dockCols = Math.round(grid.dockCols);
  const drawerRows = Math.round(grid.drawerRows ?? rows);
  const drawerCols = Math.round(grid.drawerCols ?? cols);
  const subgrid = Boolean(grid.subgridX || grid.subgridY);
  const folderWinStr = serializeNovaFolderWindowConfig(
    grid.novaFolderStyle ?? "IMMERSIVE",
    grid.novaFolderRows ?? 4,
    grid.novaFolderCols ?? 3,
  );
  const folderIconStr = serializeNovaFolderIconConfig((grid.folderPreviewCols ?? 2) >= 3 ? 3 : 2);

  return [
    "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>",
    "<map>",
    '    <int name="preference_version" value="89700" />',
    '    <int name="first_install_version" value="89700" />',
    `    <string name="desktop_grid">${rows}x${cols}${subgrid ? " subgrid" : ""}</string>`,
    `    <int name="desktop_grid_rows" value="${rows}" />`,
    `    <int name="desktop_grid_cols" value="${cols}" />`,
    `    <boolean name="desktop_grid_subgrid" value="${subgrid}" />`,
    `    <int name="workspace_screen_count" value="${Math.max(1, screenCount)}" />`,
    `    <int name="desktop_default_page" value="${Math.max(0, grid.defaultScreenRank)}" />`,
    '    <boolean name="dock_enable" value="true" />',
    `    <int name="dock_grid_cols" value="${dockCols}" />`,
    '    <int name="dock_pages_count" value="1" />',
    `    <string name="drawer_grid">${drawerRows}x${drawerCols}</string>`,
    `    <int name="drawer_app_grid_rows" value="${drawerRows}" />`,
    `    <int name="drawer_app_grid_cols" value="${drawerCols}" />`,
    `    <string name="folder_window_config">${folderWinStr}</string>`,
    `    <string name="folder_icon_config">${folderIconStr}</string>`,
    '    <boolean name="widget_overlap" value="true" />',
    '    <boolean name="widget_overlap_when_placing" value="true" />',
    "</map>",
    "",
  ].join("\n");
}

async function createFreshNovaDatabase() {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  db.run("PRAGMA user_version = 38;");
  db.run(`
    CREATE TABLE favorites (
      _id INTEGER PRIMARY KEY,
      title TEXT,
      intent TEXT,
      container INTEGER,
      screen INTEGER,
      cellX REAL,
      cellY REAL,
      spanX REAL,
      spanY REAL,
      itemType INTEGER,
      appWidgetId INTEGER NOT NULL DEFAULT -1,
      iconPackage TEXT,
      iconResource TEXT,
      icon BLOB,
      appWidgetProvider TEXT,
      modified INTEGER NOT NULL DEFAULT 0,
      restored INTEGER NOT NULL DEFAULT 0,
      profileId INTEGER DEFAULT -1,
      rank INTEGER NOT NULL DEFAULT 0,
      options INTEGER NOT NULL DEFAULT 0,
      appWidgetSource INTEGER NOT NULL DEFAULT -1,
      customIconSource TEXT,
      customIconLoadedState TEXT,
      flingUpIntent TEXT,
      flingDownIntent TEXT,
      zOrder INTEGER DEFAULT 0,
      novaFlags INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE allapps (
      _ID INTEGER PRIMARY KEY,
      componentName TEXT,
      profileId INTEGER DEFAULT -1,
      title TEXT,
      customIconSource TEXT,
      flags INTEGER NOT NULL DEFAULT 0,
      modified INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE appgroups (
      _id INTEGER PRIMARY KEY,
      groupId INTEGER,
      component TEXT,
      modified INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE customIcons (
      _id INTEGER PRIMARY KEY,
      source TEXT,
      icon BLOB NOT NULL,
      adaptivefg BLOB,
      modified INTEGER NOT NULL DEFAULT 0,
      flags INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE drawer_groups (
      _id INTEGER PRIMARY KEY,
      title TEXT,
      category_id TEXT,
      groupType TEXT,
      tabOrder INTEGER DEFAULT -1,
      hideApps BOOLEAN,
      icon BLOB,
      customIconSource TEXT,
      customIconLoadedState TEXT,
      tabColor INTEGER NOT NULL DEFAULT 262914,
      flags INTEGER NOT NULL DEFAULT 0,
      modified INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE android_metadata (locale TEXT);
    CREATE UNIQUE INDEX componentNameProfileId ON allapps (componentName, profileId);
    CREATE UNIQUE INDEX idx_group_cn ON appgroups (groupId, component);
    INSERT INTO android_metadata (locale) VALUES ('en_US');
    INSERT INTO favorites (_id, itemType) VALUES (-1, -1);
  `);
  return db;
}

/**
 * Serialize any `LauncherLayout` into a `.novabackup` ZIP:
 * - **Nova → Nova**: Clones the original `nova.db` + `nova.xml` + companion files and patches
 *   desktop/dock/folder edits losslessly.
 * - **Samsung → Nova**: Synthesizes a valid Nova 8.9.7 (`user_version = 38`) `nova.db` + `nova.xml`
 *   including desktop screens, folders, dock, widgets, and app-drawer folders (`drawer_groups` + `appgroups`).
 */
export async function serializeNovaBackup(layout: LauncherLayout): Promise<Uint8Array> {
  const archive = layout.novaArchive;
  const db = archive ? await openSqlite(archive.databaseBytes) : await createFreshNovaDatabase();

  try {
    const tableInfo = db.exec("PRAGMA table_info(favorites)")[0];
    const columns = new Set<string>(tableInfo ? tableInfo.values.map((r) => String(r[1])) : []);

    const existingIdsRes = db.exec(
      "SELECT _id FROM favorites WHERE container = -100 OR container = -101 OR container >= 0",
    )[0];
    const existingEditableIds = new Set<number>(
      existingIdsRes ? existingIdsRes.values.map((r) => Number(r[0])) : [],
    );

    const maxIdRes = db.exec("SELECT IFNULL(MAX(_id), 0) FROM favorites")[0];
    let nextId = Math.max(1, (maxIdRes ? Number(maxIdRes.values[0]?.[0] ?? 0) : 0) + 1);

    const retainedIds = new Set<number>();

    const upsertItem = (
      item: LayoutItem,
      container: number,
      screen: number,
      cellX: number,
      cellY: number,
      spanX: number,
      spanY: number,
      rank: number,
    ): void => {
      const parsedId = parseNovaNumericId(item.id);
      const isExisting =
        Boolean(archive) && typeof parsedId === "number" && existingEditableIds.has(parsedId);
      const numericId = isExisting ? (parsedId as number) : nextId++;
      retainedIds.add(numericId);

      const titleValue = item.kind === "widget" && !item.novaRaw?.title ? null : item.title;

      if (isExisting) {
        db.run(
          `UPDATE favorites
             SET title = ?, container = ?, screen = ?, cellX = ?, cellY = ?, spanX = ?, spanY = ?, rank = ?
           WHERE _id = ?`,
          [titleValue, container, screen, cellX, cellY, spanX, spanY, rank, numericId],
        );
      } else {
        const providerValue =
          item.kind === "widget"
            ? item.provider ||
              (item.packageName && item.activityName
                ? `${item.packageName}/${item.activityName}`
                : null)
            : null;

        const insertCols: string[] = [
          "_id",
          "title",
          "intent",
          "container",
          "screen",
          "cellX",
          "cellY",
          "spanX",
          "spanY",
          "itemType",
        ];
        const insertVals: (string | number | Uint8Array | null)[] = [
          numericId,
          titleValue,
          buildNovaIntentUri(item),
          container,
          screen,
          cellX,
          cellY,
          spanX,
          spanY,
          novaItemTypeFor(item),
        ];

        if (columns.has("rank")) {
          insertCols.push("rank");
          insertVals.push(rank);
        }
        if (columns.has("icon")) {
          insertCols.push("icon");
          insertVals.push(item.iconBytes ?? null);
        }
        if (columns.has("appWidgetProvider")) {
          insertCols.push("appWidgetProvider");
          insertVals.push(providerValue);
        }
        if (columns.has("appWidgetId")) {
          insertCols.push("appWidgetId");
          insertVals.push(item.kind === "widget" ? (item.appWidgetId ?? -1) : -1);
        }
        if (columns.has("profileId")) {
          insertCols.push("profileId");
          insertVals.push(item.novaMetadata?.profileId ?? (item.isWorkProfile ? 12 : -1));
        }

        const placeholders = insertCols.map(() => "?").join(", ");
        db.run(
          `INSERT INTO favorites (${insertCols.join(", ")}) VALUES (${placeholders})`,
          insertVals,
        );
      }

      if (item.kind === "folder") {
        const folderCols = Math.max(2, layout.grid.novaFolderCols ?? 4);
        item.children.forEach((child, index) => {
          upsertItem(
            child,
            numericId,
            0,
            index % folderCols,
            Math.floor(index / folderCols),
            1,
            1,
            index,
          );
        });
      }
    };

    for (const screen of layout.screens) {
      const screenKey = archive ? screen.id : screen.rank;
      for (const item of screen.items) {
        upsertItem(
          item,
          -100,
          screenKey,
          item.placement.cellX,
          item.placement.cellY,
          item.placement.spanX,
          item.placement.spanY,
          item.placement.rank ?? 0,
        );
      }
    }

    const dockSources =
      layout.dockPages && layout.dockPages.length > 0
        ? layout.dockPages.map((dp) => (dp.page === 0 ? { ...dp, items: layout.hotseat } : dp))
        : [{ page: 0, active: true, items: layout.hotseat }];

    for (const dockPage of dockSources) {
      for (const item of dockPage.items) {
        upsertItem(
          item,
          -101,
          dockPage.page,
          item.placement.cellX,
          0,
          1,
          1,
          item.placement.rank ?? 0,
        );
      }
    }

    if (archive) {
      for (const oldId of existingEditableIds) {
        if (!retainedIds.has(oldId)) {
          db.run("DELETE FROM favorites WHERE _id = ?", [oldId]);
        }
      }

      const wsCheck = db.exec(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspaceScreens'",
      )[0];
      if (wsCheck?.values.length) {
        db.run("DELETE FROM workspaceScreens");
        const now = Date.now();
        layout.screens.forEach((screen, idx) => {
          db.run("INSERT INTO workspaceScreens (_id, screenRank, modified) VALUES (?, ?, ?)", [
            screen.id,
            idx,
            now,
          ]);
        });
      }
    } else if (layout.drawerGroups && layout.drawerGroups.length > 0) {
      // Populate drawer_groups + appgroups when converting Samsung -> Nova
      const now = Date.now();
      let appGroupRowId = 1;
      layout.drawerGroups.forEach((group, idx) => {
        const groupId = idx + 1;
        db.run(
          "INSERT INTO drawer_groups (_id, title, groupType, tabOrder, hideApps, modified) VALUES (?, ?, ?, ?, ?, ?)",
          [groupId, group.title, "FOLDER_APP_GROUP", idx + 1, 1, now],
        );
        for (const member of group.items) {
          if (!member.packageName || !member.activityName) continue;
          const comp = `${member.packageName}/${member.activityName}#-1`;
          db.run(
            "INSERT OR IGNORE INTO appgroups (_id, groupId, component, modified) VALUES (?, ?, ?, ?)",
            [appGroupRowId++, groupId, comp, now],
          );
        }
      });
    }

    const exportedDb = db.export();
    const zip = new JSZip();
    if (archive) {
      zip.file(archive.databaseEntryName, exportedDb);
      if (archive.prefsEntryName && typeof archive.prefsXml === "string") {
        zip.file(
          archive.prefsEntryName,
          patchNovaPrefsXml(archive.prefsXml, layout.grid, layout.screens.length),
        );
      }
      for (const [entryName, content] of Object.entries(archive.extraEntries)) {
        zip.file(entryName, content);
      }
    } else {
      zip.file("nova.db", exportedDb);
      zip.file("nova.xml", buildFreshNovaPrefsXml(layout.grid, layout.screens.length));
    }
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  } finally {
    db.close();
  }
}
