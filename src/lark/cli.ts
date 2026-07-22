import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { LarkCliError } from "./errors.js";

const execFileAsync = promisify(execFile);

interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  identity?: string;
}

export class LarkCli {
  constructor(private readonly binary = "lark-cli") {}

  async run<T>(args: string[], timeoutMs = 30_000): Promise<T> {
    try {
      const { stdout } = await execFileAsync(this.binary, args, {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
        },
      });
      const envelope = JSON.parse(stdout) as SuccessEnvelope<T>;
      if (!envelope.ok) throw new LarkCliError({ message: "lark-cli returned an unsuccessful response" });
      return envelope.data;
    } catch (error) {
      if (error instanceof LarkCliError) throw error;
      const candidate = error as { stderr?: string; stdout?: string; message?: string };
      const raw = candidate.stderr?.trim() || candidate.stdout?.trim();
      if (raw) {
        try {
          const envelope = JSON.parse(raw) as { error?: ConstructorParameters<typeof LarkCliError>[0] };
          if (envelope.error) throw new LarkCliError(envelope.error);
        } catch (parsed) {
          if (parsed instanceof LarkCliError) throw parsed;
        }
      }
      throw new LarkCliError({ type: "internal", message: candidate.message ?? "Unable to execute lark-cli" });
    }
  }

  async runText(args: string[], timeoutMs = 30_000): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.binary, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
      return stdout.trim();
    } catch (error) {
      const candidate = error as { stderr?: string; message?: string };
      throw new LarkCliError({ type: "internal", message: candidate.stderr?.trim() || candidate.message });
    }
  }

  spawnEventConsumer(): ChildProcessWithoutNullStreams {
    return spawn(this.binary, ["event", "consume", "im.message.receive_v1", "--as", "bot"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
    });
  }
}
