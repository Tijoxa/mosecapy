import { describe, expect, test } from "bun:test";
import { downloadYouTubeAudio, isYouTubeUrl, YouTubeAudioError } from "../youtube-audio";

describe("YouTube audio import", () => {
  test("only accepts YouTube HTTP URLs", () => {
    expect(isYouTubeUrl("https://youtu.be/abc123")).toBe(true);
    expect(isYouTubeUrl("https://music.youtube.com/watch?v=abc123")).toBe(true);
    expect(isYouTubeUrl("https://youtube.com.evil.example/watch?v=abc123")).toBe(false);
    expect(isYouTubeUrl("file:///tmp/audio.mp3")).toBe(false);
  });

  test("returns the converted MP3", async () => {
    const result = await downloadYouTubeAudio("https://youtu.be/abc123", {
      command: [process.execPath, new URL("./fixtures/fake-yt-dlp.ts", import.meta.url).pathname],
    });

    expect(result.filename).toBe("Test track [abc123].mp3");
    expect(result.contentType).toBe("audio/mpeg");
    expect([...result.bytes]).toEqual([0x49, 0x44, 0x33, 0x04]);
  });

  test("rejects invalid hosts before starting a process", async () => {
    expect(downloadYouTubeAudio("https://example.com/video")).rejects.toBeInstanceOf(YouTubeAudioError);
  });
});
