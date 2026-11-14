import XmlConverter from "xml-js";
import { inferFriendlyAppLabel } from "../model/appLabels";
import { parseSamsungFolderGrid } from "../model/folderGrids";
import type {
  AppShortcutItem,
  DeepShortcutItem,
  DrawerGroupModel,
  FolderItem,
  InstalledAppSummary,
  LauncherActionItem,
  LauncherLayout,
  LayoutItem,
  ScreenModel,
  WidgetItem,
} from "../model/types";

export interface SamsungXmlOptions {
  homeOnlyMode?: boolean;
  includeHotseat?: boolean;
  includeAppOrder?: boolean;
  sepVersion?: number;
  deviceType?: "Phone" | "Tablet";
  screenCount?: number;
}

type XmlNode = {
  type?: string;
  name?: string;
  attributes?: Record<string, string>;
  elements?: XmlNode[];
  text?: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array | undefined {
  const cleaned = base64.trim();
  if (!cleaned) return undefined;
  try {
    if (typeof Buffer !== "undefined") {
      return new Uint8Array(Buffer.from(cleaned, "base64"));
    }
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

function element(name: string, attributes?: Record<string, string>, elements?: XmlNode[]): XmlNode {
  return {
    type: "element",
    name,
    ...(attributes && Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(elements && elements.length > 0 ? { elements } : {}),
  };
}

function textElement(name: string, value: string | number | boolean): XmlNode {
  return element(name, undefined, [{ type: "text", text: String(value) }]);
}

function serializeChildInsideFolder(child: LayoutItem, index: number): XmlNode | undefined {
  if (child.kind === "deepShortcut") {
    return element("deepshortcut", {
      screen: String(index),
      title: child.title,
      ...(child.iconBytes ? { icon: bytesToBase64(child.iconBytes) } : {}),
      uri: child.intentUri,
    });
  }
  if (child.kind === "app") {
    return element("favorite", {
      screen: String(index),
      packageName: child.packageName,
      className: child.activityName,
    });
  }
  return undefined;
}

function serializeHomeItem(item: LayoutItem, screenRank: number): XmlNode | undefined {
  const x = String(Math.max(0, Math.round(item.placement.cellX)));
  const y = String(Math.max(0, Math.round(item.placement.cellY)));
  const spanX = String(Math.max(1, Math.round(item.placement.spanX)));
  const spanY = String(Math.max(1, Math.round(item.placement.spanY)));

  if (item.kind === "folder") {
    const folderChildren = item.children
      .map((child, idx) => serializeChildInsideFolder(child, idx))
      .filter((node): node is XmlNode => Boolean(node));
    return element(
      "folder",
      {
        screen: String(screenRank),
        x,
        y,
        spanX: "1",
        spanY: "1",
        ...(item.title ? { title: item.title } : {}),
        options: String(item.options ?? 0),
        color: String(item.color ?? -1),
      },
      folderChildren,
    );
  }

  if (item.kind === "deepShortcut") {
    return element("deepshortcut", {
      screen: String(screenRank),
      x,
      y,
      title: item.title,
      ...(item.iconBytes ? { icon: bytesToBase64(item.iconBytes) } : {}),
      uri: item.intentUri,
    });
  }

  if (item.kind === "widget") {
    if (item.stackedWidgets && item.stackedWidgets.length > 0) {
      return element(
        "stackedwidget",
        {
          screen: String(screenRank),
          x,
          y,
          spanX,
          spanY,
          options: "0",
        },
        item.stackedWidgets.map((internal, stackIndex) =>
          element("internalwidget", {
            type: "widget",
            screen: String(stackIndex),
            packageName: internal.packageName,
            className: internal.activityName || internal.provider,
            spanX: String(Math.max(1, Math.round(internal.placement.spanX))),
            spanY: String(Math.max(1, Math.round(internal.placement.spanY))),
            appWidgetID: String(internal.appWidgetId ?? -1),
          }),
        ),
      );
    }
    return element("appwidget", {
      screen: String(screenRank),
      x,
      y,
      spanX,
      spanY,
      packageName: item.packageName,
      className: item.activityName || item.provider,
      appWidgetID: String(item.appWidgetId ?? -1),
    });
  }

  if (item.kind === "app") {
    return element("favorite", {
      screen: String(screenRank),
      x,
      y,
      packageName: item.packageName,
      className: item.activityName,
    });
  }

  return undefined;
}

function serializeHotseatItem(item: LayoutItem): XmlNode | undefined {
  const slot = String(Math.max(0, Math.round(item.placement.screenRank ?? item.placement.cellX)));

  if (item.kind === "folder") {
    const folderChildren = item.children
      .map((child, idx) => serializeChildInsideFolder(child, idx))
      .filter((node): node is XmlNode => Boolean(node));
    return element(
      "folder",
      {
        screen: slot,
        ...(item.title ? { title: item.title } : {}),
        options: String(item.options ?? 0),
        color: String(item.color ?? -1),
      },
      folderChildren,
    );
  }

  if (item.kind === "deepShortcut") {
    return element("deepshortcut", {
      screen: slot,
      title: item.title,
      ...(item.iconBytes ? { icon: bytesToBase64(item.iconBytes) } : {}),
      uri: item.intentUri,
    });
  }

  if (item.kind === "app") {
    return element("favorite", {
      screen: slot,
      packageName: item.packageName,
      className: item.activityName,
    });
  }

  return undefined;
}

function buildGridList(cols: number, rows: number): string {
  const defaults = new Set<string>(["4x6", "5x6", `${cols}x${rows}`]);
  return `${[...defaults].join(",")},`;
}

/**
 * Serialize a `LauncherLayout` to Samsung One UI Home's multi-element `.exml` XML format,
 * verified against Samsung One UI Home 18 and Good Lock Home Up 18.
 */
export function serializeSamsungXml(
  layout: LauncherLayout,
  options: SamsungXmlOptions = {},
): string {
  const homeOnly = options.homeOnlyMode ?? layout.rawPrefs?.homeOnlyMode === true;
  const includeHotseat = options.includeHotseat ?? true;
  const hasDrawerContent =
    (layout.drawerGroups && layout.drawerGroups.length > 0) ||
    (layout.drawerItems && layout.drawerItems.length > 0);
  const includeAppOrder = !homeOnly && (options.includeAppOrder ?? Boolean(hasDrawerContent));

  const categories: string[] = [];
  if (homeOnly) {
    categories.push("homeOnly");
    if (includeHotseat) categories.push("hotseat_homeOnly");
  } else {
    categories.push("home");
    if (includeHotseat) categories.push("hotseat");
    if (includeAppOrder) categories.push("appOrder");
  }

  const pageCount = options.screenCount ?? Math.max(1, layout.screens.length);
  const screenIndex = Math.max(0, Math.min(pageCount - 1, layout.grid.defaultScreenRank));
  const drawerRows = layout.grid.drawerRows ?? layout.grid.rows;
  const drawerCols = layout.grid.drawerCols ?? layout.grid.cols;

  const sortedScreens = [...layout.screens].sort((a, b) => a.rank - b.rank);
  const homeChildren: XmlNode[] = [];
  sortedScreens.forEach((screen, denseRank) => {
    for (const item of screen.items) {
      const node = serializeHomeItem(item, denseRank);
      if (node) homeChildren.push(node);
    }
  });

  const hotseatChildren: XmlNode[] = includeHotseat
    ? layout.hotseat.map(serializeHotseatItem).filter((node): node is XmlNode => Boolean(node))
    : [];

  const topNodes: XmlNode[] = [
    textElement("category", categories.join(",")),
    textElement("sep_version", options.sepVersion ?? 180000),
    textElement("device_type", options.deviceType ?? "Phone"),
    textElement("restore_max_size_grid", true),
    textElement("home_grid_list", buildGridList(layout.grid.cols, layout.grid.rows)),
    textElement("apps_grid_list", buildGridList(drawerCols, drawerRows)),
    textElement("folder_grid_list", "3x4,4x4,"),
    textElement("app_label_setting", true),
    textElement("widget_label_setting", false),
    textElement("need_correction_item_position_port", false),
    textElement("need_correction_item_position_land", false),
    textElement("expand_hotseat_size", layout.grid.dockCols),
    textElement("FolderGrid", layout.grid.folderGrid ?? "3X3"),
    textElement("Rows", layout.grid.rows),
    textElement("Columns", layout.grid.cols),
    textElement("PageCount", pageCount),
    textElement("ScreenIndex", screenIndex),
    element(homeOnly ? "homeOnly" : "home", undefined, homeChildren),
  ];

  if (includeHotseat) {
    topNodes.push(element(homeOnly ? "hotseat_homeOnly" : "hotseat", undefined, hotseatChildren));
  }

  if (includeAppOrder) {
    const appOrderChildren: XmlNode[] = [];
    const perPage = Math.max(1, drawerCols * drawerRows);
    let folderIndex = 0;
    for (const group of layout.drawerGroups ?? []) {
      const children = group.items
        .map((child, idx) => serializeChildInsideFolder(child, idx))
        .filter((node): node is XmlNode => Boolean(node));
      if (children.length === 0) continue;
      const folderPage = Math.floor(folderIndex / perPage);
      folderIndex += 1;
      appOrderChildren.push(
        element(
          "folder",
          {
            screen: String(folderPage),
            ...(group.title ? { title: group.title } : {}),
            options: "0",
            color: "-1",
          },
          children,
        ),
      );
    }
    for (const item of layout.drawerItems ?? []) {
      if (item.kind !== "app") continue;
      appOrderChildren.push(
        element("favorite", {
          screen: String(item.placement.screenRank ?? 0),
          packageName: item.packageName,
          className: item.activityName,
          hidden: item.hidden ? "1" : "0",
        }),
      );
    }
    topNodes.push(
      textElement("viewType_appOrder", "ALPHABETIC"),
      textElement("Rows_appOrder", drawerRows),
      textElement("Columns_appOrder", drawerCols),
      element("appOrder", undefined, appOrderChildren),
    );
  }

  // Emit exact Samsung XmlSerializer header + flat sibling top-level elements
  const renderedBlocks = topNodes.map((node) =>
    XmlConverter.js2xml({ elements: [node] } as unknown as XmlConverter.Element, { spaces: 2 }),
  );

  return ["<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>", ...renderedBlocks, ""].join(
    "\n",
  );
}

function findElements(node: XmlNode, names: Set<string>): XmlNode[] {
  const result: XmlNode[] = [];
  if (node.name && names.has(node.name.toLowerCase())) {
    result.push(node);
  }
  node.elements?.forEach((child) => result.push(...findElements(child, names)));
  return result;
}

function findFirstElement(node: XmlNode, ...names: string[]): XmlNode | undefined {
  return findElements(node, new Set(names.map((name) => name.toLowerCase())))[0];
}

function elementText(node: XmlNode | undefined): string | undefined {
  const textNode = node?.elements?.find((child) => child.type === "text");
  return typeof textNode?.text === "string" ? textNode.text.trim() : undefined;
}

function elementNumber(node: XmlNode | undefined, fallback: number): number {
  const raw = elementText(node);
  if (typeof raw === "undefined" || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function attribute(node: XmlNode, ...names: string[]): string {
  const attributes = node.attributes ?? {};
  for (const name of names) {
    if (typeof attributes[name] === "string") return attributes[name];
    const matchKey = Object.keys(attributes).find(
      (key) => key.toLowerCase() === name.toLowerCase(),
    );
    if (matchKey && typeof attributes[matchKey] === "string") {
      return attributes[matchKey];
    }
  }
  return "";
}

function numberAttribute(node: XmlNode, names: string[], fallback: number): number {
  const raw = attribute(node, ...names);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const ITEM_TAG_NAMES = new Set([
  "favorite",
  "folder",
  "appwidget",
  "stackedwidget",
  "internalwidget",
  "deepshortcut",
  "widget",
  "shortcut",
  "action",
]);

function parseSamsungItemNode(
  node: XmlNode,
  container: "desktop" | "hotseat" | "folder" | "drawer",
  fallbackScreen: number,
  sequence: { value: number },
): LayoutItem {
  const tag = (node.name ?? "favorite").toLowerCase();
  const packageName = attribute(node, "packageName", "package");
  const activityName = attribute(node, "className", "activityName", "class");
  const screenVal = numberAttribute(node, ["screen", "screenRank", "rank"], fallbackScreen);
  const cellX =
    container === "hotseat"
      ? numberAttribute(node, ["x", "cellX"], screenVal)
      : numberAttribute(node, ["x", "cellX"], 0);
  const cellY = container === "hotseat" ? 0 : numberAttribute(node, ["y", "cellY"], 0);
  const spanX = Math.max(1, numberAttribute(node, ["spanX"], 1));
  const spanY = Math.max(1, numberAttribute(node, ["spanY"], 1));
  const uri = attribute(node, "uri", "intent", "intentUri");
  const iconBase64 = attribute(node, "icon");
  const iconBytes = iconBase64 ? base64ToBytes(iconBase64) : undefined;
  const friendlyLabel = inferFriendlyAppLabel(packageName, activityName);
  const userIdMatch = uri.match(/(?:i\.userid|l\.profile)=(\d+)/);
  const isWorkProfile = userIdMatch ? Number(userIdMatch[1]) > 0 : false;

  const base = {
    id: attribute(node, "id") || `samsung:${sequence.value++}`,
    title:
      tag === "folder"
        ? attribute(node, "title", "label")
        : attribute(node, "title", "label") || friendlyLabel || packageName,
    packageName,
    activityName,
    intentUri: uri,
    placement: {
      container,
      screenRank: screenVal,
      cellX,
      cellY,
      spanX,
      spanY,
      rank: numberAttribute(node, ["rank", "screen"], screenVal),
    },
    ...(iconBytes ? { iconBytes } : {}),
    ...(isWorkProfile ? { isWorkProfile: true } : {}),
    ...(attribute(node, "hidden") === "1" ? { hidden: true } : {}),
    novaRaw: { samsungTag: node.name ?? "favorite" },
  };

  if (tag === "folder") {
    const children = (node.elements ?? [])
      .filter((child) => child.name && ITEM_TAG_NAMES.has(child.name.toLowerCase()))
      .map((child, idx) => parseSamsungItemNode(child, "folder", idx, sequence))
      .sort((a, b) => (a.placement.rank ?? 0) - (b.placement.rank ?? 0));
    return {
      ...base,
      kind: "folder",
      children,
      options: numberAttribute(node, ["options"], 0),
      color: numberAttribute(node, ["color"], -1),
    } satisfies FolderItem;
  }

  if (tag === "stackedwidget") {
    const stackedWidgets = (node.elements ?? [])
      .filter((child) => (child.name ?? "").toLowerCase() === "internalwidget")
      .map((child, idx) => parseSamsungItemNode(child, "desktop", idx, sequence) as WidgetItem);
    const primary = stackedWidgets[0];
    return {
      ...base,
      title: primary?.packageName ? `Stacked (${stackedWidgets.length} widgets)` : "Stacked Widget",
      packageName: primary?.packageName ?? "",
      activityName: primary?.activityName ?? "",
      kind: "widget",
      provider: primary?.provider ?? "stackedwidget",
      appWidgetId: primary?.appWidgetId,
      stackedWidgets,
    } satisfies WidgetItem;
  }

  if (tag === "appwidget" || tag === "internalwidget" || tag === "widget") {
    const provider =
      attribute(node, "provider") ||
      (packageName && activityName ? `${packageName}/${activityName}` : packageName);
    return {
      ...base,
      kind: "widget",
      provider,
      appWidgetId: numberAttribute(node, ["appWidgetID", "appWidgetId"], -1),
    } satisfies WidgetItem;
  }

  if (tag === "deepshortcut" || tag === "shortcut") {
    return {
      ...base,
      kind: "deepShortcut",
    } satisfies DeepShortcutItem;
  }

  if (tag === "action") {
    return {
      ...base,
      kind: "launcherAction",
      action: attribute(node, "action") || uri,
    } satisfies LauncherActionItem;
  }

  return {
    ...base,
    kind: "app",
  } satisfies AppShortcutItem;
}

/**
 * Parse Samsung One UI Home `.exml` XML (supports both One UI Home's rootless
 * multi-element XML stream and single-root `<favorites>` / `<home>` documents).
 */
export function parseSamsungXml(xml: string): LauncherLayout {
  const withoutDeclaration = xml.replace(/^\uFEFF/, "").replace(/^\s*<\?xml[^?]*\?>\s*/i, "");
  const wrappedXml = `<__samsung_doc__>\n${withoutDeclaration}\n</__samsung_doc__>`;
  const doc = XmlConverter.xml2js(wrappedXml, {
    compact: false,
    trim: true,
  }) as unknown as XmlNode;

  const rootWrapper = doc.elements?.[0] ?? doc;
  const homeNode = findFirstElement(rootWrapper, "home", "homeOnly") ?? rootWrapper;
  const hotseatNode = findFirstElement(rootWrapper, "hotseat", "hotseat_homeOnly");
  const appOrderNode = findFirstElement(rootWrapper, "appOrder");

  const rows = elementNumber(findFirstElement(rootWrapper, "Rows"), 6);
  const cols = elementNumber(findFirstElement(rootWrapper, "Columns"), 5);
  const pageCount = elementNumber(findFirstElement(rootWrapper, "PageCount", "ScreenCount"), 1);
  const screenIndex = elementNumber(findFirstElement(rootWrapper, "ScreenIndex"), 0);
  const dockCols = elementNumber(
    findFirstElement(rootWrapper, "expand_hotseat_size"),
    numberAttribute(hotseatNode ?? {}, ["Columns", "columns"], 5),
  );
  const parsedFolderGrid = parseSamsungFolderGrid(
    elementText(findFirstElement(rootWrapper, "FolderGrid", "FolderGrid_homeOnly")) ?? "3X4",
  );
  const folderGrid = parsedFolderGrid.normalized;
  const drawerRows = elementNumber(findFirstElement(rootWrapper, "Rows_appOrder"), rows);
  const drawerCols = elementNumber(findFirstElement(rootWrapper, "Columns_appOrder"), cols);

  const sequence = { value: 0 };
  const screensByRank = new Map<number, ScreenModel>();

  // Legacy synthetic `<screen>` nodes if present, otherwise standard flat `<home>` items
  const explicitScreenNodes = (homeNode.elements ?? []).filter(
    (child) => (child.name ?? "").toLowerCase() === "screen",
  );

  if (explicitScreenNodes.length > 0) {
    for (const screenEl of explicitScreenNodes) {
      const rank = numberAttribute(screenEl, ["rank", "screen"], screensByRank.size);
      const items = (screenEl.elements ?? [])
        .filter((child) => child.name && ITEM_TAG_NAMES.has(child.name.toLowerCase()))
        .map((child) => parseSamsungItemNode(child, "desktop", rank, sequence));
      screensByRank.set(rank, {
        id: numberAttribute(screenEl, ["id"], rank),
        rank,
        items,
      });
    }
  } else {
    const directHomeItems = (homeNode.elements ?? []).filter(
      (child) => child.name && ITEM_TAG_NAMES.has(child.name.toLowerCase()),
    );
    for (const child of directHomeItems) {
      const parsed = parseSamsungItemNode(child, "desktop", 0, sequence);
      const rank = parsed.placement.screenRank;
      const screen = screensByRank.get(rank) ?? { id: rank, rank, items: [] };
      screen.items.push(parsed);
      screensByRank.set(rank, screen);
    }
    // Ensure empty pages up to PageCount exist if declared
    for (let page = 0; page < pageCount; page += 1) {
      if (!screensByRank.has(page) && directHomeItems.length > 0) {
        screensByRank.set(page, { id: page, rank: page, items: [] });
      }
    }
  }

  const hotseat: LayoutItem[] = hotseatNode
    ? (hotseatNode.elements ?? [])
        .filter((child) => child.name && ITEM_TAG_NAMES.has(child.name.toLowerCase()))
        .map((child) => parseSamsungItemNode(child, "hotseat", 0, sequence))
        .sort((a, b) => a.placement.cellX - b.placement.cellX)
    : [];

  const drawerGroups: DrawerGroupModel[] = [];
  const drawerItems: LayoutItem[] = [];
  if (appOrderNode) {
    let folderIndex = 0;
    for (const child of appOrderNode.elements ?? []) {
      const tag = (child.name ?? "").toLowerCase();
      if (!ITEM_TAG_NAMES.has(tag)) continue;
      const parsed = parseSamsungItemNode(child, "drawer", 0, sequence);
      if (parsed.kind === "folder") {
        drawerGroups.push({
          id: folderIndex,
          title: parsed.title,
          groupType: "FOLDER_APP_GROUP",
          tabOrder: folderIndex,
          items: parsed.children,
        });
        folderIndex += 1;
      } else {
        drawerItems.push(parsed);
      }
    }
  }

  const rawPrefs: Record<string, string | number | boolean> = {
    pageCount,
    screenIndex,
  };
  const categoryText = elementText(findFirstElement(rootWrapper, "category"));
  if (categoryText) rawPrefs.category = categoryText;
  const sepVersion = elementText(findFirstElement(rootWrapper, "sep_version"));
  if (sepVersion) rawPrefs.sep_version = Number(sepVersion) || sepVersion;
  const deviceType = elementText(findFirstElement(rootWrapper, "device_type"));
  if (deviceType) rawPrefs.device_type = deviceType;
  if (homeNode.name?.toLowerCase() === "homeonly") {
    rawPrefs.homeOnlyMode = true;
  }

  const screens = [...screensByRank.values()].sort((a, b) => a.rank - b.rank);

  const catalogMap = new Map<string, InstalledAppSummary>();
  const collectItem = (item: LayoutItem): void => {
    if (item.kind === "folder") {
      item.children.forEach(collectItem);
      return;
    }
    if (item.kind !== "app" || !item.packageName) return;
    const key = `${item.packageName}/${item.activityName}`;
    const existing = catalogMap.get(key);
    if (existing) {
      if (!existing.iconBytes && item.iconBytes) existing.iconBytes = item.iconBytes;
    } else {
      catalogMap.set(key, {
        packageName: item.packageName,
        activityName: item.activityName,
        title: item.title || item.packageName,
        ...(item.isWorkProfile ? { isWorkProfile: true } : {}),
        ...(item.iconBytes ? { iconBytes: item.iconBytes } : {}),
      });
    }
  };
  for (const screen of screens) screen.items.forEach(collectItem);
  hotseat.forEach(collectItem);
  for (const group of drawerGroups) group.items.forEach(collectItem);
  drawerItems.forEach(collectItem);

  const appCatalog = [...catalogMap.values()].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  );

  return {
    sourceFormat: "samsung",
    grid: {
      rows,
      cols,
      dockCols,
      defaultScreenRank: screenIndex,
      drawerRows,
      drawerCols,
      folderGrid,
      folderPreviewCols: 3,
      novaFolderStyle: "IMMERSIVE",
      novaFolderCols: parsedFolderGrid.cols,
      novaFolderRows: parsedFolderGrid.rows,
    },
    screens,
    hotseat,
    ...(drawerGroups.length > 0 ? { drawerGroups } : {}),
    ...(drawerItems.length > 0 ? { drawerItems } : {}),
    ...(appCatalog.length > 0 ? { appCatalog } : {}),
    rawPrefs,
    warnings: [],
  };
}
