import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { downloadYouTubeAudio, YouTubeAudioError } from "./youtube-audio.ts";

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_CONCURRENT_DOWNLOADS = 2;
let activeDownloads = 0;

function youtubeAudioPlugin(): Plugin {
  return {
    name: "mosecapy-youtube-audio",
    configureServer(server) {
      server.middlewares.use("/api/youtube-audio", async (request, response) => {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed." });
          return;
        }
        if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
          sendJson(response, 429, { error: "The downloader is busy. Try again shortly." });
          return;
        }

        activeDownloads += 1;
        try {
          const body = await readJsonBody(request);
          const sourceUrl = typeof body.url === "string" ? body.url.trim() : "";
          const audio = await downloadYouTubeAudio(sourceUrl);
          response.writeHead(200, {
            "Content-Type": audio.contentType,
            "Content-Length": audio.bytes.byteLength,
            "X-Track-Filename": encodeURIComponent(audio.filename),
            "Cache-Control": "no-store",
          });
          response.end(audio.bytes);
        } catch (error) {
          if (error instanceof YouTubeAudioError) sendJson(response, error.status, { error: error.message });
          else if (error instanceof SyntaxError) sendJson(response, 400, { error: "Invalid JSON request." });
          else {
            server.config.logger.error(error instanceof Error ? error.stack || error.message : String(error));
            sendJson(response, 500, { error: "YouTube audio could not be imported." });
          }
        } finally {
          activeDownloads -= 1;
        }
      });
    },
  };
}

async function readJsonBody(request: IncomingMessage): Promise<{ url?: unknown }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new YouTubeAudioError("Request is too large.", 413);
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as { url?: unknown };
}

function sendJson(response: ServerResponse, status: number, body: { error: string }) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

export default defineConfig({
  plugins: [react(), youtubeAudioPlugin()],
  base: "./",
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 3000,
  },
  server: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
});
