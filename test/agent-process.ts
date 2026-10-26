import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { AgentOptions } from "../src/agent/agent.js";

/** Real crash witness: load this checkout's TS in an isolated child, without a build. */
export async function startAgentProcess(options: AgentOptions): Promise<ChildProcess> {
  const agentUrl = new URL("../src/agent/agent.ts", import.meta.url).href;
  const script = `
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.includes("/src/")) {
        return next(specifier.slice(0, -3) + ".ts", context);
      }
      return next(specifier, context);
    }});
    const { Agent } = await import(${JSON.stringify(agentUrl)});
    const agent = new Agent(JSON.parse(process.argv[1]));
    await agent.start();
    await agent.waitConnected();
    process.send({ type: "connected" });
  `;
  const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", script, JSON.stringify(options)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr!.on("data", (data) => { stderr += data.toString(); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("child agent startup timed out: " + stderr)); }, 10_000);
    child.once("message", () => { clearTimeout(timer); resolve(); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`child agent exited ${code}: ${stderr}`)); });
    child.once("error", (err) => { clearTimeout(timer); reject(err); });
  });
  return child;
}

export async function killAgentProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
