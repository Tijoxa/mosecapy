# use of moseca
[Reddit post](https://www.reddit.com/r/opensource/comments/15x3e52/from_frustration_to_creation_how_i_built_my_own/)

[GitHub](https://github.com/fabiogra/moseca?tab=readme-ov-file)

[Model download](https://huggingface.co/fabiogra/baseline_vocal_remover) (fyi)

## Installation
```Bash
uv tool install https://github.com/Tijoxa/mosecapy.git --python=3.9
```

## Setup
Place your audio files in a `music` folder.

Run
```Bash
mosecapy
```
in a terminal where the `music` folder is present.

## Browser app

The frontend downloads the HTDemucs ONNX model from Hugging Face on demand, saves it in the browser's Cache Storage for later visits, then runs it entirely in the browser. Audio is decoded locally, processed in overlapping chunks in a Web Worker, previewed with a live stem mixer, and exported as WAV, MP3, FLAC, or OGG Vorbis.

```bash
cd frontend
bun install
bun run dev
```

Create a production build with `bun run build`. The static output is written to `frontend/dist` and needs no application server.

### YouTube audio input

The GitHub Pages app calls a FastAPI service on your computer to download YouTube
audio. The service runs `yt-dlp` and sends the MP3 back to your browser for separation.
Install [FFmpeg](https://ffmpeg.org/download.html) and make sure `ffmpeg` and
`ffprobe` are on `PATH`. Deno runs the JavaScript code used by `yt-dlp` for YouTube.

```bash
uv tool install deno
uv tool install "yt-dlp[default]"
uv tool install "git+https://github.com/Tijoxa/mosecapy.git#subdirectory=youtube-audio"
mosecapy-youtube
```

Keep `mosecapy-youtube` running, open [Mosecapy Studio](https://tijoxa.github.io/mosecapy/),
and choose **YouTube audio**. Allow local access if the browser prompts you.
The service listens on `127.0.0.1:8765`. Open `http://127.0.0.1:8765/health`
to check that it is running. If your shell cannot find the installed commands,
run `uv tool update-shell` and reopen your terminal.

From a repository checkout, install the current local code with
`uv tool install ./youtube-audio`. `bun run dev` and `bun run preview` use the
same service from their default local URLs.

Use `uv tool upgrade yt-dlp` to refresh the downloader and its bundled YouTube
challenge solver. The YouTube tab appears on desktop layouts. Local file import
works in the browser on desktop and mobile. Only download media you have permission to use.

The `export` command writes `public/models/htdemucs.onnx` and automatically corrects PyTorch's `ScatterND` index type for ONNX Runtime Web.
