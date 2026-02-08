module.exports = {
  apps: [{
    name: 'git-relay-server',
    script: 'dist/index.js',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
  }],
};
