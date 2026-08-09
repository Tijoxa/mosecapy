import { describe, expect, test } from "bun:test";
import { isAndroidUserAgent, isYouTubeUrl, NEWPIPE_RELEASES_URL } from "../src/newpipe";

describe("NewPipe Android handoff", () => {
  test("detects Android without classifying iOS as Android", () => {
    expect(isAndroidUserAgent("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe(true);
    expect(isAndroidUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe(false);
  });

  test("only accepts YouTube HTTP URLs", () => {
    expect(isYouTubeUrl("https://www.youtube.com/watch?v=XZHWqfaHygE")).toBe(true);
    expect(isYouTubeUrl("https://youtu.be/XZHWqfaHygE")).toBe(true);
    expect(isYouTubeUrl("https://youtube.com.evil.example/watch?v=XZHWqfaHygE")).toBe(false);
  });

  test("uses NewPipe's official release page for installation help", () => {
    expect(NEWPIPE_RELEASES_URL).toBe("https://github.com/TeamNewPipe/NewPipe/releases/latest");
  });
});
