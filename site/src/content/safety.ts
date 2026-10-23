export const safety = [
  { title: "Sealed containers", body: "Read-only rootfs, tmpfs /tmp, no-new-privileges. The worktree is read-only unless the stage writes." },
  { title: "Tools per stage", body: "Each pack carries an allowlist. Triage cannot write; the reviewer cannot run your suite; nobody opens a PR from inside." },
  { title: "Locked tests", body: "Change or delete a pre-existing test and the commit is undone, the stage fails, and the next attempt is told why." },
  { title: "Outward actions ask", body: "Tracker writes, review posts, publishing: never performed inside. They come back as requests on the board." },
]
