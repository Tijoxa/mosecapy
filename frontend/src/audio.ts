import createOggEncoder from "@audio/encode-ogg";
import { Mp3Encoder } from "@breezystack/lamejs";
import * as Flac from "libflacjs/dist/libflac";

const TARGET_SAMPLE_RATE = 44_100;
const MP3_BLOCK_SIZE = 1_152;
const COMPRESSED_AUDIO_BLOCK_SIZE = 16_384;

export type OutputFormat = "wav" | "mp3" | "flac" | "ogg";

export type StereoPcm = {
  left: Float32Array;
  right: Float32Array;
  duration: number;
};

type FlacMetadata = {
  min_framesize: number;
  max_framesize: number;
  total_samples: number;
  md5sum: string;
};

export async function decodeAudioFile(file: File): Promise<StereoPcm> {
  const context = new AudioContext();

  try {
    const source = await context.decodeAudioData(await file.arrayBuffer());
    const frameCount = Math.ceil(source.duration * TARGET_SAMPLE_RATE);
    const offline = new OfflineAudioContext(2, frameCount, TARGET_SAMPLE_RATE);
    const node = offline.createBufferSource();
    node.buffer = source;
    node.connect(offline.destination);
    node.start();

    const rendered = await offline.startRendering();
    return {
      left: rendered.getChannelData(0).slice(),
      right: rendered.getChannelData(rendered.numberOfChannels > 1 ? 1 : 0).slice(),
      duration: rendered.duration,
    };
  } finally {
    await context.close();
  }
}

export function encodeStereoWav(left: Float32Array, right: Float32Array): Blob {
  const frames = Math.min(left.length, right.length);
  const buffer = new ArrayBuffer(44 + frames * 4);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + frames * 4, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, frames * 4, true);

  let offset = 44;
  for (let index = 0; index < frames; index += 1) {
    view.setInt16(offset, toPcm16(left[index]), true);
    view.setInt16(offset + 2, toPcm16(right[index]), true);
    offset += 4;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

export async function encodeStereoMp3(left: Float32Array, right: Float32Array): Promise<Blob> {
  const frames = Math.min(left.length, right.length);
  const encoder = new Mp3Encoder(2, TARGET_SAMPLE_RATE, 192);
  const chunks: BlobPart[] = [];

  for (let offset = 0; offset < frames; offset += MP3_BLOCK_SIZE) {
    const chunkLength = Math.min(MP3_BLOCK_SIZE, frames - offset);
    const leftChunk = new Int16Array(chunkLength);
    const rightChunk = new Int16Array(chunkLength);

    for (let index = 0; index < chunkLength; index += 1) {
      leftChunk[index] = toPcm16(left[offset + index]);
      rightChunk[index] = toPcm16(right[offset + index]);
    }

    const encoded = encoder.encodeBuffer(leftChunk, rightChunk);
    if (encoded.length > 0) chunks.push(encoded.slice());
    if (offset > 0 && offset % (MP3_BLOCK_SIZE * 128) === 0) await yieldToBrowser();
  }

  const finalChunk = encoder.flush();
  if (finalChunk.length > 0) chunks.push(finalChunk.slice());
  return new Blob(chunks, { type: "audio/mpeg" });
}

export async function encodeStereoFlac(left: Float32Array, right: Float32Array): Promise<Blob> {
  await waitForFlac();
  const frames = Math.min(left.length, right.length);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let metadata: FlacMetadata | undefined;
  const encoder = Flac.create_libflac_encoder(TARGET_SAMPLE_RATE, 2, 16, 5, frames, false);

  if (encoder === 0) throw new Error("FLAC encoder initialization failed.");

  try {
    const initStatus = Flac.init_encoder_stream(
      encoder,
      (data, byteLength) => {
        chunks.push(data.slice(0, byteLength));
      },
      (streamMetadata) => {
        metadata = streamMetadata;
      },
    );
    if (initStatus !== 0) throw new Error(`FLAC encoder initialization failed (${initStatus}).`);

    for (let offset = 0; offset < frames; offset += COMPRESSED_AUDIO_BLOCK_SIZE) {
      const chunkLength = Math.min(COMPRESSED_AUDIO_BLOCK_SIZE, frames - offset);
      const leftChunk = new Int32Array(chunkLength);
      const rightChunk = new Int32Array(chunkLength);

      for (let index = 0; index < chunkLength; index += 1) {
        leftChunk[index] = toPcm16(left[offset + index]);
        rightChunk[index] = toPcm16(right[offset + index]);
      }

      if (!Flac.FLAC__stream_encoder_process(encoder, [leftChunk, rightChunk], chunkLength)) {
        throw new Error("FLAC encoding failed.");
      }
      if (offset > 0 && offset % (COMPRESSED_AUDIO_BLOCK_SIZE * 16) === 0) await yieldToBrowser();
    }

    if (!Flac.FLAC__stream_encoder_finish(encoder)) throw new Error("FLAC finalization failed.");
    if (metadata) patchFlacMetadata(chunks, metadata);
    return new Blob([mergeByteChunks(chunks)], { type: "audio/flac" });
  } finally {
    Flac.FLAC__stream_encoder_delete(encoder);
  }
}

export async function encodeStereoOgg(left: Float32Array, right: Float32Array): Promise<Blob> {
  const frames = Math.min(left.length, right.length);
  const encoder = await createOggEncoder({ sampleRate: TARGET_SAMPLE_RATE, channels: 2, quality: 5 });
  const chunks: BlobPart[] = [];

  try {
    for (let offset = 0; offset < frames; offset += COMPRESSED_AUDIO_BLOCK_SIZE) {
      const end = Math.min(offset + COMPRESSED_AUDIO_BLOCK_SIZE, frames);
      const encoded = encoder.encode([left.subarray(offset, end), right.subarray(offset, end)]);
      if (encoded.length > 0) chunks.push(encoded.slice());
      if (offset > 0 && offset % (COMPRESSED_AUDIO_BLOCK_SIZE * 16) === 0) await yieldToBrowser();
    }

    const finalChunk = encoder.flush();
    if (finalChunk.length > 0) chunks.push(finalChunk.slice());
    return new Blob(chunks, { type: "audio/ogg" });
  } finally {
    encoder.free();
  }
}

export function mixStereoStems(
  stems: Float32Array[],
  selectedStemIndices: number[],
): { left: Float32Array; right: Float32Array } {
  if (selectedStemIndices.length === 0) throw new Error("Select at least one stem.");

  const channelPairs = selectedStemIndices.map((stemIndex) => {
    const left = stems[stemIndex * 2];
    const right = stems[stemIndex * 2 + 1];
    if (!left || !right) throw new Error("A selected stem is unavailable.");
    return { left, right };
  });
  const frames = Math.min(...channelPairs.flatMap(({ left, right }) => [left.length, right.length]));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);

  for (const channels of channelPairs) {
    for (let index = 0; index < frames; index += 1) {
      left[index] += channels.left[index];
      right[index] += channels.right[index];
    }
  }

  return { left, right };
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export function safeBaseName(fileName: string): string {
  return fileName.replace(/\.[^/.]+$/, "").replace(/[^a-z0-9-_]+/gi, "-");
}

function toPcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function mergeByteChunks(chunks: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const merged = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return merged;
}

function patchFlacMetadata(chunks: Uint8Array<ArrayBuffer>[], metadata: FlacMetadata): void {
  const marker = chunks[0];
  if (!marker || readAscii(marker, 0, 4) !== "fLaC") return;

  let streamInfo = marker;
  let markerOffset = 4;

  if (streamInfo?.byteLength === 4) {
    streamInfo = chunks[1];
    markerOffset = 0;
  }
  if (!streamInfo) return;

  const view = new DataView(streamInfo.buffer, streamInfo.byteOffset, streamInfo.byteLength);
  writeUint24(view, markerOffset + 8, metadata.min_framesize);
  writeUint24(view, markerOffset + 11, metadata.max_framesize);

  const totalSamples = BigInt(metadata.total_samples);
  view.setUint8(markerOffset + 17, (view.getUint8(markerOffset + 17) & 0xf0) | Number((totalSamples >> 32n) & 0xfn));
  view.setUint32(markerOffset + 18, Number(totalSamples & 0xffff_ffffn), false);

  for (let index = 0; index < metadata.md5sum.length / 2; index += 1) {
    view.setUint8(markerOffset + 22 + index, Number.parseInt(metadata.md5sum.slice(index * 2, index * 2 + 2), 16));
  }
}

function writeUint24(view: DataView, offset: number, value: number): void {
  view.setUint8(offset, value >>> 16);
  view.setUint8(offset + 1, value >>> 8);
  view.setUint8(offset + 2, value);
}

function readAscii(data: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...data.subarray(start, end));
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitForFlac(): Promise<void> {
  if (Flac.isReady()) return;
  await new Promise<void>((resolve) => Flac.on("ready", resolve));
}
