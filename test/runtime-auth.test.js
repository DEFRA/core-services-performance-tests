import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const scenarios = ['frps-full-journey-v2', 'wmp-full-journey'];
async function initialise(scenario, env, csv) {
  const context = vm.createContext({ __ENV: env, console,
    open: (path) => path.endsWith('.csv') ? csv : '[{"sbi":888000001,"crn":9990000001}]',
  });
  const module = new vm.SourceTextModule(await readFile(new URL(`../src/scenarios/${scenario}.js`, import.meta.url), 'utf8'), { context });
  await module.link(async (name) => {
    if (name.endsWith('/runtime-inputs.js')) {
      return new vm.SourceTextModule(await readFile(new URL('../src/lib/runtime-inputs.js', import.meta.url), 'utf8'), { context });
    }
    const exports = name === 'k6/http' ? { default: {} }
      : name === 'k6' ? { sleep() {} }
      : name === 'k6/data' ? { SharedArray: class { constructor(_, create) { return create(); } } }
      : name.endsWith('/checks.js') ? { assertStatus() {} } : { handleSummary() {} };
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
}
for (const scenario of scenarios) {
  test(`${scenario}: requires a configured bearer token before loading cookies`, async () => {
    await assert.rejects(initialise(scenario, {}, 'cookieHeader\nsession=test-only-cookie\n'), /GAS_BEARER_TOKEN.*required/);
  });
  test(`${scenario}: refuses an empty cookie pool`, async () => {
    await assert.rejects(initialise(scenario, { GAS_BEARER_TOKEN: 'test-only-token' }, 'cookieHeader\n'), /session cookies/i);
  });
  test(`${scenario}: accepts fresh runtime cookies and a configured token`, async () => {
    await initialise(scenario, { GAS_BEARER_TOKEN: 'test-only-token' }, 'cookieHeader\nsession=test-only-cookie\n');
  });
}
