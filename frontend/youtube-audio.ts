import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const MAX_AUDIO_BYTES = 250 * 1024 * 1024;
const MAX_ERROR_LENGTH = 800;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1_000;

type DownloadOptions = {
  command?: string[];
};

export type DownloadedAudio = {
  bytes: Uint8Array;
  filename: string;
  contentType: "audio/mpeg";
};

export class YouTubeAudioError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = "YouTubeAudioError";
  }
}

export function isYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

export async function downloadYouTubeAudio(url: string, options: DownloadOptions = {}): Promise<DownloadedAudio> {
  if (!isYouTubeUrl(url)) throw new YouTubeAudioError("Enter a valid YouTube URL.", 400);

  const command = options.command ?? resolveYtDlpCommand();
  const workDirectory = await mkdtemp(join(tmpdir(), "mosecapy-youtube-"));

  try {
    const args = [
      "--ignore-config",
      "--no-playlist",
      "--no-warnings",
      "--js-runtimes",
      `bun:${resolveBunExecutable()}`,
      "--remote-components",
      "ejs:npm",
      "--format",
      "bestaudio/best",
      "--extract-audio",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "192K",
      "--max-filesize",
      "250M",
      "--paths",
      workDirectory,
      "--output",
      "%(title).120B [%(id)s].%(ext)s",
      "--",
      url,
    ];

    const result = await run([...command, ...args]);
    if (result.exitCode !== 0) {
      const detail = cleanError(result.stderr) || "yt-dlp could not download audio from that video.";
      throw new YouTubeAudioError(detail, 422);
    }

    const files = await readdir(workDirectory, { withFileTypes: true });
    const audio = files.find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".mp3"));
    if (!audio) throw new YouTubeAudioError("YouTube audio conversion did not produce an MP3 file.", 500);

    const audioPath = join(workDirectory, audio.name);
    const bytes = await readFile(audioPath);
    if (bytes.byteLength > MAX_AUDIO_BYTES) {
      throw new YouTubeAudioError("That track is over the 250 MB limit.", 413);
    }

    return {
      bytes,
      filename: basename(audio.name),
      contentType: "audio/mpeg",
    };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

function resolveYtDlpCommand(): string[] {
  const configuredPath = process.env.YT_DLP_PATH?.trim();
  if (configuredPath) return [configuredPath];
  return ["yt-dlp"];
}

function resolveBunExecutable(): string {
  return process.env.BUN_PATH?.trim() || "bun";
}

function run(command: string[]): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: DOWNLOAD_TIMEOUT_MS,
    });
    const chunks: Buffer[] = [];

    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new YouTubeAudioError("yt-dlp is not installed or YT_DLP_PATH is not configured.", 503));
        return;
      }
      reject(error);
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stderr: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

function cleanError(value: string): string {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const lastError = [...lines].reverse().find((line) => /error:/i.test(line)) ?? lines.at(-1) ?? "";
  return lastError.replace(/^ERROR:\s*/i, "").slice(0, MAX_ERROR_LENGTH);
}
