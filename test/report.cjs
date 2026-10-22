// Small result collector for the smoke tests.
// PASS/FAIL are hard checks (any FAIL exits 1). SKIP says what did not run and why.
// NOTE records an observation. On GitHub Actions the results also go to the job
// summary and one annotation, so they can be read without downloading logs.
const fs = require('fs');

const prop = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
const msg = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

module.exports = function reporter(title) {
  const rows = [];
  const fails = [];
  const add = (s, name, detail) => {
    const d = detail === undefined || detail === null || detail === '' ? '' : String(detail);
    rows.push({ s, name, d });
    console.log(`${s} ${name}${d ? ` (${d})` : ''}`);
  };
  return {
    check(name, ok, detail) { add(ok ? 'PASS' : 'FAIL', name, detail); if (!ok) fails.push(name); return !!ok; },
    skip(name, why) { add('SKIP', name, why); },
    note(name, value) { add('NOTE', name, value); },
    finish() {
      const n = (s) => rows.filter((r) => r.s === s).length;
      const head = `${n('PASS')} pass, ${n('FAIL')} fail, ${n('SKIP')} skip`;
      if (process.env.GITHUB_ACTIONS === 'true') {
        const t = `${title} on ${process.platform}-${process.arch}`;
        const body = rows.map((r) => `${r.s} ${r.name}${r.d ? `: ${r.d.slice(0, 200)}` : ''}`).join('\n');
        console.log(`::${fails.length ? 'error' : 'notice'} title=${prop(t)}::${msg(`${head}\n${body}`)}`);
        if (process.env.GITHUB_STEP_SUMMARY) {
          const cell = (s) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300);
          const md = [`### ${t}: ${head}`, '', '| Result | Check | Detail |', '|---|---|---|',
            ...rows.map((r) => `| ${r.s} | ${cell(r.name)} | ${cell(r.d)} |`), ''].join('\n');
          try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n'); } catch { /* ignore */ }
        }
      }
      if (fails.length) { console.error('FAILED:', fails.join(', ')); process.exit(1); }
      console.log(`ALL CHECKS PASSED (${head})`);
      process.exit(0);
    },
  };
};
