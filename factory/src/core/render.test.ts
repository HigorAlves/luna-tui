import { PACKS, type StageInput } from "@hardness/contracts";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { EVE_TOOL_NAMES, FACTORY_RULES, callLine, escalationLine, factoryRules, renderPrompt } from "./render.ts";

const input: StageInput = {
  schema: 3,
  stage: "implementing",
  pack: "implementing",
  attempt: 2,
  task: { id: "t1", title: "Fix the bug", description: "It breaks & crashes", criteria: ["no crash", "a/b"], repoPath: "/r", branch: "task/t1-fix", source: null },
  plan: { brief: "do it", criteria: ["c1"], assumptions: ["a1"], slices: [{ title: "s1", est_loc: 10, touchpoints: ["a.ts"], acceptance: ["ok"] }] },
  decisions: [
    { at: "triage", decision: "answered", reason: null, answers: { Q: "A" } },
    { at: "awaiting_approval", decision: "approved", reason: "go", answers: {} },
  ],
  priorFindings: [{ path: "a.ts", line: 3, severity: "bug", title: "null deref", body: "", confidence: 0.9 }],
  context: { projectContext: null, testCases: [{ title: "t", criterion: "c1", approach: "run it" }] },
  limits: { maxTurns: 10, timeoutMs: 1000 },
  env: { LUNA_FACTORY: "1" },
};

describe("renderPrompt", () => {
  const template = [
    "# {{agent}} attempt {{attempt}} on {{task.branch}}",
    "{{task.title}}: {{task.description}}",
    "criteria:\n{{task.criteria}}",
    "brief: {{plan.brief}}\nslices:\n{{plan.slices}}",
    "decisions:\n{{decisions}}",
    "findings:\n{{priorFindings}}",
    "cases:\n{{context.testCases}}",
    "context: {{context.projectContext}}",
    "skills: {{skills}}",
  ].join("\n");

  it("fills every placeholder, keeping user text verbatim (slashes and ampersands included)", () => {
    const prompt = renderPrompt({ pack: PACKS.implementing, input, template, projectContext: "Rules here" });
    expect(prompt).toContain("# implementer attempt 2 on task/t1-fix");
    expect(prompt).toContain("Fix the bug: It breaks & crashes");
    expect(prompt).toContain("- no crash\n- a/b");
    expect(prompt).toContain("1. s1 (~10 LOC; touches a.ts): ok");
    expect(prompt).toContain('- answered at triage: {"Q":"A"}\n- approved at awaiting_approval: go');
    expect(prompt).toContain("- bug a.ts:3 null deref");
    expect(prompt).toContain("- t (criterion: c1): run it");
    expect(prompt).toContain("context: Rules here");
    expect(prompt).toContain("skills: tdd, verification-before-completion, code-discovery");
    expect(prompt).not.toContain("{{");
  });

  it("fills placeholders once: client text that looks like one stays as written", () => {
    const sneaky = { ...input, task: { ...input.task, title: "{{agent}}", description: "see {{context.jira.issue}} and {{plan.brief}}" } };
    const prompt = renderPrompt({ pack: PACKS.implementing, input: sneaky, template, projectContext: "Rules here" });
    expect(prompt).toContain("{{agent}}: see {{context.jira.issue}} and {{plan.brief}}");
    expect(prompt).toContain("# implementer attempt 2");
  });

  it("prefers the input's project context over the worktree file, and prints (none) for what is missing", () => {
    const withContext = { ...input, context: { ...input.context, projectContext: "From input" } };
    expect(renderPrompt({ pack: PACKS.implementing, input: withContext, template, projectContext: "file" })).toContain("context: From input");
    const bare = { ...input, plan: null, decisions: [], priorFindings: [], context: { projectContext: null } };
    const prompt = renderPrompt({ pack: PACKS.triage, input: bare, template });
    expect(prompt).toContain("brief: (none)\nslices:\n(none)");
    expect(prompt).toContain("decisions:\n(none)");
    expect(prompt).toContain("context: (none)");
  });

  it("opens with the role, the stage and how this stage ends when it cannot settle something; no schema dump", () => {
    const prompt = renderPrompt({ pack: PACKS.triage, input: { ...input, pack: "triage", stage: "triage" }, template: "body" });
    const [header, rest] = prompt.split("\n");
    expect(header).toContain("`triage-planner` role running the `triage` stage in factory mode (LUNA_FACTORY=1)");
    expect(header).toContain('answer kind "questions" (at most three');
    expect(rest).toBe("body");
    expect(prompt).not.toContain('"properties"');
    expect(prompt).not.toContain("Answer ONLY");
    expect(prompt.endsWith("\nbody")).toBe(true);
  });

  it("names each pack's own escalation shape: questions, escalated, needs_brief, or none", () => {
    expect(escalationLine(PACKS.test_design)).toContain('kind "questions"');
    for (const id of ["setup", "implementing", "verifying", "e2e", "ci_watch", "reviewing", "addressing"] as const) expect(escalationLine(PACKS[id])).toContain('kind "escalated" with escalation (plan_wrong · env_broken · flaky_tests · too_complex · undeclared_scope · other), reason and options[]');
    expect(escalationLine(PACKS.jira_intake)).toContain('verdict "needs_brief"');
    expect(escalationLine(PACKS.slack_triage)).toContain("no escalation");
    expect(escalationLine(PACKS.reviewing_memory)).toContain("no escalation");
    expect(renderPrompt({ pack: PACKS.implementing, input, template: "x" })).not.toContain("questions");
  });

  it("renders the CI facts, the base commit and the QA targets for the packs that read them", () => {
    const template = "base {{context.baseCommit}}\nci:\n{{context.ci}}\ntargets:\n{{context.qaTargets}}";
    const ci = { pr: { number: 7, url: "https://x/pr/7" }, checks: [{ name: "test", state: "failure", url: null }], logs: "FAIL a.test.ts" };
    const qaTargets = [{ name: "staging", baseUrl: "https://stg.example.com", credential: "env:QA_PASSWORD" }, { name: "local", baseUrl: "http://127.0.0.1:3000", credential: null }];
    const rich = { ...input, context: { ...input.context, baseCommit: "9c1f0e2a", ci, qaTargets } };
    const prompt = renderPrompt({ pack: PACKS.ci_watch, input: rich, template });
    expect(prompt).toContain("base 9c1f0e2a");
    expect(prompt).toContain("PR #7 (https://x/pr/7)\nChecks:\n- test: failure\nFailed run log tail:\n```\nFAIL a.test.ts\n```");
    expect(prompt).toContain("- staging: https://stg.example.com (credential: env:QA_PASSWORD)\n- local: http://127.0.0.1:3000");
    const bare = renderPrompt({ pack: PACKS.ci_watch, input, template });
    expect(bare).toContain("base (none)\nci:\n(none)\ntargets:\n(none)");
  });

  it("renders the thread and the pack for pr_reply, with no placeholder left", () => {
    const template = readFileSync(new URL("../../prompts/pr_reply.md", import.meta.url), "utf8");
    const ship = { kind: "comment" as const, comment: { thread: { id: "T9", path: "a.ts", line: 7, comments: [{ author: "ana", body: "why a map here?", at: "2026-11-04T10:00:00Z" }] }, pack: { summary: "Adds the export", scenarios: [{ text: "it exports", result: "pass" }], howToVerify: "press e" }, myReplies: 0 } };
    const evidence = { summary: "Adds the export", format: "text" as const, scenarios: [{ text: "it exports", test: null, result: "pass" as const }], findings: [], outOfMap: [], risk: "low" as const, rollback: "revert", howToVerify: "press e", commitSha: "9c1f0e2a7b3d", media: [], at: "t" };
    const prompt = renderPrompt({ pack: PACKS.pr_reply, input: { ...input, stage: "pr_reply", pack: "pr_reply", task: { ...input.task, evidence }, context: { projectContext: null, ship } }, template });
    expect(prompt).not.toContain("{{");
    for (const part of ["### Thread T9 at a.ts:7", "@ana (2026-11-04T10:00:00Z): why a map here?", "How to verify: press e", "Commit: 9c1f0e2"]) expect(prompt).toContain(part);
  });

  it("renders the retro's predicted-against-actual table for the retro, and none without facts", () => {
    const template = readFileSync(new URL("../../prompts/reviewing_memory.md", import.meta.url), "utf8");
    const retro = { predicted: { size: "small", risk: "low", estLoc: 120 }, actual: { added: 300, removed: 40, retries: { verify: 1, e2e: 0, ci: 1, total: 2 }, escalations: 1, format: "captures", durationMin: 95 }, runs: 11 };
    const prompt = renderPrompt({ pack: PACKS.reviewing_memory, input: { ...input, stage: "reviewing_memory", pack: "reviewing_memory", context: { projectContext: null, ship: { kind: "retro" as const, retro } } }, template });
    expect(prompt).not.toContain("{{");
    for (const part of ["| size | small | 340 lines changed (+300 -40) |", "| estimated LOC | 120 | 340 |", "verify 1, e2e 0, ci 1, 2 in all", "| escalations | 0 | 1 |", "| format | (chosen at Evidence) | captures |", "95 min", "Stage runs: 11"]) expect(prompt).toContain(part);
    expect(renderPrompt({ pack: PACKS.reviewing_memory, input, template })).toContain("predicted against actual\n(none)");
  });

  it("says where the code graph is and how fresh, or that there is none", () => {
    const template = "{{context.graph}}";
    const graph = { path: "/graph/graphify-out/graph.json", commit: "9c1f0e2a7b3d4e5f", builtAt: "2026-11-04T10:00:00Z", fresh: true };
    const render = (g: typeof graph | null | undefined) => renderPrompt({ pack: PACKS.implementing, input: { ...input, context: { ...input.context, ...(g === undefined ? {} : { graph: g }) } }, template });
    expect(render(graph)).toContain("Code graph: /graph/graphify-out/graph.json, built at 9c1f0e2 on 2026-11-04 (fresh)");
    expect(render({ ...graph, fresh: false })).toContain("Code graph: /graph/graphify-out/graph.json, built at 9c1f0e2 on 2026-11-04 (stale: the base commit is newer; prefer Grep for changed areas)");
    expect(render(null)).toContain("Code graph: (none: use Glob, Grep and Read)");
    expect(render(undefined)).toContain("Code graph: (none: use Glob, Grep and Read)");
  });

  it("lists the files the graph says depend on what changed, or says there are none", () => {
    const template = "{{context.blastRadius}}";
    const render = (radius?: string[]) => renderPrompt({ pack: PACKS.verifying, input: { ...input, pack: "verifying", stage: "verifying", context: { ...input.context, ...(radius ? { blastRadius: radius } : {}) } }, template });
    expect(render(["src/b.ts", "src/c.ts"])).toContain("- src/b.ts\n- src/c.ts");
    expect(render([])).toContain("(none)");
    expect(render(undefined)).toContain("(none)");
  });

  it("renders the e2e template with the approved scenarios and leaves no placeholder", () => {
    const template = readFileSync(new URL("../../prompts/e2e.md", import.meta.url), "utf8");
    const e2e = { ...input, pack: "e2e" as const, stage: "e2e" as const, context: { projectContext: null, testCases: [{ title: "Rejects a bad password", criterion: "no crash", approach: "Given a user, When a bad password is sent, Then 401" }], qaTargets: [] } };
    const prompt = renderPrompt({ pack: PACKS.e2e, input: e2e as never, template });
    expect(prompt).toContain("- Rejects a bad password (criterion: no crash): Given a user, When a bad password is sent, Then 401");
    expect(prompt).toContain("steps.jsonl");
    expect(prompt).not.toContain("{{");
  });

  it("renders the video context, the evidence pack as text, and leaves no placeholder in any video template", () => {
    const video = {
      scenarios: [{ title: "A coupon counts once", criterion: "c1", approach: "apply twice" }],
      record: null,
      pack: { summary: "Discounts show in the cart.", howToVerify: "open the cart", risk: "low" as const },
      steps: ['{"scenario":"a","step":"click"}'],
      chapters: [{ title: "A coupon", start: 4 }],
      target: { name: "local", baseUrl: "http://127.0.0.1:3000", credential: "env:QA_PASSWORD" },
      narration: [{ id: "a", durationS: 12.5 }],
      timeline: { meta: { dur: 60 } },
      report: { verdict: "pass" },
      transcript: "apply the coupon",
      sheets: ["/evidence/sheets/beats_sheet.jpg"],
      fixCards: [{ t: 12.5, scene: "cart", element: "cta", text: "the headline is cut off", priority: "P1" as const }],
    };
    const evidence = { summary: "Discounts show in the cart.", format: "video" as const, scenarios: [{ text: "A coupon counts once", test: null, result: "pass" as const }], findings: [], outOfMap: [], risk: "low" as const, rollback: "revert", howToVerify: "open the cart", commitSha: "abc1234", media: [], at: "2026-11-04T10:00:00Z" };
    const base = { ...input, stage: "evidence", task: { ...input.task, evidence }, context: { projectContext: null, video, testCases: video.scenarios, qaTargets: [video.target] } };
    const one = renderPrompt({ pack: PACKS.video_qa, input: { ...base, pack: "video_qa" } as never, template: "{{context.video.scenarios}}|{{context.video.steps}}|{{context.video.chapters}}|{{context.video.target}}|{{context.video.narration}}|{{context.video.timeline}}|{{context.video.report}}|{{context.video.transcript}}|{{context.video.sheets}}|{{context.video.fixCards}}|{{task.evidence}}" });
    expect(one).toContain("- A coupon counts once (criterion: c1): apply twice");
    expect(one).toContain('{"scenario":"a","step":"click"}');
    expect(one).toContain("- 4s: A coupon");
    expect(one).toContain("local: http://127.0.0.1:3000 (credential: env:QA_PASSWORD)");
    expect(one).toContain("- a: 12.5s");
    expect(one).toContain('"dur": 60');
    expect(one).toContain('"verdict": "pass"');
    expect(one).toContain("apply the coupon");
    expect(one).toContain("- /evidence/sheets/beats_sheet.jpg");
    expect(one).toContain("- P1 t=12.5 scene=cart el=cta: the headline is cut off");
    expect(one).toContain("Format: video");
    expect(one).toContain("A coupon counts once: pass");
    const bare = renderPrompt({ pack: PACKS.video_script, input: { ...input, pack: "video_script" } as never, template: "{{context.video.narration}}|{{context.video.timeline}}|{{context.video.fixCards}}|{{task.evidence}}" });
    expect(bare).toContain("(none)|(none)|(none)|(none)");
    for (const id of ["video_script", "recording", "video_qa", "video_fix"] as const) {
      const template = readFileSync(new URL(`../../prompts/${id}.md`, import.meta.url), "utf8");
      const prompt = renderPrompt({ pack: PACKS[id], input: { ...base, pack: id } as never, template });
      expect(prompt, id).not.toContain("{{");
    }
  });

  it("renders the coverage of the change per file with a total line, or says there is no report", () => {
    const template = "{{context.coverage}}";
    const render = (coverage?: unknown) => renderPrompt({ pack: PACKS.verifying, input: { ...input, pack: "verifying", stage: "verifying", context: { ...input.context, ...(coverage ? { coverage } : {}) } } as never, template });
    const out = render({ files: [{ path: "src/a.ts", added: 8, covered: 3, uncovered: [12, 14, 15, 16, 17] }, { path: "src/b.ts", added: 2, covered: 2, uncovered: [] }], total: { added: 10, covered: 5 }, report: "coverage/lcov.info" });
    expect(out).toContain("src/a.ts: 3/8 added lines covered (uncovered: 12, 14-17)");
    expect(out).toContain("src/b.ts: 2/2 added lines covered");
    expect(out).toContain("Total: 5/10 added lines covered (coverage/lcov.info)");
    expect(render()).toContain("(no coverage report)");
  });

  it("renders the code map the planner reads: components, files, owners and the note", () => {
    const template = "{{context.plan.map}}";
    const plan = { record: null, brief: "b", criteria: [], assumptions: [], slices: [] };
    const map = { components: ["board keys", "board app"], files: ["board/src/keys.rs"], owners: ["@marta", "@lee"], confidence: 0.7, note: "tests not placed" };
    const render = (p: unknown) => renderPrompt({ pack: PACKS.plan, input: { ...input, context: { ...input.context, plan: p } } as never, template });
    expect(render({ ...plan, map })).toContain("Components: board keys, board app\nFiles:\n- board/src/keys.rs\nOwners: @marta, @lee\nConfidence: 0.7\nNote: tests not placed");
    expect(render(plan)).toContain("(none)");
    expect(render({ ...plan, map: null })).toContain("(none)");
  });

  it("lists the repo's checks for the packs that run them, as the line to type and where", () => {
    const template = "checks:\n{{context.checks}}";
    const checks = [{ name: "board tests", run: "cargo test", cwd: "board", paths: ["board/**"] }, { name: "lint", run: "pnpm lint" }];
    const rich = { ...input, context: { ...input.context, checks } };
    expect(renderPrompt({ pack: PACKS.implementing, input: rich, template })).toContain("checks:\n- board tests: `cargo test` in board/ (for changes under board/**)\n- lint: `pnpm lint`");
    expect(renderPrompt({ pack: PACKS.implementing, input, template })).toContain("checks:\n(none declared; detect the suite from the tree)");
  });

  it("renders the PR's diff and comments for reviewing, and each thread with its id for addressing", () => {
    const pr = { repo: "o/a", number: 12, url: "https://github.com/o/a/pull/12", title: "Export CSV", body: "Adds it.", author: "them", baseRef: "main", headRef: "feat/export" };
    const review = { pr, diff: "diff --git a/a.ts b/a.ts\n+x", files: [{ path: "a.ts", additions: 1, deletions: 0 }], existingComments: [{ path: "a.ts", line: 3, author: "x", body: "old note" }] };
    const reviewed = renderPrompt({ pack: PACKS.reviewing, input: { ...input, pack: "reviewing", stage: "reviewing", context: { projectContext: null, review } }, template: "{{context.review}}" });
    expect(reviewed).toContain("PR #12 Export CSV by @them: feat/export into main (https://github.com/o/a/pull/12)");
    expect(reviewed).toContain("Adds it.");
    expect(reviewed).toContain("- a.ts (+1 -0)");
    expect(reviewed).toContain("- a.ts:3 @x: old note");
    expect(reviewed).toContain("```diff\ndiff --git a/a.ts b/a.ts\n+x\n```");
    const threads = { pr, threads: [{ id: "PRRT_1", path: "a.ts", line: 4, comments: [{ author: "them", body: "why?", at: "2026-10-27T10:00:00Z" }] }] };
    const addressed = renderPrompt({ pack: PACKS.addressing, input: { ...input, pack: "addressing", stage: "addressing", context: { projectContext: null, threads } }, template: "{{context.threads}}" });
    expect(addressed).toContain("### Thread PRRT_1 at a.ts:4");
    expect(addressed).toContain("- @them (2026-10-27T10:00:00Z): why?");
    expect(renderPrompt({ pack: PACKS.reviewing, input, template: "{{context.review}}|{{context.threads}}" })).toMatch(/\n\(none\)\|\(none\)$/);
  });

  it("renders the inbox batch for slack_triage: the person, the watches, the rules and one block per item", () => {
    const template = "me {{context.slack.me}}\nwatches:\n{{context.slack.watches}}\nrules:\n{{context.slack.rules}}\nitems:\n{{context.slack.items}}";
    const slack = {
      me: { id: "U1", name: "higor" },
      watches: [{ label: "@platform-team", kind: "usergroup" }],
      rules: "## Notes\n- short replies\n",
      items: [
        { id: "C1:1", channel: "#eng", author: "@marta", isBot: false, text: "can you review o/a#212?", context: [{ user: "@lee", text: "earlier" }], matched: ["me"], threadReplies: 2 },
        { id: "C2:9", channel: "dm with @ana", author: "@deploybot", isBot: true, text: "deploy done", context: [], matched: [], threadReplies: 0 },
      ],
    };
    const prompt = renderPrompt({ pack: PACKS.slack_triage, input: { ...input, pack: "slack_triage", stage: "slack_triage", context: { projectContext: null, slack } }, template });
    expect(prompt).toContain("me higor (U1)");
    expect(prompt).toContain("watches:\n- @platform-team (usergroup)");
    expect(prompt).toContain("rules:\n## Notes\n- short replies");
    expect(prompt).toContain("1. id C1:1 · #eng · @marta · matched me · 2 thread replies\n   earlier · @lee: earlier\n   text: can you review o/a#212?");
    expect(prompt).toContain("2. id C2:9 · dm with @ana · @deploybot (app) · matched (none)\n   text: deploy done");
    expect(prompt).toContain("`slack-triager` role running the `slack_triage` stage");
    expect(renderPrompt({ pack: PACKS.slack_triage, input, template })).toContain("me (none)\nwatches:\n(none)\nrules:\n(none)\nitems:\n(none)");
  });

  it("renders the chat batch for chat_triage: the source, the person, the rules and one block per item with its kind, flag and floor", () => {
    const template = "from {{context.chat.source}}\nme {{context.chat.me}}\nrules:\n{{context.chat.rules}}\nitems:\n{{context.chat.items}}";
    const chat = {
      source: "teams" as const,
      me: { id: "8f2c", name: "Higor Alves" },
      items: [
        { id: "chat:19:abc", place: "Rafa Souza", kind: "dm" as const, author: "Rafa Souza", isBot: false, text: "approve the rollout?", context: [{ author: "Rafa Souza", text: "staging is green" }], matched: ["dm"], flag: "urgent" as const, floor: "P0" as const },
        { id: "post:t:c:m", place: "Platform › incidents", kind: "channel" as const, author: "Azure DevOps", isBot: true, text: "build 4411 failed", replies: 1 },
      ],
    };
    const prompt = renderPrompt({ pack: PACKS.chat_triage, input: { ...input, pack: "chat_triage", stage: "chat_triage", context: { projectContext: null, chat } }, template });
    expect(prompt).toContain("from Microsoft Teams\nme Higor Alves (8f2c)\nrules:\n(none)");
    expect(prompt).toContain("1. id chat:19:abc · dm Rafa Souza · Rafa Souza · matched dm · flag urgent · floor P0\n   earlier · Rafa Souza: staging is green\n   text: approve the rollout?");
    expect(prompt).toContain("2. id post:t:c:m · channel Platform › incidents · Azure DevOps (app) · matched (none) · 1 reply\n   text: build 4411 failed");
    expect(prompt).toContain("`chat-triager` role running the `chat_triage` stage");
    expect(prompt).toContain("no escalation");
    const slack = renderPrompt({ pack: PACKS.chat_triage, input: { ...input, pack: "chat_triage", stage: "chat_triage", context: { projectContext: null, chat: { ...chat, source: "slack", rules: "## VIPs\n- @cto\n" } } }, template });
    expect(slack).toContain("from Slack\n");
    expect(slack).toContain("rules:\n## VIPs\n- @cto\nitems:");
    expect(renderPrompt({ pack: PACKS.chat_triage, input, template })).toContain("from (none)\nme (none)\nrules:\n(none)\nitems:\n(none)");
  });

  it("renders the issue for jira_intake: the facts line, the description, the comments and the repo", () => {
    const template = "issue:\n{{context.jira.issue}}\ndescription:\n{{context.jira.description}}\ncomments:\n{{context.jira.comments}}\nrepo: {{context.jira.repoPath}}";
    const jira = { key: "PLAT-123", url: "https://acme.atlassian.net/browse/PLAT-123", summary: "Login page", description: "Users sign in.\n\n- bad password errors", issueType: "Story", priority: "High", labels: ["luna"], dueAt: "2026-10-31", comments: ["Marta: please", "Lee: by Friday"], repoPath: "/work" };
    const prompt = renderPrompt({ pack: PACKS.jira_intake, input: { ...input, pack: "jira_intake", stage: "jira_intake", context: { projectContext: null, jira } }, template });
    expect(prompt).toContain("issue:\nLogin page\nPLAT-123 · Story · priority High · labels luna · due 2026-10-31\nhttps://acme.atlassian.net/browse/PLAT-123");
    expect(prompt).toContain("description:\nUsers sign in.\n\n- bad password errors");
    expect(prompt).toContain("comments:\n- Marta: please\n- Lee: by Friday");
    expect(prompt).toContain("repo: /work");
    expect(prompt).toContain("`jira-triager` role running the `jira_intake` stage");
    const bare = renderPrompt({ pack: PACKS.jira_intake, input: { ...input, pack: "jira_intake", stage: "jira_intake", context: { projectContext: null, jira: { ...jira, labels: [], dueAt: null, description: "", comments: [], repoPath: null } } }, template });
    expect(bare).toContain("PLAT-123 · Story · priority High\nhttps");
    expect(bare).toContain("description:\n(none)\ncomments:\n(none)\nrepo: (unknown: /work is empty)");
    expect(renderPrompt({ pack: PACKS.jira_intake, input, template })).toContain("issue:\n(none)\ndescription:\n(none)");
  });

  it("renders triage_signals's first read for jira_intake when intake had one, (none) when not", () => {
    const jira = { key: "PLAT-1", url: "u", summary: "s", description: "", issueType: null, priority: null, labels: [], dueAt: null, comments: [], repoPath: null };
    const classification = { kind: "bug", area: "board", ready: true, size: 1.2, confidence: 0.82, at: "2026-11-03T12:00:00.000Z", model: "typesafe-ai/jev" };
    const render = (j: object) => renderPrompt({ pack: PACKS.jira_intake, input: { ...input, pack: "jira_intake", stage: "jira_intake", context: { projectContext: null, jira: j as never } }, template: "hint: {{context.jira.classification}}" });
    expect(render({ ...jira, classification })).toContain("hint: bug · board · ready · size small · lowest confidence 0.82 (typesafe-ai/jev)");
    expect(render(jira)).toContain("hint: (none)");
  });

  it("renders the ticket's signals one per question, with the label a score rounds to and a flag under the bar", () => {
    const signals = {
      kind: { answer: "bug", confidence: 0.9 }, area: { answer: "board", confidence: 0.55 }, ready: { answer: true, confidence: 0.83 }, size: { answer: 1, confidence: 0.75 },
      urgency: { answer: 1.2, confidence: 0.7 }, risk: { answer: 0.8, confidence: 0.8 }, archive: { answer: false, confidence: 0.95 },
    };
    const classification = { kind: "bug", area: "board", ready: true, size: 1, confidence: 0.55, at: "2026-11-03T12:00:00.000Z", model: "m", signals };
    const render = (c: unknown) => renderPrompt({ pack: PACKS.triage, input: { ...input, pack: "triage", stage: "triage", task: { ...input.task, classification: c as never } }, template: "signals: {{task.classification}}" });
    expect(render(classification)).toContain("signals: kind bug (0.90) · area board (0.55, flagged) · ready yes (p 0.83) · size small (0.75) · urgency normal (0.70) · risk low (0.80) · archive no (p 0.05)");
    expect(render(null)).toContain("signals: (none)");
    expect(render({ ...classification, signals: undefined })).toContain("signals: (none)");
  });

  it("renders a v2 classification's signals: a size as its bucket, a sub-score as its rubric level, a flag under the pack's own bar", () => {
    const signals = {
      kind: { answer: "bug", confidence: 0.9 }, type_of_work: { answer: "backend", confidence: 0.8 }, size: { answer: "S", confidence: 0.5 },
      who: { answer: 2, confidence: 0.75 }, time: { answer: 0, confidence: 0.6 }, risk_prelim: { answer: "low", confidence: 0.9 },
    };
    const classification = { kind: "bug", ready: true, size: 1, confidence: 0.5, at: "2026-11-03T12:00:00.000Z", model: "m", signals };
    const text = renderPrompt({ pack: PACKS.triage, input: { ...input, pack: "triage", stage: "triage", task: { ...input.task, classification: classification as never } }, template: "signals: {{task.classification}}" });
    const asked = renderPrompt({ pack: PACKS.triage, input: { ...input, pack: "triage", stage: "triage", task: { ...input.task, classification: { ...classification, signals: { size: { answer: "S", confidence: 0.3 } } } as never } }, template: "signals: {{task.classification}}" });
    expect(asked).toContain("signals: size S (0.30, asked)");
    expect(text).toContain("signals: kind bug (0.90) · type_of_work backend (0.80) · size S (0.50, flagged) · who everyone (0.75) · time whenever (0.60, flagged) · risk_prelim low (0.90)");
  });

  it("renders the triage record for the planner: the goal, the four grades, the reason and the signals; (none) before triage ran", () => {
    const record = {
      source: "github", kind: "bug", goal: "Stop the board panicking on resize", size: "small", urgency: "high", risk: "low", reason: "one function, tests exist",
      signals: { kind: { answer: "bug", confidence: 0.9 }, area: { answer: "board", confidence: 0.55 } },
      qa: [], decision: "plan", at: "2026-11-04T00:00:00.000Z", model: "m",
    };
    const render = (r: unknown) => renderPrompt({ pack: PACKS.plan, input: { ...input, pack: "plan", stage: "test_design", task: { ...input.task, record: r as never } }, template: "{{task.record}}" });
    expect(render(record)).toContain("Goal: Stop the board panicking on resize\nKind/size/urgency/risk: bug / small / high / low\nReason: one function, tests exist\nSignals: kind bug (0.90) · area board (0.55, flagged)");
    expect(render(null)).toContain("(none)");
  });

  it("renders the plan stage's second round: the criteria no scenario names, the earlier scenarios and the plan check's findings, (none) otherwise", () => {
    const plan = { record: null, brief: "b", criteria: ["c1"], assumptions: [], slices: [], gaps: ["c1"], review: ["the rollback could not be followed"], cases: [{ title: "t", criterion: "c1", approach: "run it" }] };
    const template = "gaps:\n{{context.plan.gaps}}\nreview:\n{{context.plan.review}}\ncases:\n{{context.plan.cases}}";
    const render = (p: unknown) => renderPrompt({ pack: PACKS.plan, input: { ...input, pack: "plan", stage: "test_design", context: { projectContext: null, plan: p as never } }, template });
    expect(render(plan)).toContain("gaps:\n- c1\nreview:\n- the rollback could not be followed\ncases:\n- t (criterion: c1): run it");
    expect(render(undefined)).toContain("gaps:\n(none)\nreview:\n(none)\ncases:\n(none)");
  });

  it("renders the case for eval_judge: the pack, the rubric and the JSON as the runner wrote it", () => {
    const template = "{{context.eval.pack}} {{context.eval.case}}\nrubric: {{context.eval.rubric}}\ninput: {{context.eval.input}}\nchecks: {{context.eval.checks}}\nanswer: {{context.eval.answer}}";
    const judged = { pack: "slack_triage" as const, caseId: "incident", rubric: "  P0 for the outage\n", input: '{"a":1}', checks: "[]", answer: '{"items":[]}' };
    const prompt = renderPrompt({ pack: PACKS.eval_judge, input: { ...input, pack: "eval_judge", stage: "eval_judge", context: { projectContext: null, eval: judged } }, template });
    expect(prompt).toContain("`eval-judge` role running the `eval_judge` stage");
    expect(prompt).toContain('slack_triage incident\nrubric: P0 for the outage\ninput: {"a":1}\nchecks: []\nanswer: {"items":[]}');
    expect(renderPrompt({ pack: PACKS.eval_judge, input, template })).toContain("(none) (none)\nrubric: (none)");
  });

  it("names a script pack's agent as script", () => {
    expect(renderPrompt({ pack: PACKS.evidence, input: { ...input, pack: "evidence", stage: "evidence" }, template: "{{agent}}" })).toMatch(/\nscript$/);
  });

  it("states the rules a stage runs under, once, without promising an answer shape", () => {
    expect(FACTORY_RULES).toContain("Never call AskUserQuestion");
    expect(FACTORY_RULES).toContain("requested[]");
    expect(FACTORY_RULES).toContain("Never write outside /work and /out");
    expect(FACTORY_RULES).toContain("chained command");
    expect(FACTORY_RULES).not.toContain('kind "questions"');
    expect(FACTORY_RULES).not.toContain("Answer ONLY");
    expect(FACTORY_RULES).not.toMatch(/human|controller/);
  });

  it("names the runtime's own tools: the same rules, eve's names", () => {
    const eve = factoryRules(EVE_TOOL_NAMES);
    expect(eve).toContain("Never ask a question");
    expect(eve).toContain("read_file, glob and grep for files");
    expect(eve).toContain("Report progress with the step tool");
    // eve's bash runs one process: the rules must not promise a chain the tool refuses.
    expect(eve).toContain("bash is not a shell");
    expect(eve).not.toContain("chained command");
    expect(eve).not.toMatch(/AskUserQuestion|Read\/Glob\/Grep|mcp__luna__/);
    expect(eve.split("\n")).toHaveLength(FACTORY_RULES.split("\n").length);
  });
});

describe("callLine", () => {
  it("names the tool and its target, one line, cut to 160 columns", () => {
    expect(callLine("Read", { file_path: "/work/a.ts" })).toBe("→ Read /work/a.ts");
    // eve's file tools name the target filePath; a read of four files is four lines, not a loop.
    expect(callLine("read_file", { filePath: "/work/b.ts" })).toBe("→ read_file /work/b.ts");
    expect(callLine("write_file", { filePath: "/work/b.ts", content: "a" })).not.toBe(callLine("write_file", { filePath: "/work/b.ts", content: "b" }));
    expect(callLine("Bash", { command: "cargo test\n--verbose" })).toBe("→ Bash cargo test");
    expect(callLine("Grep", { pattern: "x".repeat(200) })).toHaveLength("→ Grep ".length + 160);
    expect(callLine("mcp__luna__step", { label: "slice 1" })).toBe("→ mcp__luna__step slice 1");
  });

  it("tells the pages of one file apart, so reading a long file in four pages is not one call four times", () => {
    expect(callLine("Read", { file_path: "/work/ui.rs", offset: 400, limit: 200 })).toBe("→ Read /work/ui.rs:400+200");
    expect(callLine("Read", { file_path: "/work/ui.rs", offset: 600, limit: 200 })).toBe("→ Read /work/ui.rs:600+200");
    expect(callLine("Read", { file_path: "/work/ui.rs", limit: 50 })).toBe("→ Read /work/ui.rs:0+50");
    // eve's read_file pages the same way, by filePath.
    expect(callLine("read_file", { filePath: "/work/ui.rs", offset: 400, limit: 200 })).toBe("→ read_file /work/ui.rs:400+200");
    expect(callLine("read_file", { filePath: "/work/ui.rs", offset: 600 })).toBe("→ read_file /work/ui.rs:600+");
  });

  it("names a search by its pattern and where it looks, so four different globs over /work are not one call four times", () => {
    expect(callLine("glob", { path: "/work", pattern: "**/*.ts" })).toBe("→ glob **/*.ts in /work");
    expect(callLine("glob", { path: "/work", pattern: "src/**" })).not.toBe(callLine("glob", { path: "/work", pattern: "test/**" }));
    expect(callLine("Grep", { pattern: "formatPrice", path: "/work/src" })).toBe("→ Grep formatPrice in /work/src");
    expect(callLine("Glob", { pattern: "**/*.rs" })).toBe("→ Glob **/*.rs");
  });

  it("fingerprints an edit by what it changes, so four different edits of one file are not one call four times", () => {
    const a = callLine("Edit", { file_path: "/work/a.rs", old_string: "x", new_string: "y" });
    const b = callLine("Edit", { file_path: "/work/a.rs", old_string: "y", new_string: "z" });
    expect(a).toMatch(/^→ Edit \/work\/a\.rs ·[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(callLine("Edit", { file_path: "/work/a.rs", old_string: "x", new_string: "y" })).toBe(a);
    expect(callLine("Write", { file_path: "/work/a.rs", content: "hello" })).toMatch(/^→ Write \/work\/a\.rs ·[0-9a-f]{8}$/);
  });
});
