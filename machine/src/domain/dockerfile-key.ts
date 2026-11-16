// What a person approves for a repository's `build.dockerfile`: the Dockerfile's bytes (UTF-8), the sorted build args and the
// repo-relative context, hashed together. The key is kept beside approved bases; the `=` can never be in an image reference.
import { createHash } from "node:crypto";

export const DOCKERFILE_PREFIX = "dockerfile=sha256:";

export const isDockerfileKey = (value: string): boolean => /^dockerfile=sha256:[0-9a-f]{64}$/.test(value);

export function dockerfileKey(input: { text: string; args: Record<string, string>; context: string }): string {
  const args = Object.entries(input.args).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // JSON keeps the three parts apart: text cannot be moved between them.
  const hex = createHash("sha256").update(JSON.stringify([Buffer.from(input.text, "utf8").toString("base64"), args, input.context])).digest("hex");
  return `${DOCKERFILE_PREFIX}${hex}`;
}
