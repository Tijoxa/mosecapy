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

The source chooser also accepts YouTube URLs. That route uses `yt-dlp` with the
[`yt-dlp/ejs`](https://github.com/yt-dlp/ejs) challenge solver (`ejs:npm`) and Bun as its JavaScript runtime, then gives the converted MP3 to the same browser-based separation flow.

Install current `yt-dlp` and `ffmpeg`, build the frontend, and run the Bun server:

```bash
cd frontend
bun install
bun run build
bun run start
```

`yt-dlp` must be on `PATH`; set `YT_DLP_PATH=/absolute/path/to/yt-dlp` when it is not. `BUN_PATH` can likewise point to a specific Bun executable. The integration intentionally allows Bun 1.4+ despite the older-version support warning in the ejs README.

`bun run dev` exposes the same YouTube endpoint through the Vite development server, so the source works in both development and the built Bun server.

On Android, the YouTube button instead opens the system share sheet with the entered URL; choose [NewPipe](https://github.com/TeamNewPipe/NewPipe) as the destination. This avoids browser-specific `intent://` handling. On the first handoff, choose **Download → Always** in NewPipe, save M4A audio, return to Mosecapy, and select the download under **Local file**. The UI links to NewPipe's official GitHub releases if it is not installed.

The GitHub Pages deployment remains static. Desktop and iOS YouTube importing therefore requires the Bun server (or an equivalent deployment of `/api/youtube-audio`); Android can use the NewPipe handoff and import its downloaded M4A locally. Only download media you have permission to use.

The `export` command writes `public/models/htdemucs.onnx` and automatically corrects PyTorch's `ScatterND` index type for ONNX Runtime Web.
