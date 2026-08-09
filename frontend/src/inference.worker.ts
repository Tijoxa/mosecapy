/// <reference lib="webworker" />

import * as ort from "onnxruntime-web/all";
import { MODEL_CACHE_NAME } from "./model";
import type { ModelSource, WorkerBackend, WorkerRequest, WorkerResponse } from "./types";

const SAMPLE_RATE = 44_100;
const SEGMENT_SAMPLES = 343_980;
const OVERLAP = 0.25;
const STRIDE = Math.floor((1 - OVERLAP) * SEGMENT_SAMPLES);
const STEM_COUNT = 4;
const CHANNEL_COUNT = 2;

let session: ort.InferenceSession | undefined;
let activeBackend: WorkerBackend = "wasm";

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const operation = event.data.type;

  try {
    if (event.data.type === "load-model") {
      post({ type: "model-loading" });
      const model = await getSession(event.data.modelUrl);
      post({ type: "model-ready", backend: activeBackend, source: model.source, cached: model.cached });
      return;
    }

    if (!session) throw new Error("Download the model before separating a track.");
    const result = await separate(event.data.left, event.data.right, session);
    post(result, result.stems.map((stem) => stem.buffer));
  } catch (error) {
    post({
      type: "error",
      operation,
      message: error instanceof Error ? error.message : "Separation failed unexpectedly.",
    });
  }
};

async function getSession(modelUrl: string): Promise<{ source: ModelSource; cached: boolean }> {
  if (session) return { source: "memory", cached: true };

  ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(4, (self.navigator.hardwareConcurrency || 2) - 1))
    : 1;
  ort.env.wasm.simd = true;
  const model = await loadModelBytes(modelUrl);

  const hasWebGpu = "gpu" in self.navigator;
  if (hasWebGpu) {
    try {
      session = await ort.InferenceSession.create(model.bytes, {
        executionProviders: ["webgpu", "wasm"],
        graphOptimizationLevel: "all",
      });
      activeBackend = "webgpu";
      return { source: model.source, cached: model.cached };
    } catch (error) {
      console.info("WebGPU initialization failed; using WASM.", error);
    }
  }

  try {
    session = await ort.InferenceSession.create(model.bytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    activeBackend = "wasm";
    return { source: model.source, cached: model.cached };
  } catch (error) {
    if (model.source === "cache") await deleteCachedModel(modelUrl);
    throw error;
  }
}

async function loadModelBytes(modelUrl: string): Promise<{
  bytes: Uint8Array;
  source: Exclude<ModelSource, "memory">;
  cached: boolean;
}> {
  let cache: Cache | undefined;

  if ("caches" in self) {
    try {
      cache = await caches.open(MODEL_CACHE_NAME);
      const cachedResponse = await cache.match(modelUrl);
      if (cachedResponse) {
        return {
          bytes: new Uint8Array(await cachedResponse.arrayBuffer()),
          source: "cache",
          cached: true,
        };
      }
    } catch (error) {
      console.info("Persistent model cache is unavailable; using the network.", error);
    }
  }

  const response = await fetch(modelUrl);
  if (!response.ok) throw new Error(`Model download failed with HTTP ${response.status}.`);

  const cacheWrite = cache
    ? cache.put(modelUrl, response.clone()).then(() => true).catch((error) => {
        console.info("The model loaded, but could not be saved for a future visit.", error);
        return false;
      })
    : Promise.resolve(false);
  const [buffer, cached] = await Promise.all([response.arrayBuffer(), cacheWrite]);
  return { bytes: new Uint8Array(buffer), source: "network", cached };
}

async function deleteCachedModel(modelUrl: string): Promise<void> {
  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    await cache.delete(modelUrl);
  } catch {
    // A failed cleanup should not hide the model initialization error.
  }
}

async function separate(
  left: Float32Array,
  right: Float32Array,
  runtime: ort.InferenceSession,
): Promise<Extract<WorkerResponse, { type: "complete" }>> {
  const audioLength = Math.min(left.length, right.length);
  if (audioLength === 0) throw new Error("The selected audio file is empty.");

  const { mean, standardDeviation } = referenceStats(left, right, audioLength);
  const offsets = chunkOffsets(audioLength);
  const window = triangularWindow();
  const accumulators = Array.from(
    { length: STEM_COUNT * CHANNEL_COUNT },
    () => new Float32Array(audioLength),
  );
  const weightSum = new Float32Array(audioLength);

  for (let chunkIndex = 0; chunkIndex < offsets.length; chunkIndex += 1) {
    const offset = offsets[chunkIndex];
    const available = Math.min(SEGMENT_SAMPLES, audioLength - offset);
    const input = new Float32Array(CHANNEL_COUNT * SEGMENT_SAMPLES);

    for (let index = 0; index < available; index += 1) {
      input[index] = (left[offset + index] - mean) / standardDeviation;
      input[SEGMENT_SAMPLES + index] =
        (right[offset + index] - mean) / standardDeviation;
    }

    const outputMap = await runtime.run({
      mix: new ort.Tensor("float32", input, [1, 2, SEGMENT_SAMPLES]),
    });
    const prediction = outputMap.split;
    if (!prediction) throw new Error('The model did not return its expected "split" output.');
    const output = prediction.data as Float32Array;

    for (let index = 0; index < available; index += 1) {
      const target = offset + index;
      const weight = window[index];
      weightSum[target] += weight;
      for (let stem = 0; stem < STEM_COUNT; stem += 1) {
        for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
          const plane = stem * CHANNEL_COUNT + channel;
          const sourceIndex = plane * SEGMENT_SAMPLES + index;
          accumulators[plane][target] += output[sourceIndex] * weight;
        }
      }
    }

    prediction.dispose();
    post({ type: "progress", completed: chunkIndex + 1, total: offsets.length });
  }

  for (let plane = 0; plane < accumulators.length; plane += 1) {
    const channel = accumulators[plane];
    for (let index = 0; index < audioLength; index += 1) {
      channel[index] = (channel[index] / Math.max(weightSum[index], 1e-7)) * standardDeviation + mean;
    }
  }

  return {
    type: "complete",
    stems: accumulators,
    length: audioLength,
    duration: audioLength / SAMPLE_RATE,
    backend: activeBackend,
  };
}

function referenceStats(left: Float32Array, right: Float32Array, length: number) {
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum += (left[index] + right[index]) * 0.5;
  }
  const mean = sum / length;

  let squaredDifference = 0;
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] + right[index]) * 0.5 - mean;
    squaredDifference += difference * difference;
  }

  return {
    mean,
    standardDeviation: Math.max(Math.sqrt(squaredDifference / length), 1e-7),
  };
}

function chunkOffsets(length: number): number[] {
  if (length <= SEGMENT_SAMPLES) return [0];
  const offsets: number[] = [];
  for (let offset = 0; offset < length; offset += STRIDE) {
    offsets.push(offset);
    if (offset + SEGMENT_SAMPLES >= length) break;
  }
  return offsets;
}

function triangularWindow(): Float32Array {
  const weight = new Float32Array(SEGMENT_SAMPLES);
  const half = Math.floor(SEGMENT_SAMPLES / 2);
  const maximum = half;

  for (let index = 0; index < half; index += 1) {
    const value = (index + 1) / maximum;
    weight[index] = value;
    weight[SEGMENT_SAMPLES - 1 - index] = value;
  }

  return weight;
}

function post(message: WorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer });
}

export {};
