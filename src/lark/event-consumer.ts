import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { MessageEvent } from "../types.js";
import { LarkCli } from "./cli.js";

export class EventConsumer {
  private child?: ChildProcessWithoutNullStreams;
  private stopping = false;
  private accepting = false;
  private readonly active = new Set<Promise<void>>();

  constructor(private readonly cli: LarkCli) {}

  start(onEvent: (event: MessageEvent) => Promise<void>, onExit: (error?: Error) => void): Promise<void> {
    if (this.child) throw new Error("Event consumer is already running");
    this.stopping = false;
    this.accepting = true;
    const child = this.cli.spawnEventConsumer();
    this.child = child;

    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      try {
        if (!this.accepting) return;
        const task = Promise.resolve().then(() => onEvent(JSON.parse(line) as MessageEvent));
        this.active.add(task);
        void task.catch((error) => {
          process.stderr.write(`[event] handler failed: ${error instanceof Error ? error.message : String(error)}\n`);
        }).finally(() => this.active.delete(task));
      } catch (error) {
        process.stderr.write(`[event] invalid JSON: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    });

    return new Promise((resolve, reject) => {
      let ready = false;
      let terminalReported = false;
      const reportTerminal = (error: Error): void => {
        if (terminalReported) return;
        terminalReported = true;
        this.child = undefined;
        if (this.stopping) return;
        if (!ready) reject(error); else onExit(error);
      };
      createInterface({ input: child.stderr }).on("line", (line) => {
        process.stderr.write(`${line}\n`);
        if (!ready && line.includes("[event] ready event_key=im.message.receive_v1")) {
          ready = true;
          resolve();
        }
      });
      child.once("error", reportTerminal);
      child.once("exit", (code, signal) => {
        reportTerminal(new Error(`Event consumer exited code=${code ?? "null"} signal=${signal ?? "null"}`));
      });
    });
  }

  isReady(): boolean { return Boolean(this.child); }

  stop(): void {
    this.stopping = true;
    this.accepting = false;
    this.child?.kill("SIGTERM");
    this.child = undefined;
  }

  async drain(timeoutMs: number): Promise<void> {
    if (this.active.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.active]).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
}
