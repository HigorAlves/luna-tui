// The built agent's trace destination, read when the server starts (like agent/model.ts): with a
// Laminar key in the server's environment, eve's OpenTelemetry pipeline gets Laminar's span
// processor, so every model turn and tool call of the agent lands in Laminar; without one the
// file is off and eve keeps its defaults. eve owns the tracer provider, so Laminar.initialize()
// is never called here (Laminar's eve integration says the same). The runner passes the key and
// address (run.ts, serverEnv). These spans are their own traces, not children of the machine's
// span for the run: eve starts them from its own context, and the run's `session` event carries
// the eve session id that ties them together.
import { disableInstrumentation } from "eve/instrumentation";
import { otelIntegration } from "eve/instrumentation/otel";

export async function laminarDestination(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.LMNR_PROJECT_API_KEY?.trim();
  if (!apiKey) return disableInstrumentation();
  const { LaminarSpanProcessor } = await import("@lmnr-ai/lmnr");
  const port = Number(env.LMNR_GRPC_PORT);
  return otelIntegration({ spanProcessors: [new LaminarSpanProcessor({ apiKey, baseUrl: env.LMNR_BASE_URL?.trim() || "http://localhost", port: Number.isInteger(port) && port > 0 ? port : 8001 })] });
}

export default await laminarDestination();
