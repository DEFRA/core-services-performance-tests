import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function startup(mode, overrides = {}, stale = false) {
  const dir = mkdtempSync(join(tmpdir(), 'performance-entrypoint-'));
  try {
    for (const path of ['bin', 'scripts', 'src/data', 'src/lib', 'src/scenarios', 'reports/frps', 'reports/wmp']) mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    for (const path of ['scripts/validate-session-cookies.js', 'src/lib/runtime-inputs.js']) {
      const source = new URL('../' + path, import.meta.url);
      if (existsSync(source)) cpSync(source, join(dir, path));
    }
    const cookieFile = join(dir, 'src/data/frps-session-cookies.csv');
    if (stale) writeFileSync(cookieFile, 'cookieHeader\nsession=stale-test-cookie\n');
    const trace = join(dir, 'trace');
    writeFileSync(join(dir, 'bin/npm'), `#!/bin/sh
printf 'generate\\n' >> "$TRACE"
case "$MODE" in
  fail) exit 1 ;;
  empty) printf 'cookieHeader\\n' > "$COOKIE_PATH" ;;
  missing) : ;;
  *) printf 'cookieHeader\\nsession=fresh-test-cookie\\n' > "$COOKIE_PATH" ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(dir, 'bin/k6'), '#!/bin/sh\nprintf "k6\\n" >> "$TRACE"\n', { mode: 0o755 });
    for (const name of ['frps-full-journey-v2', 'wmp-full-journey']) writeFileSync(join(dir, 'src/scenarios/' + name + '.js'), '');
    // Only remap the container root. The real entrypoint and validation code run.
    const script = readFileSync(new URL('../entrypoint.sh', import.meta.url), 'utf8').replaceAll('/app', dir);
    writeFileSync(join(dir, 'entrypoint.sh'), script);
    const result = spawnSync('sh', ['entrypoint.sh'], { cwd: dir, encoding: 'utf8',
      env: { PATH: join(dir, 'bin') + ':' + process.env.PATH, TRACE: trace, MODE: mode,
        COOKIE_PATH: cookieFile, ENTRA_ID_WRITER_USER: 'test-user', ENTRA_ID_USER_PASSWORD: 'test-password',
        GAS_BEARER_TOKEN: 'test-only-token', CW_FRONTEND_BASE_URL: 'test.invalid', ...overrides },
    });
    return { status: result.status, output: result.stdout + result.stderr,
      calls: existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n') : [], cookieLeft: existsSync(cookieFile) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('startup creates fresh cookies before both scenarios without a stored CSV', () => {
  const result = startup('success');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, ['generate', 'k6', 'k6']);
});
test('startup removes runtime cookies when the run finishes', () => {
  assert.equal(startup('success').cookieLeft, false);
});
test('missing bearer credentials stop startup before login', () => {
  const result = startup('success', { GAS_BEARER_TOKEN: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /GAS_BEARER_TOKEN.*required/);
  assert.deepEqual(result.calls, []);
});
for (const mode of ['fail', 'empty', 'missing']) {
  test(`cookie generation ${mode}: no scenario starts and no stale cookies survive`, () => {
    const result = startup(mode, {}, true);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, ['generate']);
    assert.equal(result.cookieLeft, false);
  });
}
