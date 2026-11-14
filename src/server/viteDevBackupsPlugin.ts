import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, normalize, resolve } from "node:path";
import type { Plugin } from "vite-plus";

export interface DevBackupFixture {
  name: string;
  path: string;
  size: number;
  url: string;
}

const IGNORED_BACKUP_DIRS = new Set(["apks", "converted-preview", "push-ready", "dev-exports"]);
const ALLOWED_BACKUP_EXTS = new Set([".novabackup", ".exml", ".xml"]);

function collectDevBackupFixtures(backupsRoot: string): DevBackupFixture[] {
  if (!existsSync(backupsRoot)) return [];
  const results: DevBackupFixture[] = [];

  const walk = (dir: string, relPrefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_BACKUP_DIRS.has(entry.name)) {
          continue;
        }
        walk(fullPath, relPath);
      } else if (ALLOWED_BACKUP_EXTS.has(extname(entry.name).toLowerCase())) {
        results.push({
          name: entry.name,
          path: relPath,
          size: statSync(fullPath).size,
          url: `/__dev/backups/${encodeURI(relPath)}`,
        });
      }
    }
  };

  walk(backupsRoot, "");
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

export function devBackupsPlugin(): Plugin {
  return {
    name: "dev-backups-server",
    apply: "serve",
    configureServer(server) {
      const backupsRoot = resolve(server.config.root, "backups");
      const devExportsRoot = resolve(backupsRoot, "dev-exports");

      server.middlewares.use("/__dev/exports", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        const rawUrl = (req.url ?? "/").split("?")[0];
        const requestedName = basename(decodeURIComponent(rawUrl.replace(/^\/+/, "")));
        if (!requestedName || requestedName === "." || requestedName === "..") {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "Invalid export filename" }));
          return;
        }

        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          try {
            mkdirSync(devExportsRoot, { recursive: true });
            const outPath = resolve(devExportsRoot, requestedName);
            if (!outPath.startsWith(devExportsRoot)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "Invalid output path" }));
              return;
            }
            const body = Buffer.concat(chunks);
            writeFileSync(outPath, body);
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                savedPath: `backups/dev-exports/${requestedName}`,
                size: body.byteLength,
              }),
            );
          } catch (err) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        });
      });

      server.middlewares.use("/__dev/backups", (req, res, next) => {
        const urlPath = (req.url ?? "/").split("?")[0];
        if (urlPath === "/" || urlPath === "") {
          const fixtures = collectDevBackupFixtures(backupsRoot);
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ fixtures }));
          return;
        }

        const decoded = decodeURIComponent(urlPath.replace(/^\/+/, ""));
        const candidate = resolve(backupsRoot, normalize(decoded));
        if (
          !candidate.startsWith(backupsRoot) ||
          !existsSync(candidate) ||
          !statSync(candidate).isFile()
        ) {
          next();
          return;
        }

        res.setHeader("Content-Type", "application/octet-stream");
        createReadStream(candidate).pipe(res);
      });
    },
  };
}
