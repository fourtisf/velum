// PM2 process file. Start: pm2 start deploy/ecosystem.config.cjs && pm2 save
// Assumes the repo lives at /opt/velum and .env is filled.
const path = require('path');
const root = path.resolve(__dirname, '..');

module.exports = {
  apps: [
    {
      name: 'velum-web',
      cwd: path.join(root, 'apps/web'),
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      instances: 2,
      exec_mode: 'cluster',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '700M',
    },
    {
      name: 'velum-api',
      cwd: path.join(root, 'apps/api'),
      script: 'dist/server.js',
      instances: 2,
      exec_mode: 'cluster',
      node_args: '--enable-source-maps',
      env: { NODE_ENV: 'production', PORT: 4000 },
      max_memory_restart: '500M',
    },
    {
      name: 'velum-workers',
      cwd: path.join(root, 'apps/workers'),
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '500M',
    },
  ],
};
