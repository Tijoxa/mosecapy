import { useEffect, useMemo, useRef, useState } from "react";
import {
  decodeAudioFile,
  encodeStereoFlac,
  encodeStereoMp3,
  encodeStereoOgg,
  encodeStereoWav,
  formatDuration,
  mixStereoStems,
  safeBaseName,
  type OutputFormat,
} from "./audio";
import { MODEL_CACHE_NAME, MODEL_URL } from "./model";
import { STEMS, type WorkerBackend, type WorkerRequest, type WorkerResponse } from "./types";

type Phase = "idle" | "decoding" | "separating" | "complete" | "error";
type ModelState = "idle" | "loading" | "ready" | "error";
type PreviewState = "idle" | "playing" | "paused";

const MAX_FILE_SIZE = 250 * 1024 * 1024;
const SAMPLE_RATE = 44_100;
const ACCEPTED_TYPES = ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/flac", "audio/ogg"];
const STEM_COLORS = ["#f15b35", "#8f75e8", "#2b8f73", "#d08c22"];
const ALL_STEM_INDICES = STEMS.map((_, index) => index);

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [backend, setBackend] = useState<WorkerBackend | null>(null);
  const [modelState, setModelState] = useState<ModelState>("idle");
  const [modelCached, setModelCached] = useState(false);
  const [modelMessage, setModelMessage] = useState("Download the model once to enable separation");
  const [message, setMessage] = useState("Choose a track to begin");
  const [isDragging, setIsDragging] = useState(false);
  const [selectedStemIndices, setSelectedStemIndices] = useState<number[]>(ALL_STEM_INDICES);
  const [previewState, setPreviewState] = useState<PreviewState>("idle");
  const [previewPosition, setPreviewPosition] = useState(0);
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("wav");
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const stemsRef = useRef<Float32Array[]>([]);
  const selectedStemIndicesRef = useRef<number[]>(ALL_STEM_INDICES);
  const previewContextRef = useRef<AudioContext | null>(null);
  const previewBuffersRef = useRef<AudioBuffer[]>([]);
  const previewSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const previewGainsRef = useRef<GainNode[]>([]);
  const previewStartedAtRef = useRef(0);
  const previewStartOffsetRef = useRef(0);
  const previewPositionRef = useRef(0);
  const previewFrameRef = useRef<number | null>(null);
  const previewStateRef = useRef<PreviewState>("idle");
  const previewLastPaintRef = useRef(0);

  const progressLabel = useMemo(() => {
    if (phase === "decoding") return "Preparing audio";
    if (phase === "separating") return `Separating stems · ${Math.round(progress)}%`;
    if (phase === "complete") return "Separation complete";
    if (phase === "error") return message;
    return file ? "Ready to separate" : "Choose a track to begin";
  }, [file, message, phase, progress]);

  const selectedStemNames = selectedStemIndices.map((index) => STEMS[index]);

  useEffect(() => {
    let mounted = true;

    async function checkModelCache() {
      if (!("caches" in window)) return;
      try {
        const cache = await caches.open(MODEL_CACHE_NAME);
        const cached = Boolean(await cache.match(MODEL_URL));
        if (!mounted) return;
        setModelCached(cached);
        if (cached) setModelMessage("Saved model available on this device");
      } catch {
        // The normal download path still works when Cache Storage is unavailable.
      }
    }

    void checkModelCache();
    return () => {
      mounted = false;
      workerRef.current?.terminate();
      disposePreview(false);
    };
  }, []);

  function getWorker(): Worker {
    if (workerRef.current) return workerRef.current;

    const worker = new Worker(new URL("./inference.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => handleWorkerMessage(event.data);
    worker.onerror = () => {
      worker.terminate();
      workerRef.current = null;
      setModelState("error");
      setModelMessage("The model engine stopped. Try downloading it again.");
      fail("The separation engine stopped unexpectedly.");
    };
    workerRef.current = worker;
    return worker;
  }

  function downloadModel() {
    if (modelState === "loading" || modelState === "ready") return;
    if (phase === "error") setPhase("idle");
    setModelState("loading");
    setModelMessage(modelCached ? "Loading the saved model…" : "Downloading and saving HTDemucs…");
    void navigator.storage?.persist?.().catch(() => false);
    getWorker().postMessage({ type: "load-model", modelUrl: MODEL_URL } satisfies WorkerRequest);
  }

  function chooseFile(nextFile?: File) {
    if (!nextFile) return;
    const hasAudioExtension = /\.(mp3|wav|m4a|flac|ogg)$/i.test(nextFile.name);
    if (!nextFile.type.startsWith("audio/") && !ACCEPTED_TYPES.includes(nextFile.type) && !hasAudioExtension) {
      fail("Please choose an audio file.");
      return;
    }
    if (nextFile.size > MAX_FILE_SIZE) {
      fail("That file is over the 250 MB limit.");
      return;
    }
    resetResults();
    setFile(nextFile);
    setPhase("idle");
    setMessage("Ready to separate");
  }

  async function startSeparation() {
    if (!file || modelState !== "ready" || phase === "decoding" || phase === "separating") return;

    resetResults();
    setPhase("decoding");
    setProgress(2);
    setMessage("Decoding and resampling your track…");

    try {
      const pcm = await decodeAudioFile(file);
      setDuration(pcm.duration);
      setPhase("separating");
      setProgress(8);
      setMessage("The first segment is running…");

      const request: WorkerRequest = { type: "separate", left: pcm.left, right: pcm.right };
      getWorker().postMessage(request, [pcm.left.buffer, pcm.right.buffer]);
    } catch (error) {
      fail(error instanceof Error ? error.message : "This audio file could not be decoded.");
    }
  }

  function handleWorkerMessage(response: WorkerResponse) {
    if (response.type === "model-loading") {
      setModelState("loading");
      return;
    }
    if (response.type === "model-ready") {
      setBackend(response.backend);
      setModelState("ready");
      setModelCached(response.cached);
      const source = response.source === "cache" ? "loaded from device" : response.cached ? "saved on device" : "not cached";
      setModelMessage(`Model ready · ${source} · ${response.backend === "webgpu" ? "WebGPU" : "WASM"}`);
      return;
    }
    if (response.type === "progress") {
      setPhase("separating");
      setProgress(10 + (response.completed / response.total) * 88);
      setMessage(`Processing segment ${response.completed} of ${response.total}`);
      return;
    }
    if (response.type === "complete") {
      stemsRef.current = response.stems;
      setDuration(response.duration);
      setBackend(response.backend);
      setProgress(100);
      setPhase("complete");
      applyStemSelection(ALL_STEM_INDICES);
      setMessage("Choose the layers you want to preview and export.");
      return;
    }
    if (response.type === "error") {
      if (response.operation === "load-model") {
        workerRef.current?.terminate();
        workerRef.current = null;
        setModelState("error");
        setModelCached(false);
        setModelMessage("Model download failed. Check your connection and retry.");
        return;
      }
      fail(response.message);
    }
  }

  function toggleStem(index: number) {
    const current = selectedStemIndicesRef.current;
    applyStemSelection(current.includes(index)
      ? current.filter((stemIndex) => stemIndex !== index)
      : [...current, index].sort((left, right) => left - right));
  }

  function selectAllStems() {
    applyStemSelection(ALL_STEM_INDICES);
  }

  function clearStemSelection() {
    applyStemSelection([]);
  }

  function applyStemSelection(nextSelection: number[]) {
    selectedStemIndicesRef.current = nextSelection;
    setSelectedStemIndices(nextSelection);

    const context = previewContextRef.current;
    if (!context) return;
    const now = context.currentTime;
    previewGainsRef.current.forEach((gain, index) => {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(nextSelection.includes(index) ? 1 : 0, now, 0.015);
    });
  }

  async function toggleSelectionPreview() {
    if (previewStateRef.current === "playing") {
      pauseSelectionPreview();
      return;
    }
    if (selectedStemIndicesRef.current.length === 0) return;
    await startSelectionPreview();
  }

  async function startSelectionPreview(offset = previewPositionRef.current) {
    const context = getPreviewContext();
    if (context.state === "suspended") await context.resume();
    if (previewBuffersRef.current.length === 0) buildPreviewBuffers(context);

    const previewDuration = Math.min(duration, previewBuffersRef.current[0]?.duration ?? duration);
    if (previewDuration <= 0) return;
    const safeOffset = offset >= previewDuration - 0.05 ? 0 : Math.max(0, offset);

    stopPreviewNodes();
    cancelPreviewFrame();
    const startAt = context.currentTime + 0.025;
    const sources: AudioBufferSourceNode[] = [];
    const gains: GainNode[] = [];

    previewBuffersRef.current.forEach((buffer, index) => {
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      gain.gain.value = selectedStemIndicesRef.current.includes(index) ? 1 : 0;
      source.connect(gain).connect(context.destination);
      source.start(startAt, safeOffset);
      sources.push(source);
      gains.push(gain);
    });

    previewSourcesRef.current = sources;
    previewGainsRef.current = gains;
    previewStartedAtRef.current = startAt;
    previewStartOffsetRef.current = safeOffset;
    previewPositionRef.current = safeOffset;
    setPreviewPosition(safeOffset);
    updatePreviewState("playing");
    previewLastPaintRef.current = 0;
    trackPreviewProgress(previewDuration);
  }

  function pauseSelectionPreview() {
    const position = currentPreviewPosition();
    previewPositionRef.current = position;
    setPreviewPosition(position);
    stopPreviewNodes();
    cancelPreviewFrame();
    updatePreviewState("paused");
  }

  function seekSelectionPreview(nextPosition: number) {
    const wasPlaying = previewStateRef.current === "playing";
    stopPreviewNodes();
    cancelPreviewFrame();
    previewPositionRef.current = nextPosition;
    setPreviewPosition(nextPosition);
    updatePreviewState(nextPosition >= duration ? "idle" : "paused");
    if (wasPlaying) void startSelectionPreview(nextPosition);
  }

  function getPreviewContext(): AudioContext {
    if (previewContextRef.current && previewContextRef.current.state !== "closed") return previewContextRef.current;
    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    previewContextRef.current = context;
    return context;
  }

  function buildPreviewBuffers(context: AudioContext) {
    previewBuffersRef.current = STEMS.map((_, index) => {
      const left = stemsRef.current[index * 2];
      const right = stemsRef.current[index * 2 + 1];
      if (!left || !right) throw new Error("A separated stem is unavailable.");
      const frames = Math.min(left.length, right.length);
      const buffer = context.createBuffer(2, frames, SAMPLE_RATE);
      buffer.getChannelData(0).set(left.subarray(0, frames));
      buffer.getChannelData(1).set(right.subarray(0, frames));
      return buffer;
    });
  }

  function trackPreviewProgress(previewDuration: number) {
    const tick = (timestamp: number) => {
      const position = currentPreviewPosition();
      if (position >= previewDuration) {
        stopPreviewNodes();
        previewPositionRef.current = previewDuration;
        setPreviewPosition(previewDuration);
        updatePreviewState("idle");
        previewFrameRef.current = null;
        return;
      }
      previewPositionRef.current = position;
      if (timestamp - previewLastPaintRef.current >= 100) {
        previewLastPaintRef.current = timestamp;
        setPreviewPosition(position);
      }
      previewFrameRef.current = window.requestAnimationFrame(tick);
    };
    previewFrameRef.current = window.requestAnimationFrame(tick);
  }

  function currentPreviewPosition(): number {
    const context = previewContextRef.current;
    if (!context || previewSourcesRef.current.length === 0) return previewPositionRef.current;
    return Math.min(duration, previewStartOffsetRef.current + Math.max(0, context.currentTime - previewStartedAtRef.current));
  }

  function stopPreviewNodes() {
    for (const source of previewSourcesRef.current) {
      try { source.stop(); } catch { /* The source may already have ended. */ }
      source.disconnect();
    }
    for (const gain of previewGainsRef.current) gain.disconnect();
    previewSourcesRef.current = [];
    previewGainsRef.current = [];
  }

  function cancelPreviewFrame() {
    if (previewFrameRef.current === null) return;
    window.cancelAnimationFrame(previewFrameRef.current);
    previewFrameRef.current = null;
  }

  function disposePreview(updateState = true) {
    stopPreviewNodes();
    cancelPreviewFrame();
    previewBuffersRef.current = [];
    previewPositionRef.current = 0;
    const context = previewContextRef.current;
    previewContextRef.current = null;
    if (context && context.state !== "closed") void context.close();
    if (updateState) {
      setPreviewPosition(0);
      updatePreviewState("idle");
    }
  }

  function updatePreviewState(nextState: PreviewState) {
    previewStateRef.current = nextState;
    setPreviewState(nextState);
  }

  async function exportSelection() {
    if (!file || selectedStemIndicesRef.current.length === 0 || isExporting) return;
    setIsExporting(true);
    setExportError(null);

    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      const mix = mixStereoStems(stemsRef.current, selectedStemIndicesRef.current);
      let blob: Blob;
      if (outputFormat === "mp3") blob = await encodeStereoMp3(mix.left, mix.right);
      else if (outputFormat === "flac") blob = await encodeStereoFlac(mix.left, mix.right);
      else if (outputFormat === "ogg") blob = await encodeStereoOgg(mix.left, mix.right);
      else blob = encodeStereoWav(mix.left, mix.right);

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${safeBaseName(file.name)}-${selectedStemNames.map((stem) => stem.toLowerCase()).join("-")}.${outputFormat}`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "The selected format could not be exported.");
    } finally {
      setIsExporting(false);
    }
  }

  function resetResults() {
    stemsRef.current = [];
    setProgress(0);
    setDuration(0);
    applyStemSelection(ALL_STEM_INDICES);
    setExportError(null);
    disposePreview();
  }

  function fail(errorMessage: string) {
    setPhase("error");
    setMessage(errorMessage);
  }

  const isBusy = ["decoding", "separating"].includes(phase);
  const canSeparate = Boolean(file) && modelState === "ready" && !isBusy && !isExporting;

  return (
    <main>
      <header className="nav">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          AI STEM SEPARATOR <em>HTDEMUCS</em>
        </div>
      </header>

      <section className="hero" id="top">
        <div
          className={`drop-zone ${isDragging ? "dragging" : ""} ${file ? "has-file" : ""}`}
          onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            chooseFile(event.dataTransfer.files[0]);
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg"
            onChange={(event) => chooseFile(event.target.files?.[0])}
            hidden
          />
          <div className="drop-copy">
            <div className="file-icon" aria-hidden="true">♪</div>
            <div>
              <strong>{file ? file.name : "Drop a track here"}</strong>
              <span>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : "MP3, WAV, M4A, FLAC or OGG · up to 250 MB"}</span>
            </div>
          </div>
          <button className="browse-button" type="button" onClick={() => inputRef.current?.click()} disabled={isBusy || isExporting}>
            {file ? "Change track" : "Browse files"}
          </button>
        </div>

        <div className="action-row">
          <button
            className={`model-button ${modelState}`}
            type="button"
            onClick={downloadModel}
            disabled={modelState === "loading" || modelState === "ready" || isBusy}
          >
            <span aria-hidden="true">↓</span>
            {modelState === "loading"
              ? "Downloading model…"
              : modelState === "ready"
                ? "Model ready"
                : modelState === "error"
                  ? "Retry model download"
                  : modelCached ? "Load cached model" : "Download model · 163 MB"}
          </button>
          <button className="separate-button" type="button" onClick={startSeparation} disabled={!canSeparate}>
            <span aria-hidden="true">✦</span>
            {isBusy ? "Separating…" : phase === "complete" ? "Separate again" : "Separate track"}
          </button>
          <span className={`model-status ${modelState}`} aria-live="polite">{modelMessage}</span>
        </div>

        {(isBusy || phase === "complete" || phase === "error") && (
          <section className={`progress-panel ${phase === "error" ? "error" : ""}`} aria-live="polite">
            <div className="progress-heading">
              <strong>{progressLabel}</strong>
              <span>{phase === "error" ? "" : `${Math.round(progress)}%`}</span>
            </div>
            <div className="progress-track"><i style={{ width: `${progress}%` }} /></div>
            <div className="progress-meta">
              <span>{message}</span>
              {backend && <span>{backend === "webgpu" ? "WebGPU accelerated" : "WASM engine"}</span>}
            </div>
          </section>
        )}
      </section>

      {phase === "complete" && (
        <section className="results" aria-labelledby="results-heading">
          <div className="results-heading">
            <div>
              <span>YOUR SEPARATED TRACK</span>
              <h2 id="results-heading">Four clean layers.</h2>
            </div>
            <div className="track-time">{formatDuration(duration)} · 44.1 kHz stereo</div>
          </div>
          <div className="stem-grid">
            {STEMS.map((stem, index) => {
              const isSelected = selectedStemIndices.includes(index);
              return (
                <article
                  className={`stem-card ${isSelected ? "selected" : "muted"}`}
                  key={stem}
                  style={{ "--stem-color": STEM_COLORS[index] } as React.CSSProperties}
                >
                  <div className="stem-card-topline">
                    <div className="stem-number">0{index + 1}</div>
                    <button
                      className="stem-toggle"
                      type="button"
                      aria-label={`${isSelected ? "Remove" : "Keep"} ${stem} ${isSelected ? "from" : "in"} selected mix`}
                      aria-pressed={isSelected}
                      onClick={() => toggleStem(index)}
                    >
                      <span aria-hidden="true">{isSelected ? "✓" : ""}</span>
                      {isSelected ? "Kept" : "Muted"}
                    </button>
                  </div>
                  <div className="waveform" aria-hidden="true">
                    {Array.from({ length: 32 }, (_, bar) => <i key={bar} style={{ height: `${18 + ((bar * 17 + index * 23) % 72)}%` }} />)}
                  </div>
                  <h3>{stem}</h3>
                  <p>{stemDescriptions[index]}</p>
                </article>
              );
            })}
          </div>
          <div className="selection-panel">
            <div className="selection-summary">
              <span>SELECTED MIX</span>
              <strong>{selectedStemIndices.length === 0 ? "No stems selected" : selectedStemNames.join(" + ")}</strong>
              <p>{selectedStemIndices.length} of {STEMS.length} stems will be mixed into one stereo {outputFormat.toUpperCase()} file.</p>
              <div className="selection-shortcuts">
                <button type="button" onClick={selectAllStems} disabled={selectedStemIndices.length === STEMS.length}>Select all</button>
                <button type="button" onClick={clearStemSelection} disabled={selectedStemIndices.length === 0}>Clear</button>
              </div>
            </div>
            <div className="selection-output">
              <div className="selection-actions">
                <button
                  type="button"
                  onClick={() => void toggleSelectionPreview()}
                  disabled={selectedStemIndices.length === 0 && previewState !== "playing"}
                >
                  {previewState === "playing" ? "Ⅱ Pause preview" : previewState === "paused" ? "▶ Resume preview" : "▶ Preview selection"}
                </button>
                <label className="format-picker">
                  <span>Format</span>
                  <select value={outputFormat} onChange={(event) => setOutputFormat(event.target.value as OutputFormat)} disabled={isExporting}>
                    <option value="wav">WAV · lossless</option>
                    <option value="mp3">MP3 · 192 kbps</option>
                    <option value="flac">FLAC · lossless</option>
                    <option value="ogg">OGG · Vorbis</option>
                  </select>
                </label>
                <button className="export-button" type="button" onClick={() => void exportSelection()} disabled={selectedStemIndices.length === 0 || isExporting}>
                  {isExporting ? `Encoding ${outputFormat.toUpperCase()}…` : "↓ Export selection"}
                </button>
              </div>
              <div className="preview-timeline">
                <input
                  type="range"
                  min="0"
                  max={Math.max(duration, 0.01)}
                  step="0.1"
                  value={previewPosition}
                  aria-label="Preview position"
                  onChange={(event) => seekSelectionPreview(Number(event.target.value))}
                />
                <span>{formatDuration(previewPosition)} / {formatDuration(duration)}</span>
              </div>
              {exportError && <span className="export-error" role="alert">{exportError}</span>}
            </div>
          </div>
        </section>
      )}

    </main>
  );
}

const stemDescriptions = [
  "Punch, transients, and room energy.",
  "Low-end movement with clean definition.",
  "Guitars, keys, synths, and everything between.",
  "Lead and backing voices, brought forward.",
];

export default App;
