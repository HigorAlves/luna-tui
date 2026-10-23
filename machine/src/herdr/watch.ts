// Opens a herdr tab per task that follows its running stage container, so you can watch an
// agent like a local one. Without herdr, this does nothing.
import { exec } from "../sandbox/exec.ts";

interface WatchTab {
  tabId: string;
  paneId: string;
}

export class Watcher {
  /** The watch tab opened for each task, if any. */
  private readonly tabs = new Map<string, WatchTab>();
  private warned = false;

  constructor(private readonly herdrBin: string) {}

  /** Shows `container`'s output in the task's watch tab, opening the tab if needed. */
  async follow(taskId: string, label: string, cwd: string, container: string): Promise<void> {
    const tab = await this.tabFor(taskId, label, cwd);
    if (!tab) return;
    await exec(this.herdrBin, ["pane", "run", tab.paneId, `docker logs -f ${container}`]);
  }

  /** Closes the task's watch tab, once it is done. A no-op if none was opened. */
  async close(taskId: string): Promise<void> {
    const tab = this.tabs.get(taskId);
    if (!tab) return;
    this.tabs.delete(taskId);
    await exec(this.herdrBin, ["tab", "close", tab.tabId]);
  }

  private async tabFor(taskId: string, label: string, cwd: string): Promise<WatchTab | null> {
    const known = this.tabs.get(taskId);
    if (known && (await this.paneExists(known.paneId))) return known;

    const created = await exec(this.herdrBin, ["tab", "create", "--cwd", cwd, "--label", label]);
    const root = this.parse(created.stdout)?.result?.root_pane;
    const tab: WatchTab | null =
      typeof root?.pane_id === "string" && typeof root?.tab_id === "string"
        ? { paneId: root.pane_id, tabId: root.tab_id }
        : null;
    if (created.code !== 0 || !tab) {
      if (!this.warned) {
        console.warn(`herdr watch panes are off: ${(created.stderr || created.stdout).trim()}`);
        this.warned = true;
      }
      return null;
    }
    this.tabs.set(taskId, tab);
    return tab;
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
