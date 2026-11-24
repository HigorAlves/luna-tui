// OpenAPI route definitions of the repositories area: health, base approval, setup, config proposals and the luna.yaml checks.
// Every response schema is held to the type the handler's source returns with `expectSame`.
import { type Effort, EffortId, EngineId, PackId, ProposalsInput, SetupRepoInput, ConfigCheckInput, type RepoHealth } from "@hardness/contracts";
import { createRoute, z } from "@hono/zod-openapi";

import type { ProofJob } from "../../../application/config-proofs.ts";
import type { AppProof, Proof } from "../../../application/config-proof.ts";
import type { ConfigChange, Candidate, RepoSignal } from "../../../domain/config-proposal.ts";
import type { ConfigCheck } from "../../../domain/luna-config.ts";
import { errorResponses, expectSame, jsonBody, jsonContent, type Same } from "../openapi/schemas.ts";
import { TaskSchema } from "../openapi/task.schema.ts";

const TAGS = ["Repos"];

export const RepoHealthSchema = z
  .object({
    repo: z.string().openapi({ example: "/Users/me/shop", description: "The checkout's path" }),
    image: z.object({
      inUse: z.string(),
      base: z.string().nullable(),
      builtAt: z.string().nullable(),
      lastFailure: z.string().nullable(),
      pendingBase: z.string().nullable(),
      pendingDockerfile: z.object({ path: z.string(), key: z.string(), changed: z.boolean() }).optional(),
    }),
    bounds: z.array(z.string()).optional(),
    notes: z.array(z.string()).optional(),
    graph: z.object({
      on: z.boolean(),
      commit: z.string().nullable(),
      behind: z.number().nullable(),
      graphify: z.string().nullable(),
      builtAt: z.string().nullable(),
      building: z.boolean(),
      lastFailure: z.string().nullable(),
    }),
  })
  .openapi("RepoHealth");
expectSame<Same<z.infer<typeof RepoHealthSchema>, RepoHealth>>();

export const ConfigCheckSchema = z
  .object({ ok: z.boolean(), problems: z.array(z.string()), warnings: z.array(z.string()), unknownKeys: z.array(z.string()) })
  .openapi("ConfigCheck");
expectSame<Same<z.infer<typeof ConfigCheckSchema>, ConfigCheck>>();

const AppProofSchema = z
  .object({ ok: z.boolean(), seconds: z.number(), reason: z.string().optional(), logTail: z.string().optional(), refused: z.array(z.string()) })
  .openapi("AppProof");
expectSame<Same<z.infer<typeof AppProofSchema>, AppProof>>();

const ProofSchema = z
  .object({
    proof: z.array(z.object({ name: z.string(), cmd: z.string(), ok: z.boolean(), tail: z.string() })),
    app: AppProofSchema.nullable(),
    log: z.string(),
    refused: z.array(z.string()).openapi({ description: "Hosts a check or the app tried to reach that no list names (`host:port`)" }),
    bounds: z.array(z.string()).optional(),
  })
  .openapi("ConfigProof");
expectSame<Same<z.infer<typeof ProofSchema>, Proof>>();

const jobBase = { id: z.string(), repoPath: z.string(), startedAt: z.string() };
export const ProofJobSchema = z
  .union([
    z.object({ ...jobBase, state: z.literal("running") }),
    z.object({ ...jobBase, state: z.literal("done"), finishedAt: z.string(), check: ConfigCheckSchema, proof: ProofSchema.nullable(), suggestedAllow: z.array(z.string()) }),
    z.object({ ...jobBase, state: z.literal("failed"), finishedAt: z.string(), error: z.string() }),
  ])
  .openapi("ConfigProofJob");
expectSame<Same<z.infer<typeof ProofJobSchema>, ProofJob>>();

const CandidateSchema = z.object({
  engine: EngineId,
  effort: EffortId.nullable(),
  n: z.number(),
  quality: z.number(),
  costPerCase: z.number(),
  at: z.string(),
  model: z.string().nullable().optional(),
});
expectSame<Same<z.infer<typeof CandidateSchema>, Candidate>>();
const RepoSignalSchema = z.object({ runs: z.number(), escalations: z.number(), stuck: z.number(), costUsd: z.number(), engines: z.partialRecord(EngineId, z.number()).optional() });
expectSame<Same<z.infer<typeof RepoSignalSchema>, RepoSignal>>();

export const ConfigChangeSchema = z
  .object({
    pack: PackId,
    engine: z.object({ from: EngineId, to: EngineId }).nullable(),
    effort: z.object({ from: EffortId, to: EffortId }).nullable(),
    why: z.string(),
    evidence: z.object({ current: CandidateSchema, next: CandidateSchema, signal: RepoSignalSchema }),
  })
  .openapi("ConfigChange");
expectSame<Same<z.infer<typeof ConfigChangeSchema>, ConfigChange>>();
expectSame<Same<Effort, z.infer<typeof EffortId>>>();

type ProposalAnswer = { changes: ConfigChange[]; taskId: string | null; skipped?: Array<{ pack: z.infer<typeof PackId>; reason: string }> };
export const ProposalAnswerSchema = z
  .object({
    changes: z.array(ConfigChangeSchema),
    taskId: z.string().nullable().openapi({ description: "The `config` card waiting at the setup gate; null when there is nothing to propose" }),
    skipped: z.array(z.object({ pack: PackId, reason: z.string() })).optional().openapi({ description: "Packs left out because no single engine ran 80% of their runs" }),
  })
  .openapi("ConfigProposal");
expectSame<Same<z.infer<typeof ProposalAnswerSchema>, ProposalAnswer>>();

export const listReposRoute = createRoute({
  operationId: "listRepos",
  method: "get",
  path: "/repos",
  tags: TAGS,
  summary: "Each repository the machine knows, with its sandbox image and code graph",
  description: "From the repo map, the repos dir and live tasks. An empty list when the machine keeps no graphs or images. Text (a base's name, a failure reason) is flattened and capped.",
  responses: { 200: jsonContent(z.array(RepoHealthSchema), "The repositories"), ...errorResponses() },
});

/** What the handler reads by hand (`repo` and `base`, both non-empty strings): the schema describes it, and accepts anything so the handler's own 400 stays. */
const ApproveBaseBody = z
  .unknown()
  .openapi({
    type: "object",
    properties: { repo: { type: "string", description: "A repository the machine knows" }, base: { type: "string", description: "The image reference luna.yaml or the devcontainer names now, or `dockerfile=sha256:<hex>`" } },
    required: ["repo", "base"],
  });

export const approveBaseRoute = createRoute({
  operationId: "approveRepoBase",
  method: "post",
  path: "/repos/base/approve",
  tags: TAGS,
  summary: "Approve a repository's base image",
  description: "Approves that exact base for that repository, so the machine pulls or builds from it. An approved base is trusted with the stage's credential, like code you run yourself. A 400 follows when the repository is not one the machine knows, when `base` is not what the checkout names now, or when the policy refuses it. The route is absent when the machine has no base approval.",
  request: jsonBody(ApproveBaseBody),
  responses: {
    200: jsonContent(z.object({ repo: z.string(), base: z.string(), approved: z.literal(true) }), "The base is approved"),
    ...errorResponses(400),
  },
});

export const setupRepoRoute = createRoute({
  operationId: "setupRepo",
  method: "post",
  path: "/repos/setup",
  tags: TAGS,
  summary: "Start a setup task for a checkout",
  description: "A setup-only task (route `setup`), started at once; its one gate is the proposed `luna.yaml` with the proof per check. Approving writes the file and closes the task.",
  request: jsonBody(SetupRepoInput),
  responses: { 201: jsonContent(TaskSchema, "The setup task"), ...errorResponses(400, 409) },
});

export const proposalsRoute = createRoute({
  operationId: "proposeConfig",
  method: "post",
  path: "/repos/proposals",
  tags: TAGS,
  summary: "Propose engine and effort changes to a repo's luna.yaml",
  description: "The scorecards come in the body; the repo's luna.yaml and its own run signals of the last 30 days are read here, a fixed rule picks at most 3 changes, and a non-empty result waits at the setup gate as a `config` card (`taskId`). 404 `unknown_repo` when the machine does not know the path; 422 `invalid_config` when the repo's luna.yaml does not load or the new file would not.",
  request: jsonBody(ProposalsInput),
  responses: { 200: jsonContent(ProposalAnswerSchema, "The changes proposed and the card that holds them"), ...errorResponses(400, 404, 409, 422) },
});

export const checkConfigRoute = createRoute({
  operationId: "checkConfig",
  method: "post",
  path: "/repos/config/check",
  tags: TAGS,
  summary: "Check a luna.yaml's text",
  description: "Checks the text as the machine reads it, writing nothing. Every schema problem is listed; `unknownKeys` are the dotted paths the machine would ignore (a misspelt key, usually).",
  request: jsonBody(ConfigCheckInput),
  responses: { 200: jsonContent(ConfigCheckSchema, "The check's result"), ...errorResponses(400) },
});

export const proveConfigRoute = createRoute({
  operationId: "proveConfig",
  method: "post",
  path: "/repos/config/prove",
  tags: TAGS,
  summary: "Prove a repository's luna.yaml in the sandbox",
  description: "Starts a job that runs every check of the luna.yaml at the repository's root once in a throwaway clone; read it with `GET /repos/config/prove/{id}`. A proof already running for the repository is answered instead of a second one. 503 `sandbox_off` when the machine has no sandbox.",
  request: jsonBody(SetupRepoInput),
  responses: { 202: jsonContent(ProofJobSchema, "The proof job"), ...errorResponses(400, 503) },
});

export const proofJobRoute = createRoute({
  operationId: "getConfigProof",
  method: "get",
  path: "/repos/config/prove/{id}",
  tags: TAGS,
  summary: "Read a luna.yaml proof job",
  description: "Jobs live in memory: a restart forgets them (404).",
  request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The job's id" }) }) },
  responses: { 200: jsonContent(ProofJobSchema, "The job: running, done or failed"), ...errorResponses(404) },
});
