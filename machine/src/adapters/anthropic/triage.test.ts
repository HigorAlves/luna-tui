import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it, vi } from "vitest";

import type { TriageItem } from "../../application/slack-triage.ts";
import { TRIAGE_MODEL, type TriageClient, createTriager } from "./triage.ts";

const item = (id: string): TriageItem => ({ id, channel: "#eng", author: "@marta", text: `msg ${id}`, context: [], matched: ["me"] });

const usage = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };

const verdict = (id: string) => ({ id, priority: "P1", category: "question", expectsReply: true, summary: "s".repeat(120), why: "w", draft: "d", refs: [], deadline: null });

describe("createTriager", () => {
  it("sends one structured, cached, low-effort Haiku call per batch of 25 and maps the answers", async () => {
    const parse = vi.fn(async (params: MessageCreateParamsNonStreaming) => {
      const ids = (JSON.parse(params.messages[0]!.content as string) as TriageItem[]).map((i) => i.id);
      return { parsed_output: { items: ids.slice(0, -1).map(verdict) }, usage };
    });
    const client: TriageClient = { messages: { parse: parse as unknown as TriageClient["messages"]["parse"] } };
    const lines: string[] = [];
    const triager = createTriager(client, { log: (l) => void lines.push(l) });
    const items = Array.from({ length: 30 }, (_, i) => item(`C1:${i}`));
    const watches = [{ id: "w", kind: "usergroup" as const, value: "S1", label: "@platform-team", channels: [], enabled: true, builtin: false, priority: "P1" as const, createdAt: "" }];
    const answers = await triager.triage(items, { notes: "Short replies.", learned: ["- @bot: lowered (2)"], watches });

    expect(parse).toHaveBeenCalledTimes(2);
    const first = parse.mock.calls[0]![0];
    expect(first.model).toBe(TRIAGE_MODEL);
    expect(first.output_config).toMatchObject({ effort: "low", format: { type: "json_schema" } });
    const system = first.system as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(system).toHaveLength(2);
    expect(system[0]!.text).toContain("P0  production incident");
    expect(system[1]!.text).toContain("@platform-team (usergroup, at least P1)");
    expect(system[1]!.text).toContain("Short replies.");
    expect(system[1]!.text).toContain("- @bot: lowered (2)");
    expect(system[1]!.cache_control).toEqual({ type: "ephemeral" });
    expect((JSON.parse(first.messages[0]!.content as string) as TriageItem[]).map((i) => i.id)).toEqual(items.slice(0, 25).map((i) => i.id));
    expect((JSON.parse(parse.mock.calls[1]![0].messages[0]!.content as string) as TriageItem[])).toHaveLength(5);

    // The model skipped the last item of each batch; the rest came through, summaries cut to 90.
    expect(answers.size).toBe(28);
    expect(answers.has("C1:24")).toBe(false);
    expect(answers.has("C1:29")).toBe(false);
    expect(answers.get("C1:0")).toEqual({ priority: "P1", category: "question", expectsReply: true, summary: "s".repeat(90), why: "w", draft: "d", refs: [], deadline: null });
    expect(lines[0]).toMatch(/25 item\(s\), 1200 in \(1000 cached, 0 written\), 80 out/);
  });

  it("ignores ids it did not ask about and an unparseable answer", async () => {
    const parse = vi.fn(async () => ({ parsed_output: { items: [verdict("other"), verdict("C1:1")] }, usage }));
    const client: TriageClient = { messages: { parse: parse as unknown as TriageClient["messages"]["parse"] } };
    const triager = createTriager(client, { log: () => {} });
    const answers = await triager.triage([item("C1:1")], { notes: "", learned: [], watches: [] });
    expect([...answers.keys()]).toEqual(["C1:1"]);
    const broken: TriageClient = { messages: { parse: (async () => ({ parsed_output: null, usage })) as unknown as TriageClient["messages"]["parse"] } };
    expect((await createTriager(broken, { log: () => {} }).triage([item("C1:1")], { notes: "", learned: [], watches: [] })).size).toBe(0);
  });
});
