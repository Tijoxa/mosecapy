import os
import subprocess
from collections.abc import Iterator
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import BoundedSemaphore
from typing import Annotated
from urllib.parse import quote, urlsplit

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

HOST = "127.0.0.1"
PORT = 8765
ALLOWED_ORIGINS = [
    "https://tijoxa.github.io",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
]
MAX_AUDIO_BYTES = 250 * 1024 * 1024
DOWNLOAD_TIMEOUT_SECONDS = 600
download_slots = BoundedSemaphore(2)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=[HOST])
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["POST"],
    allow_headers=["Content-Type"],
    expose_headers=["X-Track-Filename"],
)


class AudioRequest(BaseModel):
    url: str = Field(max_length=16_000)


def download_directory(request: Request) -> Iterator[Path]:
    if request.headers.get("origin") not in ALLOWED_ORIGINS:
        raise HTTPException(403, "This origin is not allowed to use the local service.")
    if not download_slots.acquire(blocking=False):
        raise HTTPException(429, "The downloader is busy. Try again shortly.")
    try:
        with TemporaryDirectory(prefix="mosecapy-youtube-") as directory:
            yield Path(directory)
    finally:
        download_slots.release()


def is_youtube_url(value: str) -> bool:
    try:
        url = urlsplit(value)
        host = url.hostname or ""
        return (
            url.scheme in {"https", "http"}
            and url.username is None
            and url.port in {None, 80, 443}
            and (host in {"youtu.be", "youtube.com"} or host.endswith(".youtube.com"))
        )
    except ValueError:
        return False


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/youtube-audio", response_class=FileResponse)
def youtube_audio(body: AudioRequest, directory: Annotated[Path, Depends(download_directory)]) -> FileResponse:
    url = body.url.strip()
    if not is_youtube_url(url):
        raise HTTPException(400, "Enter a valid YouTube URL.")

    command = [
        os.environ.get("YT_DLP_PATH", "").strip() or "yt-dlp",
        "--ignore-config",
        "--no-playlist",
        "--format", "bestaudio/best",
        "--extract-audio",
        "--audio-format", "mp3",
        "--audio-quality", "192K",
        "--max-filesize", "250M",
        "--paths", str(directory),
        "--output", "%(title).120B [%(id)s].%(ext)s",
        "--", url,
    ]
    try:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            encoding="utf-8",
            errors="replace",
            timeout=DOWNLOAD_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError as error:
        raise HTTPException(503, 'Install yt-dlp with uv tool install "yt-dlp[default]" and check your PATH.') from error
    except subprocess.TimeoutExpired as error:
        raise HTTPException(504, "The YouTube audio download timed out.") from error

    if result.returncode:
        errors = [line.removeprefix("ERROR: ") for line in result.stderr.splitlines() if line.startswith("ERROR:")]
        detail = errors[-1][:800] if errors else "yt-dlp could not download audio from that video."
        raise HTTPException(422, detail)

    audio_path = next(directory.glob("*.mp3"), None)
    if audio_path is None or (audio_size := audio_path.stat().st_size) == 0:
        raise HTTPException(422, "No MP3 was produced. Check the 250 MB limit and your FFmpeg and Deno setup.")
    if audio_size > MAX_AUDIO_BYTES:
        raise HTTPException(413, "That track is over the 250 MB limit.")

    return FileResponse(
        audio_path,
        media_type="audio/mpeg",
        headers={"X-Track-Filename": quote(audio_path.name), "Cache-Control": "no-store"},
    )


def main() -> None:
    uvicorn.run(app, host=HOST, port=PORT, proxy_headers=False)
