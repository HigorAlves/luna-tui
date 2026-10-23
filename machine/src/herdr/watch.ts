// Opens a herdr tab per task that follows its running stage container, so you can watch an
// agent like a local one. Without herdr, this does nothing.
import { exec } from "../sandbox/exec.ts";

export class Watcher {
  /** Pane id of each task's watch tab. */
  private readonly panes = new Map<string, string>();
  private warned = false;

  constructor(private readonly herdrBin: string) {}

  /** Shows `container`'s output in the task's watch tab, opening the tab if needed. */
  async follow(taskId: string, label: string, cwd: string, container: string): Promise<void> {
    const pane = await this.paneFor(taskId, label, cwd);
    if (!pane) return;
    await exec(this.herdrBin, ["pane", "run", pane, `docker logs -f ${container}`]);
  }

  private async paneFor(taskId: string, label: string, cwd: string): Promise<string | null> {
    const known = this.panes.get(taskId);
    if (known && (await this.paneExists(known))) return known;

    const created = await exec(this.herdrBin, ["tab", "create", "--cwd", cwd, "--label", label]);
    const pane = this.parse(created.stdout)?.result?.root_pane?.pane_id;
    if (created.code !== 0 || typeof pane !== "string") {
      if (!this.warned) {
        console.warn(`herdr watch panes are off: ${(created.stderr || created.stdout).trim()}`);
        this.warned = true;
      }
      return null;
    }
    this.panes.set(taskId, pane);
    return pane;
  }

  private async paneExists(pane: string): Promise<boolean> {
    const listed = await exec(this.herdrBin, ["pane", "list"]);
    const panes: Array<{ pane_id?: string }> = this.parse(listed.stdout)?.result?.panes ?? [];
    return panes.some((p) => p.pane_id === pane);
  }

  /** herdr's JSON replies are only read here, so they stay loosely typed. */
  private parse(text: string): any {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}
