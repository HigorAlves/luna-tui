// Every word on the landing page. Sections read from here; components hold no copy.
import facts from "./facts.json"
import { installCommands } from "./install"

export const REPO = "https://github.com/HigorAlves/luna-tui"
export const DOCS = `${REPO}/blob/main/docs`
export const INSTALL_DOC = `${DOCS}/install.md`
export const LUNA = "https://luna-sigma-nine.vercel.app/"
export const ORC = "https://orc.higoralves.dev"
export const HERDR = "https://herdr.dev"

export const nav = [
  { label: "How it works", href: "#how" },
  { label: "GitHub", href: "#github" },
  { label: "Board", href: "#board" },
  { label: "Example", href: "#example" },
  { label: "Features", href: "#features" },
  { label: "orc", href: "#orc" },
  { label: "Your setup", href: "#moments" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
]

export const cta = { primary: "Install Luna TUI", secondary: "See it run", github: "GitHub" }

export const hero = {
  eyebrow: "A software factory for one person",
  title: "Turn your tickets into the PR you'd have shipped.",
  lead: "A board in your terminal that runs orc. Agents work in sealed containers; you approve three times.",
  checks: ["Runs 100% local", "You approve three times"],
  equation: [
    { name: "Ticket", tag: "issue" },
    { name: "Repo", tag: "worktree" },
    { name: "orc", tag: "packs" },
  ],
  result: { name: "PR", tag: "ready", commit: "a1f3c9e" },
  figureLabel: "A ticket plus your repo plus orc equals a pull request",
}

export const how = {
  eyebrow: "How it works",
  title: "From ticket to PR in three approvals.",
  steps: [
    {
      title: "Approve the plan",
      body: "Triage reads the repo and writes a brief, criteria and slices. Send it back with a reason, or answer its questions.",
    },
    {
      title: "Approve the tests",
      body: "Failing tests exist before any code, then they're locked. The implementer can add tests, never change these.",
    },
    {
      title: "Approve the ship",
      body: "Green CI on a draft PR, the evidence verdict and the retro's proposed rules. Then it's yours to merge.",
    },
  ],
  meter: "Checks",
  paper: {
    title: "#39 TOTALS IGNORE QUANTITY",
    sub: "DRAFT PR · hardness/39-totals",
    slices: "SLICES",
    checks: "CHECKS",
    commits: ["4e1d2a9", "a1f3c9e", "7d02b4f", "3b7f8d2", "c58e61a"],
    pills: ["test", "lint", "types", "e2e", "ci", "evidence"],
    footer: "CI",
  },
}

export const repos = {
  eyebrow: "One machine, every repo",
  title: "Same machine. A new PR for every repo.",
  lead: "One board, one queue, up to four tasks at once. The repo decides the checks, the tests and the PR.",
  heatmap: { title: "1,204 stage runs in the last year", label: "Same machine", less: "Less", more: "More" },
  rows: [
    {
      kind: "web",
      repo: "acme/storefront",
      ticket: "#43 Login error copy",
      pr: "fix(auth): clear login error copy",
      tags: ["Next.js", "Playwright", "e2e"],
      number: "#128",
    },
    {
      kind: "api",
      repo: "acme/billing-api",
      ticket: "#39 Totals ignore quantity",
      pr: "fix(cart): totals respect quantity",
      tags: ["Go", "PostgreSQL", "unit"],
      number: "#211",
    },
    {
      kind: "cli",
      repo: "acme/sync-cli",
      ticket: "#46 Retry on 429 in sync job",
      pr: "feat(sync): retry on 429 with backoff",
      tags: ["Node", "Vitest", "CLI"],
      number: "#57",
    },
  ],
  footnote: "Fictional repos and tickets.",
}

export const github = {
  eyebrow: "Your GitHub",
  title: "Issues in. Pull requests out.",
  lead: "Label an issue ready-for-agent and it lands on the board. When the work is done, it comes back as a PR that closes it.",
  features: [
    {
      title: "Issues become tickets",
      body: "The machine polls the repos you list. A labelled issue becomes a backlog ticket, its checklist becomes the criteria.",
    },
    {
      title: "A draft PR, early",
      body: "Deliver pushes the task branch and opens a draft PR as soon as the build is green, so CI starts while you look.",
    },
    {
      title: "CI watched, not hoped",
      body: "A red run goes to the ci_watch pack: fixable loops back to Build, a flake re-runs once, infra escalates to you.",
    },
    {
      title: "Closes #N",
      body: "The PR body follows orc's caveman-pr shape: what changed, why, the criteria, and the issue it closes.",
    },
  ],
}

export const board = {
  eyebrow: "Your board",
  title: "The board says where. orc says what.",
  lead: "Columns follow task state, so a ticket is always where its work is. Open as many boards as you like; they all see one machine.",
  cards: [
    { title: "#43 Login error copy", stage: "Triage", detail: "needs you · plan", runs: 4 },
    { title: "#39 Totals ignore quantity", stage: "Build", detail: "implementing · slice 2/3", runs: 11 },
    { title: "#37 Rate-limit backoff", stage: "Verify", detail: "verifying · suite", runs: 8 },
  ],
  features: [
    {
      title: "Columns follow state",
      body: "Nine columns from Backlog to Done, driven by the machine. No dragging a card to pretend work moved.",
    },
    {
      title: "One key per gate",
      body: "a does the obvious next step, r sends back with a reason, X aborts, f opens the stage's watch pane.",
    },
    {
      title: "Watch any stage",
      body: "Each running stage gets a herdr tab that follows its container. Look over the agent's shoulder whenever you want.",
    },
    {
      title: "Offline is a state",
      body: "Stop the machine and the board turns red with the reason, keeps running, and reconnects on its own.",
    },
  ],
}

export const example = {
  eyebrow: "Example",
  title: "Every PR has evidence.",
  lead: "Hover or tap a line of the PR to see the runs behind it.",
  pr: {
    heading: "Summary",
    title: "fix(cart): totals respect item quantity",
    meta: "acme/billing-api · #211",
    status: "Draft → Ready",
    intro: "Cart totals summed each line's unit price once, ignoring quantity. Closes #39.",
    footer: "Checks:",
    footerValue: "test, lint, typecheck, e2e, CI",
  },
  bullets: [
    {
      text: "Wrote three failing tests for quantity × price, discounts and empty carts before any code changed.",
      stage: "Test design",
      attempt: "attempt 1",
      commits: [{ hash: "4e1d2a9", date: "Mar 3, 2026", message: "test(cart): lock quantity, discount and empty-cart totals" }],
    },
    {
      text: "Multiplied each line total by its quantity; the three locked tests now pass.",
      stage: "Implementing",
      attempt: "slice 1/2",
      commits: [
        { hash: "a1f3c9e", date: "Mar 3, 2026", message: "fix(cart): multiply line total by quantity" },
        { hash: "2c3d4e5", date: "Mar 3, 2026", message: "refactor(cart): one lineTotal helper for cart and invoice" },
      ],
    },
    {
      text: "Rounded to cents once, at the end, so 3 × $0.10 is $0.30 and not $0.29.",
      stage: "Implementing",
      attempt: "slice 2/2",
      commits: [{ hash: "7d02b4f", date: "Mar 3, 2026", message: "fix(cart): round to cents once, after summing" }],
    },
    {
      text: "Verified: suite 142/142, lint and typecheck; e2e drove checkout in a browser and saved the video.",
      stage: "Verifying",
      attempt: "attempt 1",
      commits: [{ hash: "3b7f8d2", date: "Mar 3, 2026", message: "test(e2e): checkout totals with three of one item" }],
    },
  ],
  evidence: { label: "Evidence", commits: (n: number) => `${n} commit${n === 1 ? "" : "s"}`, run: "Stage run", ok: "Every commit is on the task branch." },
  acceptance: {
    score: 100,
    title: "Acceptance",
    sub: "Ship gate: #39",
    met: "Met",
    metItems: ["Quantity counts", "Discounts apply per line", "Empty cart is $0.00", "No float drift"],
    out: "Out of scope",
    outItems: ["Currency format", "Tax"],
  },
  footnote: "Fictional repo, ticket and PR.",
}

export const features = {
  eyebrow: "Details",
  title: "Built for you and the agent.",
  cards: [
    {
      title: "Sealed containers",
      body: "Read-only root filesystem, a tmpfs /tmp, no-new-privileges. The worktree is read-only unless the stage writes.",
      footer: { kind: "check", text: "read-only · tmpfs /tmp · no-new-privileges" },
    },
    {
      title: "Tools per stage",
      body: "Each pack carries its own allowlist. Triage can't write; the reviewer can't run your suite; nobody opens a PR from inside.",
      footer: { kind: "pills", items: ["triage: read", "build: edit", "review: read"], active: 1, tail: "least privilege" },
    },
    {
      title: "Locked tests",
      body: "Change or delete a test that existed when the stage started and the commit is undone, the stage fails, and the next attempt is told why.",
      footer: { kind: "commit", hash: "b72d0aa", text: "test(cart): lock quantity, discount and empty-cart totals" },
    },
    {
      title: "Outward actions ask",
      body: "Tracker writes, review posts, publishing: never done from inside a container. They come back to the board as requests.",
      footer: { kind: "list", items: [{ ok: true, text: "Push task branch" }, { ok: true, text: "Open draft PR" }, { ok: false, text: "Post a review comment: asks you" }] },
    },
    {
      title: "One machine, many repos",
      body: "Up to four tasks drive a stage at once across every repo. The rest queue in Postgres and survive a restart.",
      footer: { kind: "pills", items: ["web", "api", "cli"], active: -1, tail: "4 slots" },
    },
    {
      title: "Graded end to end",
      body: "pnpm golden drives a seeded bug through every gate. The nightly matrix grades suite, stages, evidence, cost and diff size.",
      footer: { kind: "stamp", text: "golden --matrix", badge: "≥ 80% to pass" },
    },
  ],
} as const

export const orc = {
  eyebrow: "orc · inside every stage",
  title: "orc does the work. Luna runs the floor.",
  lead: "Each agent stage is an orc stage pack with its own prompt, tool allowlist and limits, pinned into the runner image. Luna moves the ticket; orc writes the code.",
  features: [
    {
      title: "Packs, not prompts",
      body: "Triage, test design, build, verify, e2e, CI watch, evidence and the retro each run a pack with a typed result.",
    },
    {
      title: "Pinned, so it's repeatable",
      body: "The runner image bakes one orc commit in and is tagged with its sha. Same pack, same image, same behaviour.",
    },
    {
      title: "The orc you already use",
      body: "Factory mode is the same engine as orc in your terminal, minus the questions: outward actions are queued for you.",
    },
  ],
  terminal: {
    title: "~/acme/billing-api · luna",
    lines: [
      { kind: "prompt", text: "pnpm dev" },
      { kind: "head", text: "machine · 127.0.0.1:4317 · 2/4 slots" },
      { kind: "sub", text: "#39 implementing · orc-stage run implementing (attempt 1)" },
      { kind: "sub", text: "slice 1/2 committed a1f3c9e · locked tests 3/3 green" },
      { kind: "ok", text: "verifying · suite 142/142 · lint · typecheck · review pack" },
    ],
  },
  mascot: { button: "Zug zug", replies: ["Zug zug.", "Slice committed.", "Tests stay locked.", "Back to work."] },
  setup: {
    title: `Set it up in ${installCommands.length} commands`,
    lead: "Clone, start Postgres, build the stage image, link the board, start the machine. No account, no server.",
    tabs: [
      { id: "agents", label: "Board + agents", commands: installCommands },
      {
        id: "stubs",
        label: "Board only",
        commands: ["pnpm install && pnpm db:up", "pnpm board:build && herdr plugin link ./board", "MACHINE_AGENTS=off pnpm dev"],
      },
      {
        id: "qa",
        label: "With QA",
        commands: [...installCommands.slice(0, 3), "pnpm --filter @hardness/machine runner-qa:build", ...installCommands.slice(3)],
      },
    ],
    copy: "Copy",
    copied: "Copied",
  },
  packsTitle: "What it runs",
  packs: [
    { name: "triage", body: "Reads the ticket and the repo; writes the brief, criteria and slices, or asks." },
    { name: "test_design", body: "Writes the failing tests first. They're locked once you approve." },
    { name: "implementing", body: "Builds the change slice by slice, one commit each, on the task branch." },
    { name: "verifying", body: "Reviews the diff after your suite, lint and typecheck pass on the host." },
    { name: "e2e", body: "Drives the app in a browser for repos with a web surface; saves screenshots and video." },
    { name: "ci_watch", body: "Reads a red CI run and decides: fixable, flake, infra or needs-debug." },
    { name: "evidence", body: "Checks the QA manifest and puts the verdict and artifacts on the ship gate." },
    { name: "reviewing_memory", body: "After shipping, proposes rules for the repo's agent context. You keep or skip them." },
  ],
  note: "Needs Docker, Node 24+, pnpm, Rust and a Claude credential in ~/.config/hardness. Without a credential, every stage is a stub.",
  guide: "Full setup guide",
}

export const moments = {
  eyebrow: "For how you work",
  title: "However you ship, your next PR starts with what's already in the repo.",
  lead: "Solo, side project, open source or a pile of small bugs: Luna turns the backlog into reviewed, tested PRs.",
  cards: [
    { title: "Solo dev", quote: "I have a backlog and one pair of hands." },
    { title: "Side project", quote: "I get an hour a night, and half of it is setup." },
    { title: "Open source", quote: "Good first issues pile up faster than I can review them." },
    { title: "Bug bash", quote: "Fifty small bugs, none of them worth an afternoon." },
    { title: "Legacy repo", quote: "Nobody wants to touch it, so nothing gets fixed." },
  ],
  link: "See how it works",
  start: {
    title: "Not sure where to start?",
    body: "Run the golden task: one seeded bug through every gate, in about thirty seconds, on stubs or real agents.",
    link: "Run pnpm golden",
  },
}

export const pricing = {
  eyebrow: "Pricing",
  title: "Free. Pay only for the Claude you already use.",
  lead: "Luna TUI is open source and runs on your machine. The agents use your own Claude subscription or API key.",
  plans: [
    {
      name: "Board only",
      price: "$0",
      suffix: "",
      body: "The whole pipeline, every gate, on stub stages.",
      items: ["Every state and gate", "No credential needed", "No stage images"],
      cta: "Run with stubs",
      href: INSTALL_DOC,
    },
    {
      name: "Board + agents",
      price: "$0",
      suffix: "+ your Claude",
      body: "Real orc packs in sealed containers.",
      items: ["Triage, tests, build and verify", "Draft PRs and CI watch", "Your Claude plan or API key", "Cost tracked per stage"],
      cta: "Install",
      href: INSTALL_DOC,
      recommended: "Recommended",
    },
    {
      name: "Agents + QA",
      price: "$0",
      suffix: "+ 2 GB",
      body: "Browser QA for repos with a web surface.",
      items: ["Playwright with Chromium", "Screenshots and video evidence", "One extra runner image"],
      cta: "Build the QA image",
      href: `${DOCS}/configuration.md#runner-image`,
    },
  ],
  footnote: "Agent cost is whatever your Claude plan charges; the machine reports it per stage at /metrics.",
}

export const faq = {
  eyebrow: "FAQ",
  title: "Common questions",
  lead: "What people usually ask before pointing it at a repo.",
  items: [
    {
      q: "What runs on my computer?",
      a: "A TypeScript machine with an HTTP API, Postgres in Docker, one throwaway container per stage, and the board in herdr. Nothing is hosted.",
    },
    {
      q: "Can the agent see my whole disk?",
      a: "No. A stage container sees the task's worktree, its own /in and /out, a tmpfs /tmp and the repo's git dir read-only. The root filesystem is read-only.",
    },
    {
      q: "Which Claude do I need?",
      a: "A Claude subscription token or an Anthropic API key, saved in ~/.config/hardness. Without one, every stage is a stub, which is enough to try the board.",
    },
    {
      q: "Can it push to main?",
      a: "No. Work happens on a task branch and ships as a PR you review. Anything outward beyond push and the draft PR comes back to you as a request.",
    },
    {
      q: "What if a stage keeps failing?",
      a: "Retries are capped per loop. After three strikes the ticket escalates to you with the reason; your guidance resets the budget.",
    },
    {
      q: "Can it work on several repos at once?",
      a: "Yes. One machine serves every repo; MACHINE_MAX_CONCURRENT (default 4) caps tasks in flight across all of them, and the rest queue.",
    },
    {
      q: "What happens at a usage limit?",
      a: "The task pauses instead of failing and resumes 30 seconds after the window resets. Its worktree is reset first, so nothing half-done carries over.",
    },
    {
      q: "Do I need herdr?",
      a: "For the board, yes: it's a herdr plugin. The machine and its HTTP API run on their own, and pnpm golden drives them without a board.",
    },
    {
      q: "How much does it cost?",
      a: "Nothing. It's open source. The agents bill to your own Claude plan, and /metrics shows cost per stage.",
    },
  ],
}

export const finalCta = {
  title: "Your next ticket deserves a PR with proof.",
  lead: "Install the board and watch the golden task ship in minutes.",
}

export const footer = {
  tagline: "ticket + repo + orc = PR.",
  columns: [
    {
      title: "Project",
      links: [
        { label: "GitHub", href: REPO },
        { label: "Issues", href: `${REPO}/issues` },
        { label: "Contributing", href: `${DOCS}/contributing.md` },
      ],
    },
    {
      title: "Docs",
      links: [
        { label: "Install", href: INSTALL_DOC },
        { label: "Architecture", href: `${DOCS}/architecture.md` },
        { label: "Configuration", href: `${DOCS}/configuration.md` },
        { label: "API", href: `${DOCS}/api.md` },
      ],
    },
    {
      title: "Family",
      links: [
        { label: "Luna for the notch", href: LUNA },
        { label: "orc", href: ORC },
        { label: "herdr", href: HERDR },
      ],
    },
  ],
  facts: `facts from the repo · ${facts.states} states · ${facts.columns} columns · ${facts.packs} packs · ${facts.images} images`,
  rights: "Open source on GitHub.",
}
