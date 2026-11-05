/**
 * The published type declarations, checked by compiling real TypeScript against them under `strict`
 * (see __tests__/types/usage.ts, which includes lines that must be rejected).
 */
const { spawnSync } = require('child_process');
const path = require('path');

test('usage.ts compiles under strict, and the @ts-expect-error lines are rejected as intended', () => {
  const tsc = path.join(__dirname, '..', 'node_modules', 'typescript', 'bin', 'tsc');
  const r = spawnSync(process.execPath, [tsc, '-p', path.join(__dirname, 'types', 'tsconfig.json')], { encoding: 'utf8' });
  expect(r.stdout + r.stderr).toBe('');
  expect(r.status).toBe(0);
}, 120000);
