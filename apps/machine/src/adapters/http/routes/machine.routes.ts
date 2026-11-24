// The machine itself: health, packs, engines, packs on demand, the foreman, the ticket planner, the slot knobs, metrics and the dev stubs.
import { EngineId, METRICS_GROUP_BY, type MetricsGroupBy, PACKS, PackId, TaskState } from "@hardness/contracts";
import { TicketChatAnswer, ForemanAnswer, type ForemanSuggestion, foremanActionProblem, isTerminal } from "@hardness/contracts";
import { buildForemanBoard } from "../../../domain/foreman.ts";
import { basename, isAbsolute } from "node:path";
import { economyMetrics } from "../../../domain/economy/metrics.ts";
import { ZodError } from "zod";
import { sandboxPolicyNotes } from "../../../config.ts";
import { computeMetrics } from "../../persistence/metrics-query.ts";
import { packInfo } from "../../../domain/packs.ts";
import { engineInfo } from "../../../domain/engines.ts";
import { RunCredentialBusyError, RunFailedError } from "../../../application/pack-runs.ts";
import { InvalidSince, parseSince } from "../metrics.ts";
import { createOpenApiRouter } from "../openapi/router.ts";
import { devStubsRoute, drainRoute, enginesRoute, foremanRoute, healthRoute, metricsRoute, packsRoute, resumeRoute, runsRoute, setSlotsRoute, ticketChatRoute } from "./machine.openapi.ts";
import { ROUTE_ONLY_PACKS, ROUTE_OF, realOrNull, BadRequest, fail, CLIENT_NAME, type RouteDeps } from "./kit.ts";

export function machineRoutes(deps: RouteDeps) {
  const { repoHealth, economy, db, pipeline, stubs, credentials, engineBudgets, runs, knownRepos, chatRepos, problemsOf, sandboxPolicy } = deps;
  const app = createOpenApiRouter();
  app.openapi(healthRoute, async (c) => {
    const problems = (await problemsOf?.()) ?? [];
    const idle = sandboxPolicy ? sandboxPolicyNotes(sandboxPolicy).notInForce : [];
    const policy = sandboxPolicy ? { sandboxPolicy, ...(idle.length > 0 ? { notInForce: idle } : {}) } : {};
    if (problems.length === 0) return c.json({ ok: true as const, slots: pipeline.slots, ...policy }, 200);
    return c.json({ ok: false as const, problems, slots: pipeline.slots, ...policy }, 503);
  });

  /** Every pack in the registry, with the task states it runs in. */
  app.openapi(packsRoute, (c) => c.json(PackId.options.map((id) => packInfo(PACKS[id])), 200));

  /** Every engine, and whether this machine has the credential it needs; never the credential. */
  app.openapi(enginesRoute, async (c) => {
    const standings = await engineBudgets.standings();
    return c.json(await Promise.all(EngineId.options.map(async (id) => engineInfo(id, await credentials.check(id), standings.get(id)))), 200);
  });

  /** One context-only pack on data the client sends: its validated answer and what it cost. */
  app.openapi(runsRoute, async (c) => {
    const input = c.req.valid("json");
    if (ROUTE_ONLY_PACKS.includes(input.pack)) throw new BadRequest(`${input.pack} is not run through POST /runs: use ${ROUTE_OF[input.pack]}`);
    const client = c.req.header("x-luna-client") ?? null;
    if (client !== null && !CLIENT_NAME.test(client)) throw new BadRequest("X-Luna-Client must be 1 to 64 letters, digits, dots, dashes or underscores");
    if (!runs) return fail(c, 503, "agents_off", "this machine runs no packs: agents are off (MACHINE_AGENTS=off)");
    // The request's own signal: a client that leaves is dropped from the queue, or its container stopped.
    return c.json(await runs.run(input, client, c.req.raw.signal), 200);
  });

  /** The foreman: one question on the open board, answered with a reply and actions the board can take. It only suggests; the board makes each call after a person's `y`. */
  app.openapi(foremanRoute, async (c) => {
    const { question, history } = c.req.valid("json");
    if (!runs) return fail(c, 503, "agents_off", "this machine runs no packs: agents are off (MACHINE_AGENTS=off)");
    const open = (await pipeline.list()).filter((row) => !isTerminal(row.state));
    const glances = await pipeline.glances(open.map((row) => row.id));
    const gates = new Map([...glances].flatMap(([id, glance]) => (glance.gate ? [[id, glance.gate] as const] : [])));
    const packs = Object.values(PACKS).filter((pack) => packInfo(pack).states.length > 0);
    // Base images and Dockerfiles that wait for approval keep their own board flow; the foreman only names them.
    const pending = ((await repoHealth?.().catch(() => [])) ?? []).flatMap((health) => [
      ...(health.image.pendingBase ? [{ repo: basename(health.repo), kind: "base" as const, ref: health.image.pendingBase }] : []),
      ...(health.image.pendingDockerfile ? [{ repo: basename(health.repo), kind: "dockerfile" as const, ref: health.image.pendingDockerfile.path }] : []),
    ]);
    const board = buildForemanBoard(open, gates, packs, new Date(), pending.slice(0, 50));
    let answer: ForemanAnswer;
    try {
      const result = await runs.run({ pack: "foreman", context: { foreman: { question, history: history ?? [], board } } }, "board", c.req.raw.signal);
      answer = ForemanAnswer.parse(result.answer);
    } catch (error) {
      if (error instanceof RunFailedError) return fail(c, 502, "foreman_failed", error.message);
      if (error instanceof ZodError) return fail(c, 502, "foreman_failed", "the foreman gave no valid answer");
      throw error;
    }
    const actions: ForemanSuggestion[] = [];
    const dropped: Array<{ action: ForemanAnswer["actions"][number]; problem: string }> = [];
    for (const action of answer.actions) {
      const problem = foremanActionProblem(action, board);
      if (problem !== null) {
        dropped.push({ action, problem });
        continue;
      }
      const approvalId = board.cards.find((card) => card.id === action.taskId)?.approvalId ?? null;
      // `POST /tasks/:id/answers` keys an answer by the question's text; the model keyed it by the id the snapshot gave.
      if (action.kind === "answer") {
        const asked = board.cards.find((card) => card.id === action.taskId)?.questions ?? [];
        actions.push({ ...action, answers: Object.fromEntries(Object.entries(action.answers).map(([id, text]) => [asked.find((q) => q.id === id)?.question ?? id, text])), approvalId });
        continue;
      }
      actions.push({ ...action, approvalId });
    }
    return c.json({ reply: answer.reply, actions, dropped }, 200);
  });

  /** The ticket planner: one turn of a talk about a ticket, reading a throwaway copy of the repo's tracked files. It only drafts; the board creates the card. */
  app.openapi(ticketChatRoute, async (c) => {
    const { repo: given, engine, message, history, notes, draft } = c.req.valid("json");
    if (!isAbsolute(given)) throw new BadRequest("repo must be an absolute path");
    // The planner reads a copy of this folder: it must be, by real path, a repo of the map or one remembered, so a symlink or a `..` leads nowhere else.
    const repo = await realOrNull(given);
    const listed = repo === null ? [] : (await Promise.all((await chatRepos()).map(realOrNull))).filter((known) => known === repo);
    if (repo === null || listed.length === 0) return fail(c, 404, "unknown_repo", "the machine does not know that repository");
    // The name goes into the prompt's header, so it keeps only the characters a header may carry; it only labels the repo.
    const name = basename(repo).replace(/[^\w.-]/g, "-").slice(0, 100) || "repo";
    if (!runs) return fail(c, 503, "agents_off", "this machine runs no packs: agents are off (MACHINE_AGENTS=off)");
    try {
      const result = await runs.run({ pack: "ticket_chat", ...(engine ? { engine } : {}), context: { ticketChat: { repo: { name, path: repo }, message, history, notes, draft } } }, "board", c.req.raw.signal, { readRepo: repo });
      return c.json(TicketChatAnswer.parse(result.answer), 200);
    } catch (error) {
      if (error instanceof RunCredentialBusyError) return fail(c, 409, "engine_busy", "that engine's login is busy with another run: try the other engine, or again in a minute");
      if (error instanceof RunFailedError) return fail(c, 502, "ticket_chat_failed", error.message);
      if (error instanceof ZodError) return fail(c, 502, "ticket_chat_failed", "the planner gave no valid answer");
      throw error;
    }
  });

  // "Stop picking up work" / "carry on" / "run N at once": the knobs for leaving and for debugging.
  app.openapi(drainRoute, (c) => c.json(pipeline.drain(), 200));
  app.openapi(resumeRoute, (c) => c.json(pipeline.resumeClaims(), 200));
  app.openapi(setSlotsRoute, (c) => {
    const { max } = c.req.valid("json");
    return c.json(pipeline.setSlots(max), 200);
  });

  app.openapi(metricsRoute, async (c) => {
    let since: Date;
    try {
      since = parseSince(c.req.query("since"));
    } catch (error) {
      if (error instanceof InvalidSince) throw new BadRequest(error.message);
      throw error;
    }
    const budget = { ...pipeline.budget, spentTodayUsd: await pipeline.spentTodayUsd() };
    const groupBy = c.req.query("groupBy");
    if (groupBy !== undefined && !(METRICS_GROUP_BY as readonly string[]).includes(groupBy)) throw new BadRequest(`groupBy must be one of ${METRICS_GROUP_BY.join(", ")}, got "${groupBy}"`);
    const repo = c.req.query("repo");
    const metrics = await computeMetrics(db, {
      since,
      slots: pipeline.slots,
      budget,
      ...(repo !== undefined ? { repo: repo === "" ? null : repo } : {}),
      ...(groupBy !== undefined ? { groupBy: groupBy as MetricsGroupBy } : {}),
    });
    // The economy's numbers come from its own files, never from Postgres: one repository's, or every known one's added up.
    // A `repo` the machine does not know gets none: its path is the client's, and the policy for it would be read from that host path.
    const knownRepos = economy && repo !== "" ? await economy.knownRepos() : [];
    if (economy && repo !== "" && (repo === undefined || knownRepos.includes(repo))) {
      const repos = repo !== undefined ? [repo] : knownRepos;
      const statuses = await Promise.all(repos.map(async (r) => economy.port.status(r, (await economy.configOf(r)).guard.envelope_min_samples)));
      return c.json({ ...metrics, economy: economyMetrics(statuses) }, 200);
    }
    return c.json(metrics, 200);
  });

  if (stubs) {
    app.openapi(devStubsRoute, (c) => {
      const plan = c.req.valid("json");
      stubs.plan(TaskState.parse(plan.stage), ...plan.results);
      return c.json({ stage: plan.stage, queued: plan.results.length }, 200);
    });
  }
  return app;
}
