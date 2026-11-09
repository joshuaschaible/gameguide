// Decides whether a commit on main ships, and as which version.
// Used by .github/workflows/release.yml; safe to run locally (read-only):
//   node scripts/release-plan.mjs [sha]        (needs gh logged in, or GH_TOKEN)
//
// Rules
//  1. Only the newest commit on main ships (an older run that finishes late skips).
//  2. Version: app/package.json if it is above the latest release (you bumped
//     major/minor on purpose), otherwise the latest release with patch + 1.
//  3. Skip when nothing players get changed since the latest release
//     (docs, tests, CI-only pushes), unless the version was bumped or the
//     workflow was started by hand (MANUAL=1).
// Writes release=true|false, version, sha, reason to $GITHUB_OUTPUT when set.
import { execFileSync } from 'child_process';
import { readFileSync, appendFileSync } from 'fs';

// What players get: the app, its icons, the build script and the Electron pin.
export const SHIPPED = [/^app\//, /^build\//, /^scripts\/package\.mjs$/, /^package(-lock)?\.json$/];

const parse = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  return m ? m.slice(1).map(Number) : null;
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const fmt = (v) => v.join('.');

export function plan({ base, released, changed, manual, isTip }) {
  const b = parse(base);
  if (!b) throw new Error(`app/package.json version "${base}" is not x.y.z`);
  const tags = released.map(parse).filter(Boolean).sort(cmp);
  const latest = tags[tags.length - 1] || null;
  if (!isTip && !manual) return { release: false, reason: 'a newer commit on main will ship instead' };
  const bumped = !latest || cmp(b, latest) > 0;
  const version = bumped ? fmt(b) : fmt([latest[0], latest[1], latest[2] + 1]);
  const shipped = changed === null ? ['(unknown history)'] : changed.filter((f) => SHIPPED.some((re) => re.test(f)));
  if (!manual && !bumped && !shipped.length) {
    return { release: false, version, reason: `nothing players get changed since v${fmt(latest)} (only ${changed.length} docs/test/CI files)` };
  }
  return {
    release: true,
    version,
    reason: manual ? 'started by hand' : bumped ? `app/package.json says ${fmt(b)}` : `${shipped.length} shipped file(s) changed since v${fmt(latest)}`,
  };
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function main() {
  const repo = process.env.GITHUB_REPOSITORY || 'joshuaschaible/gameguide';
  const sha = run('git', ['rev-parse', process.env.SHA || process.argv[2] || 'HEAD']);
  const manual = process.env.MANUAL === '1';
  const base = JSON.parse(run('git', ['show', `${sha}:app/package.json`])).version;
  const released = JSON.parse(run('gh', ['api', `repos/${repo}/releases?per_page=100`, '--jq', '[.[].tag_name]']));
  const tip = run('git', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];
  const latestTag = released.map((t) => [t, parse(t)]).filter((x) => x[1]).sort((a, b) => cmp(a[1], b[1])).pop();
  let changed = null;
  if (latestTag) {
    try { changed = run('git', ['diff', '--name-only', `${latestTag[0]}`, sha]).split('\n').filter(Boolean); } catch { changed = null; }
  }
  const p = plan({ base, released, changed, manual, isTip: sha === tip });
  const out = { release: String(p.release), version: p.version || '', sha, reason: p.reason };
  console.log(JSON.stringify(out));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, p.release ? `### Shipping v${p.version}\n${p.reason}\n` : `### Not shipping ${sha.slice(0, 7)}\n${p.reason}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('release-plan.mjs')) main();
