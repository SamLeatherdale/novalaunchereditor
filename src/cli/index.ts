import { Command, InvalidArgumentError, Option } from "@commander-js/extra-typings";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, parse as parsePath } from "node:path";
import {
  convertLayout,
  convertToNovaLayout,
  decodeSamsungExml,
  encryptSamsung,
  parseNovaBackup,
  parseSamsungXml,
  renderSamsungPreviewPng,
  serializeNovaBackup,
  serializeSamsungXml,
  type LauncherLayout,
  type LayoutItem,
  type SamsungSecurityLevel,
} from "../core/index";

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Must be a positive integer.");
  }
  return parsed;
}

function parseSecurityLevel(value: string): SamsungSecurityLevel {
  if (value === "0") return 0;
  if (value === "1") return 1;
  throw new InvalidArgumentError("Security level must be 0 or 1.");
}

async function loadInputLayout(
  filepath: string,
  key?: string,
  securityLevel: SamsungSecurityLevel = 0,
): Promise<{ layout: LauncherLayout; encrypted?: boolean }> {
  const bytes = new Uint8Array(await readFile(filepath));
  const ext = extname(filepath).toLowerCase();

  if (ext === ".novabackup" || ext === ".zip") {
    return { layout: await parseNovaBackup(bytes) };
  }
  if (ext === ".exml") {
    const decoded = await decodeSamsungExml(bytes, key, { securityLevel });
    return {
      layout: parseSamsungXml(decoded.xml),
      encrypted: decoded.encrypted,
    };
  }
  if (ext === ".xml") {
    return {
      layout: parseSamsungXml(new TextDecoder().decode(bytes)),
      encrypted: false,
    };
  }
  throw new Error(
    `Unsupported file extension "${ext || "(none)"}". Expected .novabackup, .zip, .exml, or .xml.`,
  );
}

function countByKind(items: LayoutItem[]): Record<string, number> {
  const counts: Record<string, number> = {
    app: 0,
    folder: 0,
    folderChildren: 0,
    widget: 0,
    deepShortcut: 0,
    launcherAction: 0,
  };
  for (const item of items) {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    if (item.kind === "folder") {
      counts.folderChildren += item.children.length;
    }
  }
  return counts;
}

function buildStats(layout: LauncherLayout, encrypted?: boolean) {
  const desktopItems = layout.screens.flatMap((screen) => screen.items);
  const desktopCounts = countByKind(desktopItems);
  const hotseatCounts = countByKind(layout.hotseat);
  const subgridItems = desktopItems.filter(
    (item) =>
      !Number.isInteger(item.placement.cellX) ||
      !Number.isInteger(item.placement.cellY) ||
      !Number.isInteger(item.placement.spanX) ||
      !Number.isInteger(item.placement.spanY),
  ).length;
  const swipeItems = [...desktopItems, ...layout.hotseat].filter((item) =>
    Boolean(item.novaMetadata?.flingUpIntent || item.novaMetadata?.flingDownIntent),
  ).length;

  return {
    sourceFormat: layout.sourceFormat,
    ...(typeof encrypted === "boolean" ? { encrypted } : {}),
    grid: layout.grid,
    screenCount: layout.screens.length,
    screens: layout.screens.map((s) => ({
      id: s.id,
      rank: s.rank,
      itemCount: s.items.length,
    })),
    desktopCounts,
    hotseatCount: layout.hotseat.length,
    hotseatCounts,
    dockPageCount: layout.dockPages?.length ?? (layout.hotseat.length > 0 ? 1 : 0),
    drawerGroupCount: layout.drawerGroups?.length ?? 0,
    drawerItemCount: layout.drawerItems?.length ?? 0,
    subgridItemCount: subgridItems,
    swipeGestureItemCount: swipeItems,
    warningCount: layout.warnings.length,
    warnings: layout.warnings,
  };
}

function formatHumanSummary(filepath: string, layout: LauncherLayout, encrypted?: boolean): string {
  const stats = buildStats(layout, encrypted);
  const lines = [
    `File: ${filepath}`,
    `Format: ${stats.sourceFormat}${
      typeof encrypted === "boolean"
        ? encrypted
          ? " (AES-encrypted Smart Switch .exml)"
          : " (plaintext Home Up .exml / XML)"
        : ""
    }`,
    `Grid: ${layout.grid.rows} rows × ${layout.grid.cols} cols | Dock: ${layout.grid.dockCols} cols | Default page: ${layout.grid.defaultScreenRank + 1}`,
    `Screens (${stats.screenCount}): ${stats.screens
      .map((s) => `#${s.rank + 1} [id=${s.id}]: ${s.itemCount} items`)
      .join(", ")}`,
    `Desktop items: ${stats.desktopCounts.app} apps, ${stats.desktopCounts.folder} folders (${stats.desktopCounts.folderChildren} children), ${stats.desktopCounts.widget} widgets, ${stats.desktopCounts.deepShortcut} shortcuts`,
    `Hotseat (page 0): ${stats.hotseatCount} items (${stats.hotseatCounts.app} apps, ${stats.hotseatCounts.folder} folders with ${stats.hotseatCounts.folderChildren} children)`,
  ];

  if (layout.dockPages && layout.dockPages.length > 1) {
    lines.push(
      `Nova dock pages: ${layout.dockPages.length} total (${layout.grid.activeDockPages ?? 1} active in prefs)`,
    );
  }
  if (stats.drawerGroupCount > 0 || stats.drawerItemCount > 0) {
    lines.push(
      `App drawer: ${stats.drawerGroupCount} groups/folders, ${stats.drawerItemCount} top-level apps`,
    );
  }
  if (stats.subgridItemCount > 0 || stats.swipeGestureItemCount > 0) {
    lines.push(
      `Nova-specific features: ${stats.subgridItemCount} subgrid items, ${stats.swipeGestureItemCount} icon swipe gestures`,
    );
  }
  if (stats.warnings.length > 0) {
    lines.push(`Warnings (${stats.warnings.length}):`);
    for (const warning of stats.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  return lines.join("\n");
}

function serializeLayoutJson(layout: LauncherLayout): unknown {
  return JSON.parse(
    JSON.stringify(layout, (key, value: unknown) => {
      if (key === "iconBytes" && value) return "[Uint8Array omitted]";
      if (key === "novaRaw" || key === "novaArchive") return undefined;
      return value;
    }),
  );
}

const program = new Command()
  .name("nova-samsung")
  .description(
    "Inspect Nova Launcher (.novabackup) and Samsung One UI Home (.exml / .xml) backups, and convert Nova layouts for Samsung Good Lock Home Up or Smart Switch.",
  )
  .version("0.2.0")
  .showHelpAfterError();

program
  .command("inspect")
  .description(
    "Parse and inspect a .novabackup, Home Up plaintext .exml, Smart Switch encrypted .exml, or .xml file.",
  )
  .argument("<file>", "Path to .novabackup, .zip, .exml, or .xml backup file")
  .option(
    "-k, --key <sessionKey>",
    "Session key (only required for AES-encrypted Smart Switch .exml)",
  )
  .addOption(
    new Option("--security-level <level>", "Smart Switch AES key derivation level")
      .choices(["0", "1"] as const)
      .default("0")
      .argParser(parseSecurityLevel),
  )
  .option("--json", "Emit machine-readable JSON output", false)
  .option(
    "--summary-only",
    "With --json, omit full item tree and emit summary statistics only",
    false,
  )
  .addHelpText(
    "after",
    `
Examples:
  $ pnpm cli inspect ./my-layout.novabackup
  $ pnpm cli inspect ./1700000000000.exml --json --summary-only`,
  )
  .action(async (file, options) => {
    const { layout, encrypted } = await loadInputLayout(
      file,
      options.key,
      options.securityLevel as SamsungSecurityLevel,
    );
    if (options.json) {
      const stats = buildStats(layout, encrypted);
      const payload = options.summaryOnly
        ? { file, ...stats }
        : { file, stats, layout: serializeLayoutJson(layout) };
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${formatHumanSummary(file, layout, encrypted)}\n`);
  });

program
  .command("convert")
  .description(
    "Convert a Nova Launcher backup into a Samsung One UI Home layout (.exml for Home Up, or --homeup-dir for a complete .AutoBackup + .AutoBackupPreview bundle).",
  )
  .argument("<input>", "Source .novabackup (or .exml / .xml) file")
  .option("-o, --output <file>", "Output .exml or .xml file path")
  .option(
    "--homeup-dir <dir>",
    "Write a ready-to-push Home Up directory pair (<dir>/.AutoBackup/<millis>.exml and <dir>/.AutoBackupPreview/<millis>.png)",
  )
  .option(
    "--timestamp <millis>",
    "Explicit millisecond basename when using --homeup-dir (defaults to Date.now())",
  )
  .option("--preview-png <file>", "Optional output path for a 360x780 Home Up preview PNG")
  .option("--rows <n>", "Target desktop grid rows (defaults to source rows)", parsePositiveInt)
  .option("--cols <n>", "Target desktop grid columns (defaults to source cols)", parsePositiveInt)
  .option(
    "--dock-cols <n>",
    "Target hotseat slot count (defaults to source dock cols)",
    parsePositiveInt,
  )
  .addOption(
    new Option("--scale <mode>", "Coordinate mapping strategy when grid sizes differ")
      .choices(["proportional", "clamp"] as const)
      .default("proportional"),
  )
  .option("--home-only", "Export One UI Home-Only layout (<homeOnly> / <hotseat_homeOnly>)", false)
  .option(
    "--include-drawer-folders",
    "Export Nova app-drawer folders into Samsung <appOrder> (default: true)",
    true,
  )
  .option("--no-include-drawer-folders", "Omit Nova app-drawer folders from <appOrder>")
  .option(
    "--include-drawer-tabs",
    "Convert Nova custom drawer tabs (TAB_APP_GROUP) into Samsung <appOrder> folders (default: true)",
    true,
  )
  .option("--no-include-drawer-tabs", "Skip Nova custom drawer tabs when exporting <appOrder>")
  .option(
    "--keep-widgets",
    "Emit <appwidget appWidgetID='-1'> entries so One UI Home re-binds providers (default: true)",
    true,
  )
  .option("--no-keep-widgets", "Skip widgets and leave their cells empty")
  .option(
    "-k, --key <sessionKey>",
    "Encrypt output .exml for Smart Switch using this session key (omit for Home Up plaintext .exml)",
  )
  .addOption(
    new Option(
      "--security-level <level>",
      "Smart Switch AES key derivation level when --key is used",
    )
      .choices(["0", "1"] as const)
      .default("0")
      .argParser(parseSecurityLevel),
  )
  .option("--gzip", "Gzip XML payload before AES encryption (only used with --key)", false)
  .option("--source-key <sessionKey>", "Session key if <input> is an encrypted .exml")
  .option("--json", "Emit structured JSON conversion summary", false)
  .addHelpText(
    "after",
    `
Examples:
  $ pnpm cli convert ./my-layout.novabackup -o ./converted.exml
  $ pnpm cli convert ./my-layout.novabackup --homeup-dir ./homeup-out --include-drawer-folders --json`,
  )
  .action(async (input, options) => {
    if (!options.output && !options.homeupDir) {
      throw new Error("Specify at least one of -o/--output <file> or --homeup-dir <dir>.");
    }

    const level = options.securityLevel as SamsungSecurityLevel;
    const { layout: source } = await loadInputLayout(input, options.sourceKey, level);

    if (
      options.output &&
      !options.homeupDir &&
      extname(options.output).toLowerCase() === ".novabackup"
    ) {
      const novaResult = convertToNovaLayout(source);
      await mkdir(dirname(options.output), { recursive: true });
      await writeFile(options.output, await serializeNovaBackup(novaResult.layout));
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              input,
              writtenFiles: [options.output],
              encrypted: false,
              stats: buildStats(novaResult.layout),
              conversionWarnings: novaResult.warnings,
            },
            null,
            2,
          )}\n`,
        );
      } else {
        process.stdout.write(`Wrote Nova backup: ${options.output}\n`);
        for (const warning of novaResult.warnings) {
          process.stdout.write(`  - [${warning.code}] ${warning.message}\n`);
        }
      }
      return;
    }

    const converted = convertLayout(source, {
      targetRows: options.rows ?? source.grid.rows,
      targetCols: options.cols ?? source.grid.cols,
      targetDockCols: options.dockCols ?? source.grid.dockCols,
      scaleMode: options.scale,
      homeOnlyMode: options.homeOnly,
      includeDrawerFolders: options.includeDrawerFolders,
      includeDrawerTabs: options.includeDrawerTabs,
      keepWidgets: options.keepWidgets,
    });

    const xml = serializeSamsungXml(converted.layout, {
      homeOnlyMode: options.homeOnly,
      includeAppOrder: options.includeDrawerFolders,
    });

    const writtenFiles: string[] = [];

    if (options.output) {
      await mkdir(dirname(options.output), { recursive: true });
      if (extname(options.output).toLowerCase() === ".novabackup") {
        await writeFile(options.output, await serializeNovaBackup(source));
      } else if (options.key) {
        const encryptedBytes = await encryptSamsung(xml, options.key, {
          securityLevel: level,
          gzip: options.gzip,
        });
        await writeFile(options.output, encryptedBytes);
      } else {
        await writeFile(options.output, xml, "utf8");
      }
      writtenFiles.push(options.output);
    }

    if (options.previewPng) {
      await mkdir(dirname(options.previewPng), { recursive: true });
      const png = await renderSamsungPreviewPng(converted.layout);
      await writeFile(options.previewPng, png);
      writtenFiles.push(options.previewPng);
    }

    if (options.homeupDir) {
      const stamp = options.timestamp ?? String(Date.now());
      const autoBackupDir = join(options.homeupDir, ".AutoBackup");
      const previewDir = join(options.homeupDir, ".AutoBackupPreview");
      await mkdir(autoBackupDir, { recursive: true });
      await mkdir(previewDir, { recursive: true });

      const exmlPath = join(autoBackupDir, `${stamp}.exml`);
      const pngPath = join(previewDir, `${stamp}.png`);
      await writeFile(exmlPath, xml, "utf8");
      await writeFile(pngPath, await renderSamsungPreviewPng(converted.layout));
      writtenFiles.push(exmlPath, pngPath);
    }

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            input,
            writtenFiles,
            encrypted: Boolean(options.key),
            stats: buildStats(converted.layout, Boolean(options.key)),
            conversionWarnings: converted.warnings,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    process.stdout.write(`Wrote: ${writtenFiles.join(", ")}\n`);
    process.stdout.write(
      `Converted grid: ${converted.layout.grid.rows}×${converted.layout.grid.cols}, ${converted.layout.screens.length} screens, ${converted.layout.hotseat.length} hotseat items.\n`,
    );
    if (converted.warnings.length > 0) {
      process.stdout.write(`Conversion warnings (${converted.warnings.length}):\n`);
      for (const warning of converted.warnings) {
        process.stdout.write(`  - [${warning.code}] ${warning.message}\n`);
      }
    }
  });

program
  .command("decrypt")
  .description("Decode or decrypt a Samsung .exml file to UTF-8 XML.")
  .argument("<input>", "Input .exml path")
  .option("-o, --output <file>", "Output .xml path (defaults to <input-stem>.xml)")
  .option(
    "-k, --key <sessionKey>",
    "Session key (required if the .exml is Smart Switch AES-encrypted)",
  )
  .addOption(
    new Option("--security-level <level>", "Smart Switch AES key derivation level")
      .choices(["0", "1"] as const)
      .default("0")
      .argParser(parseSecurityLevel),
  )
  .action(async (input, options) => {
    const outPath =
      options.output ?? join(dirname(input), `${parsePath(basename(input)).name}.xml`);
    const decoded = await decodeSamsungExml(new Uint8Array(await readFile(input)), options.key, {
      securityLevel: options.securityLevel as SamsungSecurityLevel,
    });
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, decoded.xml, "utf8");
    process.stdout.write(
      `Wrote ${outPath} (${decoded.encrypted ? "decrypted AES payload" : "copied plaintext Home Up XML"})\n`,
    );
  });

program
  .command("encrypt")
  .description("Encrypt a Samsung XML file into Smart Switch AES-CBC .exml format.")
  .argument("<input>", "Input .xml path")
  .requiredOption("-o, --output <file>", "Output .exml path")
  .requiredOption("-k, --key <sessionKey>", "Smart Switch session key")
  .addOption(
    new Option("--security-level <level>", "Smart Switch AES key derivation level")
      .choices(["0", "1"] as const)
      .default("0")
      .argParser(parseSecurityLevel),
  )
  .option("--gzip", "Gzip XML before AES encryption", false)
  .action(async (input, options) => {
    const xml = await readFile(input, "utf8");
    const encrypted = await encryptSamsung(xml, options.key, {
      securityLevel: options.securityLevel as SamsungSecurityLevel,
      gzip: options.gzip,
    });
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, encrypted);
    process.stdout.write(`Wrote encrypted ${options.output}\n`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
