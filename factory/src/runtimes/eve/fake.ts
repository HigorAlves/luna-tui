// The conformance table's fake model for eve: eve's own mockModel, playing the script the runner
// names in LUNA_EVE_SCRIPT. It runs inside the eve server, so eve's real loop (tool approvals,
// the reply tool and its schema check, retries) runs around it. Each step after the first follows
// one tool result; a rejected reply (an answer off the schema) gets the same step again, the way
// a model that does not learn would.
import { APICallError } from "ai";
import { mockModel } from "eve/evals";
import { readFileSync } from "node:fs";

import type { ScriptStep } from "../conformance/table.ts";

export function scriptedModel() {
  return mockModel({
    modelId: "scripted",
    provider: "conformance",
    respond: async ({ toolResults }) => {
      const script = JSON.parse(readFileSync(process.env.LUNA_EVE_SCRIPT ?? "", "utf8")) as ScriptStep[];
      const results = toolResults.filter((r) => r.name !== "eve__reply");
      const step = script[Math.min(results.length, script.length - 1)]!;
      if ("call" in step) {
        if (step.call === "bash" && step.fails !== undefined) throw new Error("a failing shell step is not supported on eve yet");
        const call = step.call === "bash" ? { name: "bash", input: { command: step.command } } : step.call === "delegate" ? { name: "delegate", input: { helper: step.helper, message: step.message } } : { name: step.tool, input: step.args };
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
