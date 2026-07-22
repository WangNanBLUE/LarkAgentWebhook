import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { MessageEvent } from "../types.js";
import { LarkCli } from "./cli.js";

export class EventConsumer {
  private child?: ChildProcessWithoutNullStreams;
  private stopping = false;

  constructor(private readonly cli: LarkCli) {}

  start(onEvent: (event: MessageEvent) => Promise<void>, onExit: (error?: Error) => void): Promise<void> {
    if (this.child) throw new Error("Event consumer is already running");
    this.stopping = false;
    const child = this.cli.spawnEventConsumer();
    this.child = child;

    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      try {
        void onEvent(JSON.parse(line) as MessageEvent);
      } catch (error) {
        process.stderr.write(`[event] invalid JSON: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    });

    return new Promise((resolve, reject) => {
      let ready = false;
      createInterface({ input: child.stderr }).on("line", (line) => {
        process.stderr.write(`${line}\n`);
        if (!ready && line.includes("[event] ready event_key=im.message.receive_v1")) {
          ready = true;
          resolve();
        }
      });
      child.once("error", (error) => {
        this.child = undefined;
        if (!ready) reject(error); else onExit(error);
      });
      child.once("exit", (code, signal) => {
        this.child = undefined;
        if (this.stopping) return;
        const error = new Error(`Event consumer exited code=${code ?? "null"} signal=${signal ?? "null"}`);
        if (!ready) reject(error); else onExit(error);
      });
    });
  }

  isReady(): boolean { return Boolean(this.child); }

  stop(): void {
    this.stopping = true;
    this.child?.kill("SIGTERM");
    this.child = undefined;
  }
}
