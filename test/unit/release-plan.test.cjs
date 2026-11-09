// Which pushes to main ship, and as which version (scripts/release-plan.mjs).
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../scripts/release-plan.mjs');
const released = ['v1.12.0', 'v1.11.1', 'v1.13.2', 'not-a-version'];

test('patch numbers count up by themselves', async () => {
  const { plan } = await load();
  const p = plan({ base: '1.13.0', released, changed: ['app/renderer/app.js'], manual: false, isTip: true });
  assert.deepEqual([p.release, p.version], [true, '1.13.3']);
});

test('bumping app/package.json starts a new line', async () => {
  const { plan } = await load();
  const p = plan({ base: '1.14.0', released, changed: ['README.md'], manual: false, isTip: true });
  assert.deepEqual([p.release, p.version], [true, '1.14.0']);
});

test('docs, tests and CI-only pushes do not bother players', async () => {
  const { plan } = await load();
  const p = plan({ base: '1.13.0', released, changed: ['README.md', 'test/e2e.cjs', '.github/workflows/tests.yml', 'docs/state-machines.md'], manual: false, isTip: true });
  assert.equal(p.release, false);
  assert.match(p.reason, /nothing players get changed/);
});

test('icons, the build script and the Electron pin count as shipped', async () => {
  const { plan } = await load();
  for (const f of ['build/icons/gameguide.icns', 'scripts/package.mjs', 'package.json', 'package-lock.json', 'app/package-lock.json']) {
    assert.equal(plan({ base: '1.13.0', released, changed: [f], manual: false, isTip: true }).release, true, f);
  }
});

test('an older commit that finishes late does not ship', async () => {
  const { plan } = await load();
  assert.equal(plan({ base: '1.13.0', released, changed: ['app/main.js'], manual: false, isTip: false }).release, false);
});

test('Run workflow by hand always ships the next patch', async () => {
  const { plan } = await load();
  const p = plan({ base: '1.13.0', released, changed: [], manual: true, isTip: false });
  assert.deepEqual([p.release, p.version], [true, '1.13.3']);
});

test('first release ever, and unknown history, both ship', async () => {
  const { plan } = await load();
  assert.deepEqual(plan({ base: '1.0.0', released: [], changed: null, manual: false, isTip: true }).version, '1.0.0');
  assert.equal(plan({ base: '1.13.0', released, changed: null, manual: false, isTip: true }).release, true);
});

test('a broken version in app/package.json stops the release', async () => {
  const { plan } = await load();
  assert.throws(() => plan({ base: '1.13', released, changed: [], manual: false, isTip: true }), /not x\.y\.z/);
});
