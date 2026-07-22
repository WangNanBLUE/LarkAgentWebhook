const path = require("node:path");

const logFile = path.join(__dirname, "data", "agent.log");

module.exports = {
  apps: [{
    name: "feishu-competitor-analysis",
    script: "dist/src/index.js",
    cwd: __dirname,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 2000,
    merge_logs: true,
    out_file: logFile,
    error_file: logFile,
    env: { NODE_ENV: "production" },
  }],
};
