import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const entryPoints = [
  {
    entryPoint: '@yaniv120892/app-kit/client-address',
    expectedExports: ['readClientAddress', 'addressClient'],
  },
  {
    entryPoint: '@yaniv120892/app-kit/counter-store',
    expectedExports: ['createUpstashCounterStore'],
  },
  {
    entryPoint: '@yaniv120892/app-kit/daily-budget',
    expectedExports: ['createDailyBudget', 'reserveDailyBudget', 'isFeatureDisabled'],
  },
  {
    entryPoint: '@yaniv120892/app-kit/rate-limit',
    expectedExports: ['createRateLimiter', 'rateLimitRefusalResponse', 'refuseIfRateLimited'],
  },
  { entryPoint: '@yaniv120892/app-kit/safe-next-path', expectedExports: ['safeNextPath'] },
  {
    entryPoint: '@yaniv120892/app-kit/secrets',
    expectedExports: ['secretsEqual', 'isBearerAuthorized', 'requireCronSecret'],
  },
  { entryPoint: '@yaniv120892/app-kit/security-headers', expectedExports: ['securityHeaders'] },
  {
    entryPoint: '@yaniv120892/app-kit/token-format',
    expectedExports: ['createSignedTokenFormat', 'hasTokenShape'],
  },
];

/**
 * Runs the built package outside any bundler, the way a vitest run, a tsx script or a CommonJS
 * app compiled by tsc loads it, and checks the named exports arrive.
 */
function loadInPlainNode({
  entryPoint,
  moduleSystem,
  expectedExports,
}: {
  entryPoint: string;
  moduleSystem: string;
  expectedExports: string[];
}) {
  const load =
    moduleSystem === 'commonjs'
      ? `const loaded = require(${JSON.stringify(entryPoint)});`
      : `const loaded = await import(${JSON.stringify(entryPoint)});`;
  const check = `
for (const name of ${JSON.stringify(expectedExports)}) {
  if (typeof loaded[name] !== 'function') {
    throw new Error(name + ' is not exported');
  }
}`;
  return spawnSync(process.execPath, ['--input-type', moduleSystem, '-e', `${load}\n${check}`], {
    encoding: 'utf8',
  });
}

describe('built entry points', () => {
  for (const { entryPoint, expectedExports } of entryPoints) {
    for (const moduleSystem of ['module', 'commonjs']) {
      it(`load ${entryPoint} as ${moduleSystem} without a bundler`, () => {
        const result = loadInPlainNode({ entryPoint, moduleSystem, expectedExports });
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
      });
    }
  }
});
