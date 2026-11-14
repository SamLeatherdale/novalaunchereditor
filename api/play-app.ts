import { fetchPlayStoreAppMeta } from "./_playStoreMetadata.js";

const FOUND_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800";
const NOT_FOUND_CACHE_CONTROL = "public, max-age=86400, s-maxage=604800";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = (url.searchParams.get("id") ?? "").trim();

  if (!id) {
    return Response.json(
      { error: "Missing query parameter: id" },
      {
        status: 400,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        },
      },
    );
  }

  const result = await fetchPlayStoreAppMeta(id);

  if (result.transientError) {
    console.error("[play-app] upstream failure", { packageName: result.packageName });
    return Response.json(
      {
        packageName: result.packageName,
        found: false,
        transientError: true,
      },
      {
        status: 502,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  if (result.found) {
    return Response.json(
      {
        packageName: result.packageName,
        found: true,
        ...(result.title ? { title: result.title } : {}),
        ...(result.iconUrl ? { iconUrl: result.iconUrl } : {}),
      },
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": FOUND_CACHE_CONTROL,
        },
      },
    );
  }

  return Response.json(
    {
      packageName: result.packageName,
      found: false,
    },
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": NOT_FOUND_CACHE_CONTROL,
      },
    },
  );
}
