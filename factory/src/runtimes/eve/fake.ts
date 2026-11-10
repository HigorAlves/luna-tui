// The conformance table's fake model for eve: eve's own mockModel, playing the script the runner
// names in LUNA_EVE_SCRIPT. It runs inside the eve server, so eve's real loop (tool approvals,
// the reply tool and its schema check, retries) runs around it. Each step after the first follows
// one tool result; a rejected reply (an answer off the schema) gets the same step again, the way
// a model that does not learn would.
import { APICallError } from "ai";
import { mockModel } from "eve/evals";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ScriptStep } from "../conformance/table.ts";
import type { Executor } from "./agent/tools.ts";
import { runArgv } from "./exec.ts";

/** The marker the economy's wrappers put before a redirect (agent/economy.ts). */
const MARK = "--- process check ---\n";

/** A shell step as the call the model makes. eve's bash runs only the pack's commands, so a shell edit
 *  (`sed -i <expr> <file>`) is played as a write of that file: the file tools are observed the same way. */
function shellCall(command: string): { name: string; input: unknown } {
  const edit = /^sed -i\s+\S+\s+(\S+)$/.exec(command);
  return edit ? { name: "write_file", input: { filePath: join(process.env.LUNA_EVE_WORKSPACE ?? "/work", edit[1] as string), content: "edited\n" } } : { name: "bash", input: { command } };
}

const scriptOf = (): ScriptStep[] => JSON.parse(readFileSync(process.env.LUNA_EVE_SCRIPT ?? "", "utf8")) as ScriptStep[];

/** The executor compile.ts hands the scripted agent's `bash`: a failing shell step's output comes from the
 *  script, not from a process, and any other command runs for real. The command is the one the script
 *  names, so the guard and the observer see it. */
export const scriptedExec: Executor = (argv, options) => {
  const step = scriptOf().find((s) => "call" in s && s.call === "bash" && s.fails !== undefined && s.command === argv.join(" "));
  return step && "fails" in step ? Promise.resolve({ exitCode: 1, stdout: "", stderr: step.fails as string, truncated: false }) : runArgv(argv, options);
};

export function scriptedModel() {
  const told = new Set<string>();
  return mockModel({
    modelId: "scripted",
    provider: "conformance",
    respond: async ({ toolResults }) => {
      const script = scriptOf();
      const results = toolResults.filter((r) => r.name !== "eve__reply");
      // What the model is told besides the prompt: a redirect rides on the last tool result, in its
      // stdout, content or text. One line (a JSON string) per redirect, in LUNA_EVE_TOLD.
      const latest = results.at(-1);
      const shown = typeof latest?.output === "object" && latest.output !== null ? ((latest.output as { stdout?: unknown; content?: unknown }).stdout ?? (latest.output as { content?: unknown }).content) : latest?.output;
      if (latest !== undefined && typeof shown === "string" && shown.includes(MARK) && process.env.LUNA_EVE_TOLD && !told.has(latest.id)) {
        told.add(latest.id);
        appendFileSync(process.env.LUNA_EVE_TOLD, `${JSON.stringify(shown.slice(shown.indexOf(MARK) + MARK.length))}\n`);
      }
      const step = script[Math.min(results.length, script.length - 1)]!;
      if ("call" in step) {
        const call = step.call === "bash" ? shellCall(step.command) : step.call === "delegate" ? { name: "delegate", input: { helper: step.helper, message: step.message } } : { name: step.tool, input: step.args };
        return { ...(step.say && { text: step.say }), toolCalls: [call] };
      }
      // A model that never answers within any stage's time; the server is stopped long before.
      if ("hang" in step) await new Promise((resolve) => setTimeout(resolve, 600_000));
      if ("hang" in step) return { text: "" };
      if ("rateLimit" in step) throw new Error("Rate limit reached for requests (429): try again later");
      // A provider's 400: eve does not retry it and ends the session.
      if ("fail" in step) throw new APICallError({ message: step.fail, url: "http://model", requestBodyValues: {}, statusCode: 400, isRetryable: false });
      const last = results.at(-1)?.output;
      const answer = step.echo ? { ...step.answer, summary: typeof last === "string" ? last : JSON.stringify(last) } : step.answer;
      return step.as === "text" ? { text: JSON.stringify(answer) } : { toolCalls: [{ name: "eve__reply", input: answer }] };
    },
  });
}
