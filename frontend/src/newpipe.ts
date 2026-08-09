export const NEWPIPE_RELEASES_URL = "https://github.com/TeamNewPipe/NewPipe/releases/latest";

export function isAndroidUserAgent(userAgent: string): boolean {
  return /\bAndroid\b/i.test(userAgent);
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
