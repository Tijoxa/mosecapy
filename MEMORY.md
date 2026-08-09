# HTDemucs ONNX Export & JS Web Runtime Architecture Memory

This document serves as the persistent technical memory and implementation reference for the **Demucs ONNX model** export and its upcoming **JavaScript / Web Runtime integration** (`onnxruntime-web`).

---

## 1. Exported ONNX Model Specifications

* **Model Architecture:** Hybrid Transformer Demucs (`HTDemucs` - v4)
* **Pretrained Weights:** `htdemucs` (`955717e8`)
* **Export File Location:** `public/models/htdemucs.onnx` (~163 MB)
* **Opset Version:** 18
* **Exporter Engine:** PyTorch 2.x Dynamo Exporter (`dynamo=True`)

### Model Tensor IO Interface
| Tensor Role | Name in ONNX | Data Type | Tensor Shape | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Input** | `"mix"` | `float32` | `[batch_size, 2, 343980]` | Stereo audio input chunk (~7.8s at 44.1kHz) |
| **Output** | `"split"` | `float32` | `[batch_size, 4, 2, 343980]` | 4 separated stereo stems |

### Output Stem Index Mapping (Dim 1 of `"split"`)
* `0`: **Drums**
* `1`: **Bass**
* `2`: **Other**
* `3`: **Vocals**

---

## 2. Solved Export Gotchas & Monkeypatch Mechanics

To successfully export HTDemucs to ONNX, several PyTorch / STFT / Complex-tensor limitations were resolved in `export_model.py`:

### Key Fixes Implemented:
1. **STFT `return_complex=True` Failure:**
   * *Problem:* `torch.stft(..., return_complex=True)` fails in ONNX symbolic exporters.
   * *Fix:* Patch `demucs.spec.spectro` to call `torch.stft(..., return_complex=False)` (returns float32 `[..., F, T, 2]`), then cast using `torch.view_as_complex()`.

2. **Complex Tensor Padding Failure:**
   * *Problem:* ONNX `Pad` operator does not support `complex64`. `HTDemucs._ispec` pads complex spectrograms.
   * *Fix:* Patch `HTDemucs._ispec` (`_ispec_dynamo_friendly`) to convert complex `z` to real float32 (`torch.view_as_real(z)`), apply `F.pad()`, then reconstruct complex `z`.

3. **Module Scope Binding:**
   * *Problem:* `demucs.htdemucs` imports `spectro` and `ispectro` at module load time (`from .spec import spectro, ispectro`).
   * *Fix:* Explicitly patch both `demucs.spec` AND `demucs.htdemucs` module namespaces:
     ```python
     demucs.spec.spectro = spectro_onnx
     demucs.spec.ispectro = ispectro_onnx
     demucs.htdemucs.spectro = spectro_onnx
     demucs.htdemucs.ispectro = ispectro_onnx
     HTDemucs._ispec = _ispec_dynamo_friendly
     ```

4. **Dynamic Shapes Parameter:**
   * Set `dynamic_shapes={"mix": {0: batch_dim}}`.
   * Note: The dictionary key **must** match the Python parameter name `mix` in `HTDemucs.forward(self, mix)`.

---

## 3. JavaScript / Web Runtime Wrapper Requirements

The exported ONNX model ONLY contains `HTDemucs.forward()`, which operates on a **single 7.8-second chunk** (`343,980` samples). 

The upcoming JavaScript application (running in Web Workers via `onnxruntime-web`) must implement the **chunking, overlap-add, and cross-fading pipeline** (`apply_model` logic) to process full songs without running out of memory.

```
Full Song Audio Buffer (e.g. 3 min @ 44.1kHz)
   │
   ├── 1. Resample & Convert to 44.1kHz Stereo PCM Float32 Array
   │
   ├── 2. Chunking Loop (Segment = 343,980 samples, Overlap = 25%-50%)
   │      ├── Extract Chunk [offset : offset + 343980]
   │      ├── Pad last chunk if length < 343980
   │      ├── Run Inference: ortSession.run({ mix: chunkTensor })
   │      └── Output: 4 stems of shape [1, 4, 2, 343980]
   │
   └── 3. Overlap-Add & Cross-Fading Reconstitution
          ├── Apply triangular weighting window to each chunk prediction
          ├── Accumulate predictions into full-length stem buffers
          └── Normalize by sum of weights: stem[t] /= sum_weight[t]
```

### Algorithm Details for Frontend Implementation:

1. **Audio Constants:**
   * `SAMPLE_RATE`: 44100 Hz
   * `SEGMENT_SAMPLES`: 343980 (~7.8 seconds)
   * `DEFAULT_OVERLAP`: 0.25 (25% overlap)
   * `STRIDE`: `int((1 - overlap) * SEGMENT_SAMPLES)` = `257985` samples.

2. **Triangular Cross-Fade Window Formula:**
   ```javascript
   // Create triangular window of size 343980
   const half = Math.floor(SEGMENT_SAMPLES / 2);
   const weight = new Float32Array(SEGMENT_SAMPLES);
   for (let i = 0; i < half; i++) {
       weight[i] = i + 1;
       weight[SEGMENT_SAMPLES - 1 - i] = i + 1;
   }
   const maxW = weight[half - 1];
   for (let i = 0; i < SEGMENT_SAMPLES; i++) {
       weight[i] /= maxW; // Normalize max to 1.0
   }
   ```

3. **ONNX Runtime Web Setup:**
   ```javascript
   import * as ort from 'onnxruntime-web';

   // Configure execution provider (WebGPU preferred, WASM fallback)
   ort.env.wasm.numThreads = Math.max(1, navigator.hardwareConcurrency - 1);
   
   const session = await ort.InferenceSession.create('/models/htdemucs.onnx', {
       executionProviders: ['webgpu', 'wasm'],
   });
   ```

---

## 4. Next Steps & Roadmap

1. **Frontend App Setup:** Build Vite / React / Vanilla JS Web Worker interface.
2. **Audio Processing Pipeline:** Implement Web Audio API `AudioContext` decoder for decoding `.mp3` / `.wav` files to Float32 arrays.
3. **Web Worker Integration:** Run `onnxruntime-web` inference inside a dedicated Web Worker to prevent UI thread freezing.
4. **Audio Export:** Re-encode separated stem Float32 arrays into downloadable `.wav` or `.mp3` blobs.
