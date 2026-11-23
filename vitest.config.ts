import { defineConfig } from 'vitest/config';

// A test's time limit only catches a hang. The tests that drive the hooks take seconds
// each while the replay gate holds every worker, and on a loaded host they pass the
// 5 s default: they time out in a whole run and pass alone.
export default defineConfig({ test: { testTimeout: 60_000 } });
