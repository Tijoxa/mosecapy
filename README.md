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

The `export` command writes `public/models/htdemucs.onnx` and automatically corrects PyTorch's `ScatterND` index type for ONNX Runtime Web.
