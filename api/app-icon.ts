import { APP_ICON_CACHE_CONTROL, fetchProxiedAppIcon } from "./_playStoreMetadata.js";

export async function GET(request: Request): Promise<Response> {
  const reqUrl = new URL(request.url);
  const targetUrl = (reqUrl.searchParams.get("url") ?? "").trim();

  const result = await fetchProxiedAppIcon(targetUrl);

  if (!result.ok) {
    return Response.json(
      { error: result.error },
      {
        status: result.status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control":
            result.status === 400 || result.status === 403 || result.status === 404
              ? "public, max-age=3600"
              : "no-store",
        },
      },
    );
  }

  return new Response(result.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      "Cache-Control": APP_ICON_CACHE_CONTROL,
    },
  });
}
