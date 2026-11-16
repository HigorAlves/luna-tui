import { describe, expect, it, vi } from "vitest";

import { GitHubError } from "../../application/github.ts";
import { OctokitGitHub, type OctokitLike } from "./octokit.ts";

const denied = (status: number, message = "denied") => Object.assign(new Error(message), { status });

/** An Octokit whose paginate and request answer by route (and params), recording each call. */
function routes(answers: Record<string, (params: Record<string, unknown>) => unknown>, graphql?: (query: string, variables: Record<string, unknown>) => unknown) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const answer = (route: string, params: Record<string, unknown>) => {
    calls.push([route, params]);
    const fn = answers[route];
    if (!fn) throw new Error(`unexpected ${route}`);
    return fn(params);
  };
  const octokit = {
    paginate: vi.fn(async (route: string, params: Record<string, unknown>) => answer(route, params)),
    request: vi.fn(async (route: string, params: Record<string, unknown>) => ({ data: answer(route, params) })),
    graphql: vi.fn(async (query: string, variables: Record<string, unknown>) => graphql!(query, variables)),
  } as unknown as OctokitLike;
  return { github: new OctokitGitHub(octokit), calls };
}

describe("the access review reads", () => {
  it("reads the org's owners and members as two role listings", async () => {
    const { github, calls } = routes({ "GET /orgs/{org}/members": ({ role }) => (role === "admin" ? [{ login: "ann" }] : [{ login: "bob" }, { login: "cy" }]) });
    expect(await github.orgMembers("o")).toEqual([
      { login: "ann", role: "admin" },
      { login: "bob", role: "member" },
      { login: "cy", role: "member" },
    ]);
    expect(calls.map((c) => c[1])).toEqual([expect.objectContaining({ org: "o", role: "admin", per_page: 100 }), expect.objectContaining({ org: "o", role: "member", per_page: 100 })]);
  });

  it("lists outside collaborators and invitations", async () => {
    const { github } = routes({
      "GET /orgs/{org}/outside_collaborators": () => [{ login: "ext" }],
      "GET /orgs/{org}/invitations": () => [
        { login: "new", email: null, role: "direct_member", created_at: "2026-01-01T00:00:00Z", inviter: { login: "ann" } },
        { login: null, email: "x@y.z", role: "admin", created_at: "2026-01-02T00:00:00Z", inviter: null },
      ],
    });
    expect(await github.outsideCollaborators("o")).toEqual([{ login: "ext" }]);
    expect(await github.orgInvitations("o")).toEqual([
      { login: "new", email: null, role: "direct_member", createdAt: "2026-01-01T00:00:00Z", inviter: "ann" },
      { login: null, email: "x@y.z", role: "admin", createdAt: "2026-01-02T00:00:00Z", inviter: null },
    ]);
  });

  it("marks a collaborator direct when the direct listing has them, with the permission GitHub names", async () => {
    const row = (login: string, role_name: string) => ({ login, role_name, permissions: { admin: role_name === "admin", push: true, pull: true } });
    const { github, calls } = routes({
      "GET /repos/{owner}/{repo}/collaborators": ({ affiliation }) =>
        affiliation === "direct"
          ? [row("ann", "admin")]
          : [row("ann", "admin"), row("bob", "write"), { login: "cy", role_name: "custom-role", permissions: { admin: false, maintain: false, push: true, triage: true, pull: true } }],
    });
    expect(await github.repoCollaborators("o/a")).toEqual([
      { login: "ann", permission: "admin", direct: true },
      { login: "bob", permission: "write", direct: false },
      { login: "cy", permission: "write", direct: false },
    ]);
    expect(calls.map((c) => c[1].affiliation)).toEqual(["all", "direct"]);
  });

  it("lists each ruleset's bypass actors, and says unknown for 403 and 404", async () => {
    const answers = {
      "GET /repos/{owner}/{repo}/rulesets": () => [{ id: 1, name: "main" }, { id: 2, name: "tags" }],
      "GET /repos/{owner}/{repo}/rulesets/{ruleset_id}": ({ ruleset_id }: Record<string, unknown>) => ({
        id: ruleset_id,
        name: ruleset_id === 1 ? "main" : "tags",
        bypass_actors: ruleset_id === 1 ? [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }] : [],
      }),
    };
    const { github } = routes(answers);
    expect(await github.rulesetBypassActors("o/a")).toEqual([{ ruleset: "main", actorType: "RepositoryRole", actorId: 5, actorName: null, mode: "always" }]);
    for (const status of [403, 404]) {
      const failing = routes({
        ...answers,
        "GET /repos/{owner}/{repo}/rulesets": () => {
          throw denied(status);
        },
      });
      expect(await failing.github.rulesetBypassActors("o/a")).toBe("unknown");
    }
    const broken = routes({
      ...answers,
      "GET /repos/{owner}/{repo}/rulesets": () => {
        throw denied(500);
      },
    });
    await expect(broken.github.rulesetBypassActors("o/a")).rejects.toBeInstanceOf(GitHubError);
  });

  it("reads whether branch protection covers admins", async () => {
    const route = "GET /repos/{owner}/{repo}/branches/{branch}/protection";
    const failing = (status: number, message: string) =>
      routes({
        [route]: () => {
          throw denied(status, message);
        },
      }).github;
    expect(await routes({ [route]: () => ({ enforce_admins: { enabled: true } }) }).github.adminsEnforced("o/a", "main")).toBe(true);
    expect(await routes({ [route]: () => ({ enforce_admins: { enabled: false } }) }).github.adminsEnforced("o/a", "main")).toBe(false);
    expect(await failing(404, "Branch not protected").adminsEnforced("o/a", "main")).toBe(false);
    expect(await failing(403, "denied").adminsEnforced("o/a", "main")).toBe("unknown");
    expect(await failing(404, "Not Found").adminsEnforced("o/a", "main")).toBe("unknown");
  });

  it("asks GitHub for contributions in batches, one alias per login", async () => {
    const logins = Array.from({ length: 25 }, (_, i) => `u${i}`);
    const queries: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const { github } = routes({}, (query, variables) => {
      queries.push({ query, variables });
      if (query.includes("organization(")) return { organization: { id: "ORG1" } };
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(variables)) {
        if (k.startsWith("l")) data[`a${k.slice(1)}`] = v === "u3" ? null : { contributionsCollection: { hasAnyContributions: v !== "u1" } };
      }
      return data;
    });
    const seen = await github.memberActivity("o", logins, "2026-08-01T00:00:00Z");
    expect(seen.size).toBe(25);
    expect(seen.get("u0")).toBe(true);
    expect(seen.get("u1")).toBe(false);
    expect(seen.get("u3")).toBe(false);
    expect(seen.get("u24")).toBe(true);
    expect(queries.length).toBe(4); // the org id, then 10 + 10 + 5 logins
    expect(queries[1]!.variables).toMatchObject({ org: "ORG1", since: "2026-08-01T00:00:00Z" });
  });

  it("wraps a failed read in a GitHubError", async () => {
    const { github } = routes({
      "GET /orgs/{org}/members": () => {
        throw denied(401, "bad creds");
      },
    });
    await expect(github.orgMembers("o")).rejects.toThrow(/bad creds/);
  });
});
