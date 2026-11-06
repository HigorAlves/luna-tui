// The two local models: kokoro-js for the voice, whisper-tiny.en (transformers.js) for word
// timestamps. In the image both read from /models and never the network; `--warm` (the Dockerfile)
// is the one time remote models are allowed.
import { env, pipeline } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";

import { MODELS, runBytes } from "./common.ts";

export const TTS_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const ASR_MODEL = "Xenova/whisper-tiny.en";

export function configureModels(allowRemote: boolean): void {
  env.cacheDir = MODELS;
  env.allowRemoteModels = allowRemote;
  env.allowLocalModels = true;
}

export async function loadTts() {
  return KokoroTTS.from_pretrained(TTS_MODEL, { dtype: "q8", device: "cpu" });
}

export async function loadAsr() {
  return pipeline("automatic-speech-recognition", ASR_MODEL);
}

export type AsrWord = { w: string; t0: number; t1: number };

/** 16 kHz mono float samples of any audio file, decoded by ffmpeg. */
export async function samples(file: string): Promise<Float32Array> {
  const r = await runBytes("ffmpeg", ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"]);
  if (r.code !== 0) throw new Error(`ffmpeg could not decode ${file}: ${r.stderr.slice(-400)}`);
  const buf = r.stdout;
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength - (buf.byteLength % 4)));
}

type Asr = Awaited<ReturnType<typeof loadAsr>>;
type Chunk = { text: string; timestamp: [number, number | null] };

export async function words(asr: Asr, file: string): Promise<AsrWord[]> {
  const out = (await asr(await samples(file), { return_timestamps: "word", chunk_length_s: 30 })) as { chunks?: Chunk[] };
  return (out.chunks ?? [])
    .map((c) => ({ w: c.text.trim(), t0: c.timestamp[0], t1: c.timestamp[1] ?? c.timestamp[0] + 0.2 }))
    .filter((x) => x.w.length > 0);
}

export async function transcript(asr: Asr, file: string): Promise<string> {
  const out = (await asr(await samples(file), { chunk_length_s: 30 })) as { text?: string };
  return (out.text ?? "").trim();
}
