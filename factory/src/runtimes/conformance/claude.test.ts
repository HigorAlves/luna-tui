// The Claude runtime against the conformance table, on a scripted query() in place of the SDK's.
import { claudeRuntime } from "../claude/run.ts";
import { scriptedQuery } from "../claude/fake.ts";
import { conformance } from "./table.ts";

conformance("claude", "claude:sonnet", (script) => claudeRuntime(scriptedQuery(script)), { resetsAt: true, schemaIssue: true, tools: true, text: true });
