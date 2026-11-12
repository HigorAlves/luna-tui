import { PACKS, helperPack, readOnly } from "@hardness/contracts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { agentFiles, appName, compileAgent, eveSubagents, eveTools, tokenBudgetPerTurn } from "./compile.ts";

const FACTORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** Triage hands its reply to a helper; these rows are about a pack that has none. */
const triage = { ...PACKS.triage, helpers: [] };
const options = (over = {}) => ({ factoryRoot: FACTORY_ROOT, outDir: join(FACTORY_ROOT, ".eve-agents"), ...over });

describe("eveTools for the ticket reply pack", () => {
  it("gives the pack that reads hostile ticket text no tools at all", () => {
    expect(eveTools(PACKS.ticket_reply.access)).toEqual([]);
  });
});

describe("eveTools", () => {
  it("maps a pack's access to eve's tool names: no bash without commands, no write_file without write", () => {
    expect(eveTools(PACKS.slack_triage.access)).toEqual([]);
    expect(eveTools(PACKS.jira_intake.access)).toEqual(["read_file", "glob", "grep"]);
    expect(eveTools(PACKS.triage.access)).toEqual(["bash", "read_file", "glob", "grep", "web_fetch", "step", "decision_get", "card_search"]);
    expect(eveTools(PACKS.implementing.access)).toEqual(["bash", "read_file", "glob", "grep", "write_file", "step", "slice_init", "slice_set", "slice_list", "decision_get", "scope_check"]);
  });
});

describe("eveSubagents", () => {
  it("is the helpers on an eve engine, which the stage's own `delegate` no longer serves", () => {
    expect(eveSubagents(PACKS.triage)).toEqual([{ role: "reply-drafter", engine: "codex:luna" }]);
    expect(eveSubagents(PACKS.verifying)).toEqual([]);
    expect(eveSubagents(PACKS.reviewing)).toEqual([]);
  });
});

describe("agentFiles", () => {
  const files = agentFiles(triage, options());

  it("writes an agent on the engine's model, the pack's effort, no default tools and a usage limit", () => {
    const agent = files["agent/agent.ts"]!;
    expect(agent).toContain('import { stageModel } from "../../../src/runtimes/eve/agent/model.ts"');
    expect(agent).toContain("model: stageModel()");
    expect(agent).toContain('reasoning: "high"');
    expect(agent).toContain("defaultTools: false");
    expect(agent).toMatch(/limits: \{ sessionUsage: /);
    // The budget follows the turns the run was given, as the runner's call cap and the dry run do.
    expect(agent).toContain("process.env.LUNA_EVE_MAX_TURNS");
    const budget = new Function(`return ${/sessionUsage: (.*) \},$/m.exec(agent)![1]}`)() as (u: { window: Record<string, number> }) => boolean;
    process.env.LUNA_EVE_MAX_TURNS = "2";
    expect(budget({ window: { inputTokens: 2 * tokenBudgetPerTurn.input - 1, cacheReadTokens: 0, outputTokens: 0 } })).toBe(false);
    expect(budget({ window: { inputTokens: 2 * tokenBudgetPerTurn.input, cacheReadTokens: 0, outputTokens: 0 } })).toBe(true);
    delete process.env.LUNA_EVE_MAX_TURNS;
    expect(JSON.parse(files["package.json"]!)).toMatchObject({ private: true, type: "module", dependencies: { eve: expect.any(String) } });
  });

  it("gives the role's body and the factory rules in eve's tool names as the instructions", () => {
    const instructions = files["agent/instructions.md"]!;
    expect(instructions).toContain(readFileSync(join(FACTORY_ROOT, "roles", "triage-planner", "role.md"), "utf8").split("---\n")[2]!.slice(0, 80));
    expect(instructions).toContain("read_file, glob and grep for files");
    expect(instructions).not.toMatch(/AskUserQuestion|mcp__luna__/);
  });

  it("gives one tool file per tool the access grants, the guarded ones from the runtime, and the channel and sandbox", () => {
    expect(Object.keys(files).filter((f) => f.startsWith("agent/tools/")).sort()).toEqual(
      ["bash", "card_search", "decision_get", "glob", "grep", "read_file", "step", "web_fetch"].map((t) => `agent/tools/${t}.ts`),
    );
    expect(files["agent/tools/bash.ts"]).toBe('export { bash as default } from "../../../../src/runtimes/eve/agent/tools.ts";\n');
    expect(files["agent/tools/step.ts"]).toContain('export default lunaTool("step");');
    expect(files["agent/tools/glob.ts"]).toBe('export { glob as default } from "../../../../src/runtimes/eve/agent/tools.ts";\n');
    expect(files["agent/tools/web_fetch.ts"]).toBe('export { web_fetch as default } from "../../../../src/runtimes/eve/agent/tools.ts";\n');
    expect(files["agent/channels/eve.ts"]).toContain("src/runtimes/eve/agent/channel.ts");
    expect(files["agent/sandbox.ts"]).toContain("src/runtimes/eve/sandbox.ts");
    expect(files["agent/instrumentation/laminar.ts"]).toBe('export { default } from "../../../../src/runtimes/eve/agent/laminar.ts";\n');
  });

  it("compiles web_fetch in only for a pack with the web", () => {
    expect(Object.keys(agentFiles(PACKS.jira_intake, options()))).not.toContain("agent/tools/web_fetch.ts");
  });

  it("gives a tool-less pack no tools", () => {
    expect(Object.keys(agentFiles(PACKS.slack_triage, options())).filter((f) => f.startsWith("agent/tools/"))).toEqual([]);
  });

  it("runs the conformance fake instead of the engine's model when asked", () => {
    expect(agentFiles(PACKS.implementing, options({ model: "scripted" }))["agent/agent.ts"]).toContain("model: scriptedModel()");
  });

  it("compiles a helper on an eve engine as a native subagent of the stage, with the parent's sandbox and its child run's read-only tools", () => {
    const files = agentFiles(PACKS.triage, options());
    const dir = "agent/subagents/reply-drafter";
    const agent = files[`${dir}/agent.ts`]!;
    expect(agent).toContain('description: "Drafts the reply to a person');
    expect(agent).toContain('model: engineModel("codex:luna")');
    expect(agent).toContain('import { engineModel } from "../../../../../src/runtimes/eve/agent/model.ts"');
    expect(agent).toContain('reasoning: "high"');
    expect(agent).toMatch(/defaultTools: false,\n {2}tool: false,/);
    expect(agent).not.toMatch(/gpt-|claude-/);
    expect(files[`${dir}/instructions.md`]).toContain(readFileSync(join(FACTORY_ROOT, "roles", "reply-drafter", "role.md"), "utf8").split("---\n")[2]!.slice(0, 60));
    expect(files[`${dir}/sandbox.ts`]).toBe('import { defineParentSandbox } from "eve/sandbox";\n\nexport default defineParentSandbox();\n');
    expect(Object.keys(files).filter((f) => f.startsWith(`${dir}/tools/`)).sort()).toEqual(["bash", "glob", "grep", "read_file", "web_fetch"].map((t) => `${dir}/tools/${t}.ts`));
    // The guarded tools approve against the child run's read-only policy, not the stage's: its own commands, nothing to write.
    const commands = JSON.stringify(readOnly(PACKS.triage.access).commands);
    expect(files[`${dir}/tools/read_file.ts`]).toBe(`import { readOnlyTools } from "../../../../../../src/runtimes/eve/agent/tools.ts";\n\nexport default readOnlyTools(${commands}).read_file;\n`);
    expect(files[`${dir}/tools/bash.ts`]).toContain(`readOnlyTools(${commands}).bash`);
    expect(agentFiles(PACKS.triage, options({ model: "scripted" }))[`${dir}/agent.ts`]).toContain('model: scriptedModel("reply-drafter")');
  });

  it("gives a pack with helpers a delegate workflow tool: a native subagent through ctx.agent, the other helpers over the bridge", () => {
    const tool = agentFiles(PACKS.triage, options())["agent/tools/delegate.ts"]!;
    expect(tool).toContain('import { defineWorkflowTool } from "eve/tools";');
    expect(tool).toContain('from "../../../../src/runtimes/eve/agent/delegate.ts";');
    expect(tool).toMatch(/async function helperStart\(input: DelegateInput\) \{\n {2}"use step";/);
    expect(tool).toMatch(/async function viaBridge\(input: DelegateInput\) \{\n {2}"use step";/);
    expect(tool).toContain('const SUBAGENTS: string[] = ["reply-drafter"];');
    expect(tool).toContain('inputSchema: delegateInput(["reply-drafter"])');
    expect(tool).toMatch(/- reply-drafter \(codex:luna\): Drafts the reply/);
    expect(tool).toContain('"use workflow";');
    expect(tool).toContain("ctx.agent(input.helper).send(start.prompt, { outputSchema: HELPER_ANSWER, signal: ctx.abortSignal })");
    // The answer schema is a literal: the workflow bundle cannot import the contracts.
    expect(tool).not.toContain("@hardness/contracts");
    expect(JSON.parse(/const HELPER_ANSWER = (.*);/.exec(tool)![1]!)).toMatchObject({ type: "object", required: ["answer"] });
    // verifying on eve has no native helper: its second opinion is Claude's, over the bridge.
    const verifying = agentFiles(PACKS.verifying, options());
    expect(verifying["agent/tools/delegate.ts"]).toContain("const SUBAGENTS: string[] = [];");
    expect(verifying["agent/tools/delegate.ts"]).toContain('delegateInput(["second-opinion"])');
    expect(Object.keys(verifying).filter((f) => f.startsWith("agent/subagents/"))).toEqual([]);
    expect(agentFiles(triage, options())["agent/tools/delegate.ts"]).toBeUndefined();
  });

  it("hands the conformance fake's executor to bash, and only bash, when asked", () => {
    const files = agentFiles(PACKS.implementing, options({ model: "scripted" }));
    expect(files["agent/tools/bash.ts"]).toBe(
      'import { bashTool } from "../../../../src/runtimes/eve/agent/tools.ts";\nimport { scriptedExec } from "../../../../src/runtimes/eve/fake.ts";\n\nexport default bashTool(scriptedExec);\n',
    );
    expect(files["agent/tools/glob.ts"]).toBe('export { glob as default } from "../../../../src/runtimes/eve/agent/tools.ts";\n');
  });

  it("runs a helper that a stage on another runtime reaches as an app of its own, with no tool and no subagent", () => {
    const helper = { role: "security-reviewer", engine: "codex:sol" } as const;
    const pack = { ...triage, helpers: [helper] };
    const child = helperPack(pack, helper);
    expect(appName(pack)).toBe("triage");
    expect(appName(child)).toBe("triage--security-reviewer");
    const files = agentFiles(child, options());
    expect(Object.keys(files).filter((f) => f.startsWith("agent/tools/")).sort()).toEqual(["bash", "glob", "grep", "read_file", "web_fetch"].map((t) => `agent/tools/${t}.ts`));
    expect(files["agent/agent.ts"]).toContain("role security-reviewer as a helper");
    expect(JSON.parse(files["package.json"]!).name).toBe("luna-triage--security-reviewer");
  });

  it("appends the role's eve addendum when it has one", () => {
    const root = mkdtempSync(join(tmpdir(), "eve-compile-"));
    mkdirSync(join(root, "roles", "slack-triager"), { recursive: true });
    writeFileSync(join(root, "roles", "slack-triager", "role.md"), '---\ndescription: "x"\n---\nShared body.\n');
    writeFileSync(join(root, "roles", "slack-triager", "eve.md"), "Answer through the reply tool.\n");
    const instructions = agentFiles(PACKS.slack_triage, { factoryRoot: root, outDir: join(root, ".eve-agents") })["agent/instructions.md"]!;
    expect(instructions.startsWith("Shared body.\n")).toBe(true);
    expect(instructions.trimEnd().endsWith("Answer through the reply tool.")).toBe(true);
  });
});

describe("compileAgent", () => {
  it("writes the agent under <outDir>/<pack> with the pack's skills, and only when its access has skills", () => {
    // Inside the factory, as the real ones are, so the agent resolves eve from its node_modules.
    const outDir = mkdtempSync(join(FACTORY_ROOT, ".eve-agents-test-"));
    try {
      const app = compileAgent(triage, options({ outDir }));
      expect(app).toBe(join(outDir, "triage"));
      expect(existsSync(join(app, "agent", "agent.ts"))).toBe(true);
      expect(existsSync(join(app, "agent", "skills", "code-discovery", "SKILL.md"))).toBe(true);
      expect(existsSync(join(compileAgent(PACKS.slack_triage, options({ outDir })), "agent", "skills"))).toBe(false);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
