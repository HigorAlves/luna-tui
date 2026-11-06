// The allow-list of a run, as data. Each kind of run has its own list; the machine hands it to a proxy it starts
// outside the container, so nothing here is enforced by anything the container can change. Pure.
import { type CredentialOwner, hostPatternProblem, normalizeHostPattern } from "@hardness/contracts";

/** GitHub's hosts, exactly: no wildcard, so a host GitHub does not name stays closed. */
export const GITHUB_HOSTS: readonly string[] = ["github.com", "api.github.com", "codeload.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];

/** The API hosts of each credential owner's engines (`@typesafe-ai/sdk` calls api.typesafe.ai by default; the AI Gateway is the other Jev path). A host a runtime needs and this lacks goes here, never into a repository's `allow`. */
export const ENGINE_HOSTS: Readonly<Record<CredentialOwner, readonly string[]>> = {
  claude: ["api.anthropic.com"],
  codex: ["chatgpt.com", "auth.openai.com", "api.openai.com"],
  openai: ["api.openai.com"],
  typesafe: ["ai-gateway.vercel.sh", "api.typesafe.ai"],
};

/** `install` is the machine's install of a lockfile, `check` a repository's check, the app, the seed and the deploy, `agent` a pack run on a repository, `pack` a pack run with no repository. */
export type EgressKind = "install" | "check" | "agent" | "pack";

export interface EgressInputs {
  /** `sandbox.egress.allow` of the user's checkout. */
  allow: readonly string[];
  /** `sandbox.egress.registries`: `install` closes the registries to agents and checks. */
  registries: "install" | "always";
  /** `registryHostsOf` the user's checkout's lockfiles. */
  registryHosts: readonly string[];
  /** The credential owners of the run's engine and of each helper. */
  owners?: readonly CredentialOwner[];
  /** The machine's own extra engine hosts (`MACHINE_EGRESS_ENGINE_HOSTS`). */
  engineHosts?: readonly string[];
  /** Hosts the repository's config names for a browser run. */
  targets?: readonly string[];
  /** The machine's own endpoints (its trace endpoint), reachable although they are private: exact `name:port`. */
  machineEntries?: readonly string[];
}

export interface EgressSpec {
  allow: string[];
  allowPrivate: string[];
}

/** `host` or `host:port` as `host:port`, 443 when no port is given; null for text that is not a host pattern. */
function entryOf(text: string): string | null {
  const value = normalizeHostPattern(text);
  if (hostPatternProblem(value) !== null) return null;
  return /:\d+$/.test(value) ? value : `${value}:443`;
}

const PRIVATE_ENTRY = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?:\d{1,5}$/;

/** The list a kind of run is given. An install and a check never get an engine host. */
export function egressFor(kind: EgressKind, inputs: EgressInputs): EgressSpec {
  const hosts: string[] = [];
  const add = (list: readonly string[]) => {
    for (const text of list) {
      const entry = entryOf(text);
      if (entry) hosts.push(entry);
    }
  };
  const engines = () => add([...(inputs.owners ?? []).flatMap((owner) => ENGINE_HOSTS[owner]), ...(inputs.engineHosts ?? [])]);
  if (kind === "pack") engines();
  else {
    add(GITHUB_HOSTS);
    add(inputs.allow);
    if (kind === "install" || inputs.registries === "always") add(inputs.registryHosts);
    if (kind === "agent") {
      engines();
      add(inputs.targets ?? []);
    }
  }
  const privateEntries = kind === "agent" || kind === "pack" ? (inputs.machineEntries ?? []).map(normalizeHostPattern).filter((e) => PRIVATE_ENTRY.test(e) && !e.startsWith("*")) : [];
  return { allow: [...new Set(hosts)].sort(), allowPrivate: [...new Set(privateEntries)].sort() };
}
