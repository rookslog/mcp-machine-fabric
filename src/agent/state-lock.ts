import { open, readFile, realpath, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

// Atomic exclusive creation works on Linux and macOS without native modules.
// Never automatically unlink a dead owner's file: checking its PID and then
// unlinking would race another claimant (Node has no conditional unlink).
export class StateLock {
  private constructor(private file: string, private handle: FileHandle) {}

  static async acquire(stateDir: string): Promise<StateLock> {
    const file = path.join(await realpath(stateDir), "agent.lock");
    let handle: FileHandle;
    try {
      handle = await open(file, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
      let owner = "unreadable owner";
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); owner = `live pid ${pid}`; }
        catch (error) { owner = (error as NodeJS.ErrnoException).code === "ESRCH" ? `dead pid ${pid}; remove this stale lock only while all agents are stopped` : `pid ${pid} may still be live`; }
      }
      throw new Error(`state directory is locked: ${file} (${owner})`);
    }
    try {
      await handle.writeFile(`${process.pid}\n`);
      return new StateLock(file, handle);
    } catch (err) {
      await handle.close();
      await unlink(file);
      throw err;
    }
  }

  async release(): Promise<void> {
    // Called only after inbound work and all outstanding handlers have drained.
    await unlink(this.file);
    await this.handle.close();
  }
}
