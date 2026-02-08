module.exports = {
  apps: [{
    name: 'git-relay-server',
    script: 'dist/index.js',
    node_args: '--env-file=.env',
    env: {
      NODE_ENV: 'production',
    },
  }],
};
