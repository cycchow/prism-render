module.exports = {
  apps : [{
    name   : "prism-render",
    script : "prismrender.js",
    instances: 1,
    exec_mode: "fork",
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
      const { closeBrowser } = require('./prismrender');
      await closeBrowser();
      console.log('PM2: Pre-exit cleanup complete.');
    }
  }],
};
