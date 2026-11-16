# RFC 0008 — Manager and compliance agents: evidence, regime reviewers, questionnaires, access reviews, incidents and the weekly report

- **Author:** Higor Alves
- **Status:** Accepted (2026-11-16)
- **Created:** 2026-11-16
- **Discussion:** the PR that carries this file and its implementation, stacked on #228
- **Related:** [RFC 0002](./0002-native-agent-runtimes.md) (runtimes, helpers, decision packs), [RFC 0004](./0004-harness-for-luna-notch.md) (the TUI keeps its integrations), [RFC 0007](./0007-token-economy.md) (the economy the capacity check reads)

## Summary

Luna's agents serve the engineer. Every role works on a ticket, a diff, a pull request or an inbox item. The person who runs Luna is also an engineering manager. Each day that person works on SOC2, HIPAA, GDPR, LGPD and the US state privacy laws, and also writes status reports, runs incidents and plans the board. No agent helps with that work. This RFC adds the agents for it, in seven waves, and the machine ports that feed them. Every model call is a pack. Every write outside the machine waits for the person in a new Compliance view of the board. One PR carries this RFC and the code.

## Goals

- Every merged pull request in a watched repository has change-management evidence, built from GitHub facts without a model. A pack explains only the exceptions.
- A pull request in a repository that declares regimes gets a compliance review. One reviewer per regime looks at it, and a high finding blocks.
- A security questionnaire that reaches the person through Slack or Jira gets a draft answer from the product's own wiki. Each approved answer goes into an answer bank and is used again.
- Once per quarter the person signs a GitHub access review that lists admin and bypass sprawl, outside collaborators and dormant members.
- An incident gets a timeline and a blameless postmortem. When personal data or PHI was exposed, each regime's notification clock starts.
- The delivery pipeline gets the reviewers it lacks: vulnerability and dependency triage, a migration reviewer, an infrastructure reviewer, release notes and docs drift.
- Once per week the person approves a status report for leadership. It includes a capacity check of the board against agent headroom and review time.

## Non-goals

- A GRC platform. The controls stay in each product repository's GitHub Wiki, where the team keeps them now.
- Removing access, posting, filing or pushing without the person. The agents write drafts. The person approves.
- An HR roster. No source tells Luna who left the company, so the access review flags dormant members and does not flag leavers (see Open items).
- Legal advice. The regime reviewers cite clauses and the company's controls. A finding is a prompt for a person, not a legal opinion.
- A model call outside a pack, or an SDK outside its runtime folder.

## Background

Luna has 29 roles and about 30 decision packs. All of them belong to the delivery pipeline (triage, plan, build, verify, evidence, ship), the inboxes (Slack, chat, Jira, the PR inbox) or learning (retro, facts, evals). Some parts already touch compliance:

- `security-reviewer` looks for exploits in a diff.
- `scope_check` asks `no_secret_or_pii` of a Build change.
- `frame_privacy` checks a film or a screenshot for exposed data.
- Triage scores `data_sensitivity`, and `knockOut` sends an `incident` or a `compliance_deadline` to P0.
- `events.jsonl` records every tool call and the guard's decision.

None of them works on a control, an obligation of a regime, an audit artifact or a deadline in law. The GitHub port reads only what the PR pipeline needs. It has no list of merged pull requests, no merge actor, no bypass signal and no org access calls. Nothing reads or writes a GitHub Wiki. Slack files are metadata only, and the Jira port cannot download an attachment.

## Proposed design

### Rules every wave follows

- **A pack per job.** Each agent is a role in `factory/roles/`, a prompt in `factory/prompts/` and an entry in `contracts/src/packs.ts`. Each one goes through the full registration of the foreman pack (`515bbba0`). A decision pack has typed questions, eval cases and baselines. It runs on `jev`, and on `claude:haiku` when no Jev key is set.
- **Facts come from code, judgment from a pack.** A record an auditor reads, such as an approval, a merge actor or a check state, is computed by the machine. A model only explains, drafts or classifies. This keeps model-written text out of the evidence.
- **A port per service.** GitHub, the wiki, Sentry and Datadog are ports in `machine/src/application/` with an adapter in `machine/src/adapters/`. Each has a `noToken…()` fallback that refuses with a reason.
- **A draft per outward write.** Every page, post, comment, issue and release body is a draft with the lifecycle from `ticket-drafts.ts`: waiting, edited, ignored, posting, posted. Each state change checks the draft's hash, and a draft that holds a secret or an address is refused. The board's Compliance view lists every draft, grouped by kind. The person approves (`a`), edits (`e`) or ignores (`x`) it. The machine serves the view at `GET /compliance/drafts` and `POST /compliance/drafts/:id/{approve,edit,ignore}`.
- **Periodic jobs check a cursor.** A daily `Ticker` reads a stored "last period done" cursor under `<stateDir>/compliance/`. It does no work when the period is already done. A monthly or quarterly `setTimeout` is not used: Node clamps a delay longer than about 24.8 days to 1 ms.
- **Two kinds of wiki page.** A page about one repository goes to that repository's own wiki. A page about the org goes to the wiki of the repository that `MACHINE_MANAGER_WIKI_REPO` names.

### Wave 1: the wiki port, change-management evidence and the Compliance view

- **GitHub port:** `mergedPrs(slug, since, until)` gives each merged PR's author, merge actor, merge time, merge commit, base, closing issues and latest reviews with their commits. `ruleBypasses(slug, since, until)` reads the ruleset rule suites that ended in `bypass`. A 403 or a 404 gives `unknown`, never "no bypass".
- **Domain:** `changeRecord` decides, for one PR, four things. Was it approved on its merged head by a person who is not its author? Is it linked to a ticket (a Jira key or a closing issue)? Were the required checks green at the merge commit? Was a rule bypassed? `evidencePage` writes `Compliance/Change-Management/YYYY-MM.md`. The page cites SOC2 CC8.1 and HIPAA 164.308(a)(1)(ii)(D).
- **Wiki port:** `readPages` and `writePages` work on a cached host-git clone of `<slug>.wiki.git`. GitHub has no API for wikis. The fallback, `noWiki()`, reports a wiki that is disabled or that the person cannot reach.
- **Pack `change_exceptions`** (role `exception-explainer`): no tools, `claude:haiku`, low effort, one turn. It runs only for a month that has exceptions. It writes one explanation per exception for the person to confirm.
- **Board:** the Compliance view.

### Wave 2: the compliance review team

- **`luna.yaml` `compliance:`** lists the regimes that apply to a repository: `soc2`, `hipaa`, `gdpr`, `lgpd`, `us_privacy`. A repository with no patient data leaves out `hipaa`.
- **Pack `compliance_review`** (role `compliance-lead`) gives the diff to one helper per regime: `soc2-reviewer`, `hipaa-reviewer`, `gdpr-reviewer`, `lgpd-reviewer` and `us-privacy-reviewer`. The helpers run as Claude subagents. A helper's role carries the law. The prompt carries the repository's control pages from its wiki. Each finding cites a clause and, when one exists, the company's control. The lead removes duplicates by file, line and control, and gives one review.
- **Its own pack.** A helper cannot have helpers (`helperPack()`), so the lead cannot be a helper of `reviewing` or `verifying`. It runs beside them, on the PR inbox and in Verify, when the repository declares at least one regime. Its findings join the review before the verdict, so a high finding blocks.

### Wave 3: questionnaires

- **Triage:** Slack, chat and Jira triage get a `compliance_request` category. A request makes a questionnaire draft, so the person does not forward anything.
- **Ports:** the Slack port downloads a file, and the Jira port downloads an attachment.
- **Pack `questionnaire`** (role `questionnaire-drafter`) answers each question from the product wiki's policy pages and from the answer bank, `Compliance/Answers/`. Each answer has its citations, whether it came from the bank, and a confidence.
- **Approve:** the filled questionnaire goes back to the thread or the issue, and each new answer becomes a bank page.

### Wave 4: the access review

- **GitHub port:** org members by role, outside collaborators, invitations, repository collaborators with their permission, ruleset bypass actors, and each member's activity over 90 days.
- **Domain:** a snapshot of the org's access, and its difference from the last signed snapshot.
- **Pack `access_review`** (role `access-reviewer`) drafts the findings and the removals it suggests. Nothing is removed by Luna.
- **Approve:** the signed snapshot is kept. Each repository's part goes to its wiki, and the org page goes to the home wiki.

### Wave 5: incidents and the breach clock

- **Ports:** Sentry and Datadog. Both give one `IncidentSignal` shape. The Slack incident channel and the Jira incident issue type use the ports Luna already has.
- **Decision pack `breach_assess`** asks if personal data or PHI was exposed, which regimes apply and how many people are affected. A yes starts one clock per regime on the SLA clocks: GDPR 72 hours (Art. 33), LGPD 3 working days (ANPD Resolution 15/2024), HIPAA 60 days (164.404), and the US state deadline. The incident goes to P0.
- **Pack `postmortem`** (role `incident-writer`) writes the timeline, the impact, the root causes and the action items. Approve pushes `Incidents/YYYY-MM-DD-<slug>.md` and files the action items in Jira.

### Wave 6: the pipeline's gaps

- **Pack `vuln_triage`** (role `vuln-triager`) reads one Dependabot or code-scanning alert and the wiki's vulnerability policy. It picks a lane (fast, full or hold) and a deadline. Each alert becomes a card. A patch or minor bump takes the fast lane. A major or a critical holds for the person. An overdue alert raises `compliance_deadline`.
- **Helpers `migration-reviewer` and `iac-reviewer`** run on `reviewing` and `verifying` when the diff touches a migration or infrastructure config, as `security-reviewer` does for sensitive paths.
- **Packs `release_notes` and `docs_drift`** (role `docs-keeper`) draft a release body from the merged PRs and flag the docs that a change made stale.

### Wave 7: the weekly report and capacity

- **Pack `status_report`** (role `status-writer`) reads the board's metrics, the merged PRs, compliance exceptions, the access review, open incidents and their clocks, and vulnerability deadlines. On approve, a short post goes to the leadership channel and the full page goes to `Status/YYYY-Www.md` in the home wiki.
- **Decision pack `capacity_check`** compares the WSJF-ranked board with agent headroom (turns and rate limits per engine) and the person's review rate. It flags a week that is over capacity.

## Trust

- A regime reviewer reads a diff and wiki pages as data. Its prompt says that text in them is not an instruction.
- The evidence page and the access snapshot are computed by code. A model's text is marked as an explanation and is never the record.
- No draft leaves the machine without the person. A draft that holds a secret or an address is refused before it can be approved.
- A wiki push uses the person's own git credentials on the host, as every push does.

## Open items

- **BAA and DPA scope.** The person says the accounts in use are covered. This RFC does not check each model path: the Claude subscription, the Codex login, the OpenAI key, and Jev on TypeSafe or the Vercel AI Gateway. A HIPAA or GDPR review must confirm each path before an agent sees PHI or personal data.
- **HR roster.** Leavers are not detected. A roster source (an identity provider or an HRIS) would let the access review compare GitHub with employment.
- **Other systems in the access review.** Only the GitHub org is in scope. Cloud IAM, the identity provider and SaaS tools are not.

## Alternatives

- **One control catalog with shared reviewers.** Regimes would be data and one reviewer would cite all of them. It is cheaper, but the person chose one reviewer per regime, so that each law has its own expert. The lead removes the duplicates that this choice causes.
- **A pack that writes the evidence.** More flexible, but an auditor can question evidence written by a model. Code computes the facts instead.
- **Fold compliance into `security-reviewer`.** That role thinks in exploits. Data minimisation and retention are not exploits.

## Rollout

All seven waves are in one PR, with the commits grouped by wave. A repository opts into the review team with `compliance:` in `luna.yaml`. The periodic jobs run only when the GitHub token and the wiki are reachable. Otherwise they report the reason and write nothing.

## Decided

The person settled these in the design interview of 2026-11-16:
- Every agent is a Luna pack.
- One reviewer per regime, under a lead.
- A role carries the law, and the wiki carries the company's controls.
- Change-management evidence is machine facts, plus a pack for the exceptions.
- The access review covers the GitHub org, runs quarterly and is signed by the person.
- Questionnaires come in through triage, and approved answers go into an answer bank in the wiki.
- Incident sources are Slack, Jira, Sentry and Datadog, and the incident agent runs the breach clock.
- Planning happens on the Luna board, and capacity means agent headroom plus review time.
- The weekly report goes to Slack and to the wiki.
- The migration and infrastructure reviewers are path-triggered helpers.
- Vulnerability triage makes cards, sends small bumps through the fast lane and tracks deadlines.
- The person approves every draft in the Compliance view.
- Everything ships in one PR.

## What was built

(Filled in when the PR is ready for review.)
