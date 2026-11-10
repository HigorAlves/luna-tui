// The economy's state per repository, in the machine's own state: `<stateDir>/economy/<repo slug>/` holds `envelope.json` (the tool-call counts of
// passing runs, per pack), `ledger.jsonl` (one record per run), `guard.jsonl` (what the loop guard did, the newest kept), `facts.json` (the learned
// facts and what each pack was last told) and `digests.jsonl` (the last eight runs, for the proposer), `calls.json` (the observed calls of those runs, for its detectors) and `imported.json` (the ids of the runs already folded) and `proposer.json` (closed cards counted since the start) and `tools.json` (per pack, the unused-tool evidence, the proposal and the mask). Folders are 0700, files
// 0600, a JSON file is replaced through tmp + rename, and writes to one file are served one at a time. A file that cannot be read or parsed reads as empty.
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Detector, type GuardEventRow, Observation, ProjectContextSection } from "@hardness/contracts";
import { z } from "zod";

import type { EconomyStore, ProposerState } from "../../application/economy.ts";
import { FAMILIES } from "../../domain/economy/envfacts.ts";
import { type PackTools, withoutSkills } from "../../domain/economy/prune.ts";
import type { LedgerRecord } from "../../domain/economy/ledger.ts";
import type { FactRecord, FactsFile } from "../../domain/economy/lifecycle.ts";
import { type Digest, type ObservedCall, keepDigests } from "../../domain/economy/observe-run.ts";
import { repoSlug } from "../graph/slug.ts";
import { readRegularFile } from "../fs/bounded.ts";

const READ_CAP = 16 * 1024 * 1024;
/** The run's own events, as the factory wrote them. */
const EVENTS_CAP = 32 * 1024 * 1024;
const GUARD_KEEP = 200;
/** The run ids the folded set keeps: far more than a repository's runs between two imports. */
const IMPORTED_KEEP = 5000;

const FactSchema = z.object({
  id: z.string(),
  family: z.enum([...FAMILIES, "proposed"]),
  source: z.enum(["free", "proposed"]),
  key: z.string(),
  text: z.string(),
  state: z.enum(["candidate", "active", "retired", "dropped", "promoted"]),
  confirmations: z.number().int(),
  contradictions: z.number().int(),
  score: z.number(),
  exercised: z.number().int(),
  fired: z.number().int(),
  cards: z.array(z.string()),
  firstRun: z.string(),
  lastRun: z.string(),
  streak: z.number().int(),
  detector: Detector.optional(),
  files: z.array(z.string()).optional(),
  section: ProjectContextSection.optional(),
  pending: z.object({ since: z.string(), branch: z.string() }).optional(),
});
const ToolsSchema = z.object({
  units: z.record(z.string(), z.object({ unusedRuns: z.number().int().nonnegative(), unusedCards: z.array(z.string()), everUsed: z.boolean(), kept: z.boolean() })),
  mask: z.array(z.string()),
  proposal: z.array(z.string()),
});
const CallsSchema = Observation.extend({ ok: z.boolean() });
const DigestSchema = z.object({ at: z.string(), runId: z.string(), pack: z.string(), cardId: z.string(), outcome: z.string(), calls: z.number().int(), lines: z.array(z.string()) });

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The parsed lines of a jsonl text; a line that does not parse is dropped. */
function lines(text: string): unknown[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

export function fileStore(stateDir: string): EconomyStore {
  const root = join(stateDir, "economy");
  const folder = (repoPath: string) => join(root, repoSlug(repoPath));
  const queues = new Map<string, Promise<unknown>>();
  /** Runs `job` after every earlier job on the same file. */
  const serial = <T>(path: string, job: () => Promise<T>): Promise<T> => {
    const run = (queues.get(path) ?? Promise.resolve()).then(job);
    queues.set(path, run.catch(() => undefined));
    return run;
  };
  const ensure = async (dir: string) => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(dir, { recursive: true, mode: 0o700 });
  };
  const replace = async (path: string, text: string) => {
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, path);
  };
  const readText = async (path: string, cap = READ_CAP): Promise<string> => {
    try {
      return await readRegularFile(path, cap);
    } catch {
      return "";
    }
  };
  const readLines = async (path: string): Promise<unknown[]> => lines(await readText(path));
  const readEnvelopes = async (path: string): Promise<Record<string, number[]>> => {
    try {
      const parsed = JSON.parse(await readText(path)) as unknown;
      if (!isRecord(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).flatMap(([pack, samples]) => (Array.isArray(samples) && samples.every((n) => typeof n === "number" && Number.isFinite(n)) ? [[pack, samples as number[]]] : [])));
    } catch {
      return {};
    }
  };
  /** A facts file as a value: a record that is not a fact, and a pack's list that is not a list of ids, are dropped. */
  const readFacts = async (path: string): Promise<FactsFile> => {
    try {
      const parsed = JSON.parse(await readText(path)) as unknown;
      if (!isRecord(parsed)) return { facts: [], injected: {} };
      const facts = (Array.isArray(parsed.facts) ? parsed.facts : []).flatMap((f) => {
        const ok = FactSchema.safeParse(f);
        return ok.success ? [ok.data as FactRecord] : [];
      });
      const injected = isRecord(parsed.injected) ? Object.fromEntries(Object.entries(parsed.injected).flatMap(([pack, ids]) => (Array.isArray(ids) && ids.every((i) => typeof i === "string") ? [[pack, ids as string[]]] : []))) : {};
      return { facts, injected };
    } catch {
      return { facts: [], injected: {} };
    }
  };
  const readDigests = async (path: string): Promise<Digest[]> =>
    (await readLines(path)).flatMap((row) => {
      const ok = DigestSchema.safeParse(row);
      return ok.success ? [ok.data] : [];
    });
  /** The calls of each kept run, by run id: a run whose calls do not parse is left out. */
  const readCalls = async (path: string): Promise<Record<string, ObservedCall[]>> => {
    try {
      const parsed = JSON.parse(await readText(path)) as unknown;
      if (!isRecord(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed).flatMap(([runId, calls]) => {
          const ok = z.array(CallsSchema).safeParse(calls);
          return ok.success ? [[runId, ok.data as ObservedCall[]]] : [];
        }),
      );
    } catch {
      return {};
    }
  };
  /** Each pack's tool-pruning state; a pack whose record is not one is dropped. */
  const readTools = async (path: string): Promise<Record<string, PackTools>> => {
    try {
      const parsed = JSON.parse(await readText(path)) as unknown;
      if (!isRecord(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed).flatMap(([pack, state]) => {
          const ok = ToolsSchema.safeParse(state);
          return ok.success ? [[pack, withoutSkills(ok.data)]] : [];
        }),
      );
    } catch {
      return {};
    }
  };
  const readProposer = async (path: string): Promise<ProposerState> => {
    try {
      const parsed = JSON.parse(await readText(path)) as unknown;
      const ok = z.object({ closed: z.number().int().nonnegative(), counted: z.array(z.string()) }).safeParse(parsed);
      return ok.success ? ok.data : { closed: 0, counted: [] };
    } catch {
      return { closed: 0, counted: [] };
    }
  };
  const append = (path: string, rows: unknown[]) =>
    serial(path, async () => {
      await ensure(join(path, ".."));
      await appendFile(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
    });

  const readImported = async (path: string): Promise<string[]> => {
    try {
      const ok = z.array(z.string()).safeParse(JSON.parse(await readText(path)));
      return ok.success ? ok.data : [];
    } catch {
      return [];
    }
  };

  return {
    imported: (repoPath) => readImported(join(folder(repoPath), "imported.json")),
    markImported: (repoPath, ids) => {
      const path = join(folder(repoPath), "imported.json");
      return serial(path, async () => {
        const next = [...new Set([...(await readImported(path)), ...ids])].slice(-IMPORTED_KEEP);
        await ensure(folder(repoPath));
        await replace(path, JSON.stringify(next));
      });
    },
    envelopes: (repoPath) => readEnvelopes(join(folder(repoPath), "envelope.json")),
    updateEnvelopes: (repoPath, change) => {
      const path = join(folder(repoPath), "envelope.json");
      return serial(path, async () => {
        const next = change(await readEnvelopes(path));
        await ensure(folder(repoPath));
        await replace(path, JSON.stringify(next));
      });
    },
    appendLedger: (repoPath, record) => append(join(folder(repoPath), "ledger.jsonl"), [record]),
    ledger: async (repoPath) => (await readLines(join(folder(repoPath), "ledger.jsonl"))).filter(isRecord) as unknown as LedgerRecord[],
    appendGuard: (repoPath, rows) => {
      const path = join(folder(repoPath), "guard.jsonl");
      // The file is cut back to the newest rows once it holds more than the cap; before that a row is one append.
      return serial(path, async () => {
        await ensure(folder(repoPath));
        const have = (await readLines(path)).filter(isRecord);
        const all = [...have, ...rows];
        if (all.length > GUARD_KEEP) await replace(path, all.slice(-GUARD_KEEP).map((r) => `${JSON.stringify(r)}\n`).join(""));
        else await appendFile(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
      });
    },
    guard: async (repoPath) => (await readLines(join(folder(repoPath), "guard.jsonl"))).filter(isRecord).slice(-GUARD_KEEP) as unknown as GuardEventRow[],
    facts: (repoPath) => readFacts(join(folder(repoPath), "facts.json")),
    updateFacts: (repoPath, change) => {
      const path = join(folder(repoPath), "facts.json");
      return serial(path, async () => {
        const next = change(await readFacts(path));
        await ensure(folder(repoPath));
        await replace(path, JSON.stringify(next));
      });
    },
    appendDigest: (repoPath, digest, calls = []) => {
      const path = join(folder(repoPath), "digests.jsonl");
      const callsPath = join(folder(repoPath), "calls.json");
      // The file is rewritten to the last eight runs, since a digest is read whole and never grows past that; the calls file keeps the same runs.
      return serial(path, async () => {
        await ensure(folder(repoPath));
        const kept = keepDigests([...(await readDigests(path)), digest]);
        await replace(path, kept.map((d) => `${JSON.stringify(d)}\n`).join(""));
        const all = { ...(await readCalls(callsPath)), [digest.runId]: calls };
        await replace(callsPath, JSON.stringify(Object.fromEntries(Object.entries(all).filter(([runId]) => kept.some((d) => d.runId === runId)))));
      });
    },
    digests: (repoPath) => readDigests(join(folder(repoPath), "digests.jsonl")),
    calls: (repoPath) => readCalls(join(folder(repoPath), "calls.json")),
    updateProposer: (repoPath, change) => {
      const path = join(folder(repoPath), "proposer.json");
      return serial(path, async () => {
        const next = change(await readProposer(path));
        await ensure(folder(repoPath));
        await replace(path, JSON.stringify(next));
      });
    },
    tools: (repoPath) => readTools(join(folder(repoPath), "tools.json")),
    updateTools: (repoPath, change) => {
      const path = join(folder(repoPath), "tools.json");
      return serial(path, async () => {
        const next = change(await readTools(path));
        await ensure(folder(repoPath));
        await replace(path, JSON.stringify(next));
      });
    },
    events: async (runId) => lines(await readText(join(stateDir, "runs", runId, "out", "events.jsonl"), EVENTS_CAP)),
  };
}
