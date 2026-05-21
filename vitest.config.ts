import { defineConfig } from 'vitest/config';

// SDK tests run entirely against in-memory mocks of the OMS API — no
// DB, no network. The OMS-5 send-path lands in its own ticket, so the
// SDK tests assert against the wire-protocol contract defined in
// `evaluation/adr-orboto-mail-service.md`.
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 10_000,
  },
});
