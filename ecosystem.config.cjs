// pm2: npm i -g pm2 && pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
module.exports = {
  apps: [{
    name: 'crypto-watcher',
    script: 'index.js',
    node_args: '--disable-proto=delete',
    autorestart: true,
    restart_delay: 10000,
    max_memory_restart: '600M',
    env: { NODE_ENV: 'production' },
  }],
};
