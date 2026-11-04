// Laminar inside the stage container: the machine, when its own traces are on, hands the run
// LMNR_PROJECT_API_KEY, LMNR_BASE_URL, the ports and LMNR_SPAN_CONTEXT (its span for this run,
// serialized); here the SDK is initialized from them, which makes that span the parent of every
// span this process makes, and each runtime plugs Laminar's own integration in: the Claude Agent
// SDK's query() wrapped (every turn, tool call and subagent), the AI SDK's telemetry registered
// before a decide() call. The eve runtime's agents carry their own destination
// (runtimes/eve/agent/laminar.ts). Without a key nothing here loads: the SDK is imported on
// demand, and this file and that one are the factory's only importers of it.
export interface FactoryTelemetry {
  /** True when spans leave this process. */
  on: boolean;
  /** The Claude Agent SDK's `query()` traced, or itself when off. */
  wrapQuery<T>(query: T): T;
  /** Registers Laminar's AI SDK integration through `register` (the AI SDK's own `registerTelemetry`,
   *  imported by the runtime that owns `ai`), once per process; nothing when off. */
  aiSdk(register: (integration: unknown) => void | Promise<void>): Promise<void>;
  /** Sends what is buffered; before the process exits. Never rejects. */
  flush(): Promise<void>;
}

/** The slice of `@lmnr-ai/lmnr` this file uses; the real module is cast to it, tests pass a fake. */
export interface FactoryLaminarSdk {
  Laminar: {
    initialize(props: { projectApiKey: string; baseUrl: string; httpPort: number; grpcPort: number; instrumentModules: Record<string, never> }): void;
    wrapClaudeAgentQuery<T>(query: T): T;
    flush(): Promise<void>;
  };
  LaminarAiSdkTelemetry: new (options?: Record<string, unknown>) => unknown;
}

export const NO_TELEMETRY: FactoryTelemetry = { on: false, wrapQuery: (query) => query, aiSdk: () => Promise.resolve(), flush: () => Promise.resolve() };

const loadSdk = async (): Promise<FactoryLaminarSdk> => (await import("@lmnr-ai/lmnr")) as unknown as FactoryLaminarSdk;

const port = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return raw && Number.isInteger(value) && value > 0 ? value : fallback;
};

export async function factoryTelemetry(
  env: NodeJS.ProcessEnv = process.env,
  deps: { load?: () => Promise<FactoryLaminarSdk>; warn?: (line: string) => void } = {},
): Promise<FactoryTelemetry> {
  const key = env.LMNR_PROJECT_API_KEY?.trim();
  if (!key) return NO_TELEMETRY;
  const warn = deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  let sdk: FactoryLaminarSdk;
  try {
    // The SDK runs dotenv on the current directory when it loads, and this process runs in the
    // task's worktree: a `.env` committed there (ANTHROPIC_BASE_URL, OPENAI_BASE_URL, anything)
    // must not become this run's environment. Whatever the import added is removed.
    const before = new Set(Object.keys(process.env));
    try {
      sdk = await (deps.load ?? loadSdk)();
    } finally {
      for (const name of Object.keys(process.env)) if (!before.has(name)) delete process.env[name];
    }
    // initialize() also reads LMNR_SPAN_CONTEXT: the machine's span becomes this run's parent.
    sdk.Laminar.initialize({ projectApiKey: key, baseUrl: env.LMNR_BASE_URL?.trim() || "http://localhost", httpPort: port(env.LMNR_HTTP_PORT, 8000), grpcPort: port(env.LMNR_GRPC_PORT, 8001), instrumentModules: {} });
  } catch (error) {
    warn(`laminar: traces off for this run: ${error instanceof Error ? error.message : String(error)}`);
    return NO_TELEMETRY;
  }
  let aiSdkRegistered = false;
  return {
    on: true,
    wrapQuery: (query) => sdk.Laminar.wrapClaudeAgentQuery(query),
    aiSdk: async (register) => {
      if (aiSdkRegistered) return;
      aiSdkRegistered = true;
      try {
        await register(new sdk.LaminarAiSdkTelemetry());
      } catch (error) {
        warn(`laminar: the AI SDK integration did not register: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    flush: async () => {
      try {
        await sdk.Laminar.flush();
      } catch (error) {
        warn(`laminar: flush failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
