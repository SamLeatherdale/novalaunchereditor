import type { Plugin } from "vite-plus";
import { fetchPlayStoreAppMeta, type PlayStoreAppMetaResult } from "./playStoreMetadata";

const FOUND_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800";
const NOT_FOUND_CACHE_CONTROL = "public, max-age=86400, s-maxage=604800";

export function playAppDevPlugin(): Plugin {
  return {
    name: "play-app-dev",
    apply: "serve",
    configureServer(server) {
      const devPlayCache = new Map<string, PlayStoreAppMetaResult>();

      server.middlewares.use("/api/play-app", (req, res, next) => {
        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
          res.end();
          return;
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
          next();
          return;
        }
        const reqUrl = new URL(req.url ?? "/", "http://localhost");
        const id = (reqUrl.searchParams.get("id") ?? "").trim();
        if (!id) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "Missing query parameter: id" }));
          return;
        }

        void (async () => {
          try {
            let result = devPlayCache.get(id);
            if (!result) {
              result = await fetchPlayStoreAppMeta(id);
              if (!result.transientError) {
                devPlayCache.set(id, result);
              }
            }

            res.setHeader("Content-Type", "application/json; charset=utf-8");
            if (result.transientError) {
              res.statusCode = 502;
              res.setHeader("Cache-Control", "no-store");
              res.end(
                JSON.stringify({
                  packageName: result.packageName,
                  found: false,
                  transientError: true,
                }),
              );
              return;
            }

            res.statusCode = 200;
            res.setHeader(
              "Cache-Control",
              result.found ? FOUND_CACHE_CONTROL : NOT_FOUND_CACHE_CONTROL,
            );
            res.end(
              JSON.stringify(
                result.found
                  ? {
                      packageName: result.packageName,
                      found: true,
                      ...(result.title ? { title: result.title } : {}),
                      ...(result.iconUrl ? { iconUrl: result.iconUrl } : {}),
                    }
                  : {
                      packageName: result.packageName,
                      found: false,
                    },
              ),
            );
          } catch (err) {
            res.statusCode = 502;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            res.end(
              JSON.stringify({
                packageName: id,
                found: false,
                transientError: true,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        })();
      });
    },
  };
}
