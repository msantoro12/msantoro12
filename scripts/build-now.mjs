// Regenerates the "What I'm working on" block in README.md.
//
// Ordering comes from real push activity (private repos included, when the token
// can see them). Visibility comes ONLY from projects.json. A repo that is not in
// that file is skipped without comment -- that is the whole safety model, and it
// is deliberately a whitelist rather than a blacklist so a new private repo can
// never appear by accident.
//
// Env:
//   GH_TOKEN    required. Fine-grained PAT, read-only "Metadata" is enough.
//   GH_USER     required. e.g. msantoro12
//   MAX_ITEMS   optional, default 4.
//   NUDGE_DAYS  optional, default 14. Window the nudge treats as "recent".
//   AUDIT       optional. "1" lists every recently-pushed repo with no label, so
//               you can see what the profile is not saying. LOCAL USE ONLY -- it
//               names repositories, and Actions logs on a public repo are public.

import { readFile, writeFile, appendFile } from 'node:fs/promises';

const TOKEN = process.env.GH_TOKEN;
const USER = process.env.GH_USER;
const MAX = Number(process.env.MAX_ITEMS ?? 4);
const NUDGE_DAYS = Number(process.env.NUDGE_DAYS ?? 14);
const AUDIT = process.env.AUDIT === '1';

const START = '<!-- NOW:START -->';
const END = '<!-- NOW:END -->';

if (!TOKEN || !USER) {
  console.error('GH_TOKEN and GH_USER are required.');
  process.exit(1);
}

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `${USER}-profile-now`,
    },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

// owner AND organization_member: the GoodStuffSoftware repos are the whole point,
// and affiliation=owner alone silently excludes every one of them.
async function recentRepos() {
  const out = [];
  for (let page = 1; page <= 4; page++) {
    const batch = await gh(
      `/user/repos?sort=pushed&per_page=100&page=${page}&affiliation=owner,organization_member`,
    );
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

// Relative only, never a timestamp: exact push times on private repos say more
// about working patterns than is worth publishing.
function relative(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

const config = JSON.parse(await readFile(new URL('./projects.json', import.meta.url), 'utf8'));
const allowed = config.projects ?? {};

const repos = await recentRepos();
const rows = [];

for (const repo of repos) {
  const entry = allowed[repo.full_name];
  if (!entry) continue; // not publishable -- skip silently
  if (rows.length >= MAX) break;

  const name = entry.link ? `[${entry.label}](${entry.link})` : entry.label;
  rows.push(`| **${name}** | ${entry.blurb} | ${relative(repo.pushed_at)} |`);
}

// --- nudge -------------------------------------------------------------------
// The whitelist is safe but it does not maintain itself, and nobody wants to come
// back here to add entries. So count the repos with real recent activity that have
// no label, and say so.
//
// In CI this reports a COUNT ONLY. Naming them would defeat the point of the
// whitelist, because Actions logs on a public repository are public.
const cutoff = Date.now() - NUDGE_DAYS * 86_400_000;
const unlabelled = repos.filter(
  (r) => !allowed[r.full_name] && new Date(r.pushed_at).getTime() >= cutoff,
);

if (AUDIT) {
  console.log(`\nUnlabelled repos pushed in the last ${NUDGE_DAYS} days:`);
  if (unlabelled.length === 0) console.log('  (none)');
  for (const r of unlabelled) {
    const vis = r.private ? 'private' : 'public ';
    console.log(`  ${vis}  ${r.full_name.padEnd(44)} ${relative(r.pushed_at)}`);
  }
  console.log('\nAdd any of these to scripts/projects.json to surface them.\n');
}

if (process.env.GITHUB_STEP_SUMMARY && unlabelled.length > 0) {
  const line =
    unlabelled.length === 1
      ? '1 repository with recent activity has no label'
      : `${unlabelled.length} repositories with recent activity have no label`;

  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    [
      '### Profile "now" section',
      '',
      `Showing **${rows.length}** of **${Object.keys(allowed).length}** labelled projects.`,
      '',
      `> ${line} in the last ${NUDGE_DAYS} days.`,
      '> Names are withheld here on purpose - this log is public.',
      '> Run `AUDIT=1 node scripts/build-now.mjs` locally to see them.',
      '',
    ].join('\n'),
  );
}

const table = rows.length
  ? ['| | | |', '|---|---|---|', ...rows].join('\n')
  : '_Nothing to show right now._';

const block = [
  START,
  '',
  "### What I'm working on",
  '',
  table,
  '',
  `<sub>Updated automatically - last run ${new Date().toISOString().slice(0, 10)}.</sub>`,
  '',
  END,
].join('\n');

const readmePath = new URL('../README.md', import.meta.url);
const readme = await readFile(readmePath, 'utf8');

if (!readme.includes(START) || !readme.includes(END)) {
  console.error(`README.md is missing the ${START} / ${END} markers.`);
  process.exit(1);
}

const updated = readme.replace(new RegExp(`${START}[\\s\\S]*?${END}`), () => block);

if (updated === readme) {
  console.log('No change.');
} else {
  await writeFile(readmePath, updated);
  console.log(`Wrote ${rows.length} row(s).`);
}
