// Change size and splits (wave 15): what the two decisions `size_estimate` and `split_check` read,
// and the shape of a child the decomposer proposes. A child is model-written, so it has no key for
// a repository, a branch, a base, an engine or an owner: it names other children by position only.
import { z } from "zod";

/** One child of a split, as the decomposer wrote it. Strict: nothing the machine would act on but these keys. */
export const SplitChild = z.strictObject({
  title: z.string().max(200),
  goal: z.string().max(1000),
  acceptance_criteria: z.array(z.string().max(300)).min(1).max(10),
  /** The origin's criterion ids this child does. */
  covers: z.array(z.string().regex(/^C\d{1,3}$/)).max(20),
  files_hint: z.array(z.string().max(300)).max(20),
  est_loc: z.number().int().min(1).max(100_000),
  /** 1-based positions of other children. */
  depends_on: z.array(z.number().int()).max(19),
  order: z.number().int().min(1).max(20),
});
export type SplitChild = z.infer<typeof SplitChild>;

const Limits = z.object({ target: z.tuple([z.number(), z.number()]), hard: z.number() });
const FileHint = z.object({ path: z.string().max(300), role: z.string().max(100).optional() });

/** What size_estimate reads: the ticket or record, the files and symbols the code map names, the nearest closed changes with their counted size, and the limits. */
export const SizeContext = z.object({
  title: z.string().max(500),
  text: z.string().max(4000),
  criteria: z.array(z.string().max(500)).max(20),
  files: z.array(FileHint).max(40),
  symbols: z.array(z.string().max(200)).max(40),
  similar: z.array(z.object({ title: z.string().max(200), added: z.number().int().min(0), removed: z.number().int().min(0) })).max(5),
  limit: Limits,
});
export type SizeContext = z.infer<typeof SizeContext>;

/** What split_check reads: the origin, the proposed children and the script's own findings. */
export const SplitContext = z.object({
  origin: z.object({ title: z.string().max(500), text: z.string().max(4000), criteria: z.array(z.object({ id: z.string().max(20), text: z.string().max(500) })).max(20) }),
  files: z.array(FileHint).max(40),
  limit: Limits.extend({ maxChildren: z.number() }),
  children: z.array(SplitChild).max(20),
  round: z.number().int(),
  issues: z.array(z.string().max(300)).max(20).optional(),
  note: z.string().max(2000).optional(),
});
export type SplitContext = z.infer<typeof SplitContext>;
