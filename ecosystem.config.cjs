module.exports = {
  apps: [{
    name: "feishu-competitor-analysis",
    script: "dist/src/index.js",
    cwd: __dirname,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 2000,
    env: { NODE_ENV: "production" },
  }],
};
