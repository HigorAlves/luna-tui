// The tools a compiled stage agent is given (compile.ts re-exports them from agent/tools/): eve's
// own bash, read_file and write_file behind the core guards, and the luna tools, which run in the
// factory process (core/luna-tools.ts keeps the state finish() reads) and are reached over a
// loopback call to the runner. A tool here runs inside the eve server, never in the factory.
import type { LunaTool } from "@hardness/contracts";
import { defineTool } from "eve/tools";
import { bash as eveBash } from "eve/tools/bash";
import { readFile } from "eve/tools/read_file";
import { writeFile } from "eve/tools/write_file";
import { z } from "zod";

import { LUNA_TOOLS } from "../../../core/luna-tools.ts";
import { approve, fileInput } from "./guard.ts";

export const bash = defineTool({ ...eveBash, approval: ({ toolInput }) => approve("bash", toolInput) });
export const read_file = defineTool({ ...readFile, approval: ({ toolInput }) => approve("read", fileInput(toolInput)) });
export const write_file = defineTool({ ...writeFile, approval: ({ toolInput }) => approve("write", fileInput(toolInput)) });

/** A luna tool: the call goes to the runner's bridge (run.ts) with the run's bearer token. */
export function lunaTool(name: LunaTool) {
  return defineTool({
    description: LUNA_TOOLS[name].description,
    inputSchema: z.object(LUNA_TOOLS[name].input),
    async execute(input) {
      const response = await fetch(`${process.env.LUNA_EVE_BRIDGE_URL}/${name}`, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.LUNA_EVE_BRIDGE_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(`luna ${name}: the runner answered ${response.status}`);
      return (await response.json()) as unknown;
    },
  });
}
