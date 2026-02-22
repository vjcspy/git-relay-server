module.exports = {
  apps: [{
    name: 'git-relay-server',
    script: 'dist/index.js',
    node_args: '--env-file=.env',
    env: {
      NODE_ENV: 'production',
      // v2-only relay transport encryption (server decrypts v2 envelopes only)
      TRANSPORT_CRYPTO_MODE: 'v2',
      TRANSPORT_KEY_ID: '<transport-key-id>',
      // Escaped single-line PEM, e.g. -----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n
      TRANSPORT_PRIVATE_KEY_PEM: '<escaped-x25519-private-key-pem>',
      TRANSPORT_REPLAY_TTL_MS: '300000',
      TRANSPORT_CLOCK_SKEW_MS: '30000',
    },
  }],
};
