module.exports = {
  apps : [{
    name   : "prism-render",
    script : "prismrender.js",
    instances: "max",
    exec_mode: "cluster",
    autorestart: true,
    watch: false,
    max_memory_restart: "1G",
    env: {
      NODE_ENV: "development",
    },
    env_production: {
      NODE_ENV: "production",
    },
    post_update: [
      "npm install"
    ],
    pre_exit: async () => {
      console.log('PM2: Running pre-exit cleanup...');
      const { closeBrowser, cleanupZombieProcesses } = require('./prismrender');
      await closeBrowser();
      await cleanupZombieProcesses();
      console.log('PM2: Pre-exit cleanup complete.');
    }
  }],
};
