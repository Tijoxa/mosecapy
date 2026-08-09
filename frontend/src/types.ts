export const STEMS = ["Drums", "Bass", "Other", "Vocals"] as const;

export type StemName = (typeof STEMS)[number];
export type WorkerBackend = "webgpu" | "wasm";
export type ModelSource = "cache" | "network" | "memory";

export type WorkerRequest =
  | { type: "load-model"; modelUrl: string }
  | { type: "separate"; left: Float32Array; right: Float32Array };

export type WorkerResponse =
  | { type: "model-loading" }
  | { type: "model-ready"; backend: WorkerBackend; source: ModelSource; cached: boolean }
  | { type: "progress"; completed: number; total: number }
  | {
      type: "complete";
      stems: Float32Array[];
      length: number;
      duration: number;
      backend: WorkerBackend;
    }
  | { type: "error"; operation: WorkerRequest["type"]; message: string };
