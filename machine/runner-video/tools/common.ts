// Shared by the tools: argument parsing, running a program, and keeping every path under the job
// dir. A tool reads and writes under `/work` (LUNA_JOB overrides it for a host-side run) and never
// follows a path out of it: a timeline, a timing file or a recording name comes from a model.
import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const JOB = process.env.LUNA_JOB ?? "/work";
export const MODELS = process.env.LUNA_MODELS ?? "/models";

export function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

export function need(args: Record<string, string | true>, name: string): string {
  const v = args[name];
  if (typeof v !== "string") throw new Error(`missing --${name}`);
  return v;
}

/** `p` resolved against the job dir, refused when it leaves it (symlinks followed; a path not yet written is judged by its parent). */
export function underJob(p: string, job = JOB): string {
  const root = realpathSync(job);
  const abs = isAbsolute(p) ? resolve(p) : resolve(job, p);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    real = join(realpathSync(dirname(abs)), basename(abs));
  }
  const rel = relative(root, real);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${p} is outside the job dir ${job}`);
  return real;
}

/** A regular file under the job dir no larger than `maxBytes`. */
export function regularFile(p: string, maxBytes: number, job = JOB): string {
  const real = underJob(p, job);
  const st = statSync(real);
  if (!st.isFile()) throw new Error(`${p} is not a regular file`);
  if (st.size > maxBytes) throw new Error(`${p} is ${st.size} bytes, over the ${maxBytes} cap`);
  return real;
}

export type Ran = { code: number; stdout: string; stderr: string };

export function run(cmd: string, args: string[], opts: { input?: Buffer; binary?: false } = {}): Promise<Ran> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", rej);
    child.on("close", (code) => res({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input);
  });
}

export async function mustRun(cmd: string, args: string[]): Promise<Ran> {
  const r = await run(cmd, args);
  if (r.code !== 0) throw new Error(`${cmd} ${args.slice(0, 4).join(" ")} exited ${r.code}: ${r.stderr.slice(-800)}`);
  return r;
}

/** Raw bytes of a program's stdout (ffmpeg writing rawvideo or f32le audio). */
export function runBytes(cmd: string, args: string[], onChunk?: (c: Buffer) => void): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => (onChunk ? onChunk(d) : out.push(d)));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", rej);
    child.on("close", (code) => res({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

export async function probe(file: string): Promise<{ durationS: number; hasAudio: boolean; hasVideo: boolean; w: number; h: number; fps: number }> {
  const r = await mustRun("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]);
  const j = JSON.parse(r.stdout) as { streams: { codec_type: string; width?: number; height?: number; r_frame_rate?: string }[]; format: { duration?: string } };
  const v = j.streams.find((s) => s.codec_type === "video");
  const [n, d] = (v?.r_frame_rate ?? "30/1").split("/").map(Number);
  return {
    durationS: Number(j.format.duration ?? 0),
    hasAudio: j.streams.some((s) => s.codec_type === "audio"),
    hasVideo: Boolean(v),
    w: v?.width ?? 0,
    h: v?.height ?? 0,
    fps: n && d ? n / d : 30,
  };
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000;
