# Agent File Logging Design

## Goal

Run the Feishu competitor-analysis service under PM2 and persist all application output only to `data/agent.log`. The application must no longer depend on an attached terminal for logs.

## Runtime Configuration

- Keep application logging unchanged: informational events continue to use stdout and failures continue to use stderr.
- Configure PM2 to send both stdout and stderr to the absolute project-local path `data/agent.log`.
- Enable merged PM2 logs so restarts and any future process instances use the same file.
- Keep `data/` ignored by Git so logs and SQLite state remain local runtime data.
- Stop the current terminal-attached Node process before PM2 starts the replacement, preventing port conflicts on `127.0.0.1:8787`.

## Log Rotation

Install and configure `pm2-logrotate` with a 10 MB maximum file size, seven retained files, and compression enabled. Rotation must apply to `data/agent.log` without changing the application.

## Startup And Recovery

Build the TypeScript output, load `.env` into the PM2 launch environment, and start `ecosystem.config.cjs`. PM2 retains automatic restart behavior already declared in the ecosystem file. The application output remains available through the file and PM2's log inspection commands, but is not attached to the invoking terminal.

## Verification

Completion requires all of the following:

1. Tests, type checking, and build pass.
2. PM2 reports `feishu-competitor-analysis` as online.
3. `http://127.0.0.1:8787/healthz` returns HTTP 200 with status `ok`.
4. `data/agent.log` exists and receives a fresh startup log entry.
5. The running Node process stdout and stderr point to `data/agent.log`, not a terminal.
6. `data/agent.log` remains ignored by Git.
