import { downloadYouTubeAudio, YouTubeAudioError } from "./youtube-audio";

const DIST_DIRECTORY = new URL("./dist/", import.meta.url);
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_CONCURRENT_DOWNLOADS = 2;
let activeDownloads = 0;

const isolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

const server = Bun.serve({
  port: Number(process.env.PORT || 4173),
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/youtube-audio") {
      if (request.method !== "POST") return jsonError("Method not allowed.", 405);
      if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) return jsonError("The downloader is busy. Try again shortly.", 429);

      const length = Number(request.headers.get("content-length") || 0);
      if (length > MAX_REQUEST_BYTES) return jsonError("Request is too large.", 413);

      activeDownloads += 1;
      try {
        const rawBody = await request.text();
        if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) return jsonError("Request is too large.", 413);
        const body = JSON.parse(rawBody) as { url?: unknown };
        const sourceUrl = typeof body.url === "string" ? body.url.trim() : "";
        const audio = await downloadYouTubeAudio(sourceUrl);
        return new Response(audio.bytes, {
          headers: {
            ...isolationHeaders,
            "Content-Type": audio.contentType,
            "Content-Length": audio.bytes.byteLength.toString(),
            "X-Track-Filename": encodeURIComponent(audio.filename),
            "Cache-Control": "no-store",
          },
        });
      } catch (error) {
        return downloadError(error);
      } finally {
        activeDownloads -= 1;
      }
    }

    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Not found", { status: 404 });
    const relativePath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    if (relativePath.includes("..")) return new Response("Not found", { status: 404 });

    let file = Bun.file(new URL(relativePath, DIST_DIRECTORY));
    if (!(await file.exists())) file = Bun.file(new URL("index.html", DIST_DIRECTORY));
    if (!(await file.exists())) {
      return new Response("Build the frontend first with `bun run build`.", { status: 503 });
    }
    return new Response(request.method === "HEAD" ? null : file, { headers: isolationHeaders });
  },
});

console.log(`Mosecapy is running at ${server.url}`);

function downloadError(error: unknown): Response {
  if (error instanceof SyntaxError) return jsonError("Invalid JSON request.", 400);
  if (error instanceof YouTubeAudioError) return jsonError(error.message, error.status);
  console.error(error);
  return jsonError("YouTube audio could not be imported.", 500);
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { ...isolationHeaders, "Cache-Control": "no-store" } });
}
