// Rewrites the "What I'm working on" block in README.md with a five-day digest,
// one day at a time, written by a model.
//
// ---------------------------------------------------------------------------
// THE BOUNDARY. This is the only part of this file that really matters.
// ---------------------------------------------------------------------------
// A summariser is only as safe as what you hand it. Commit messages are where
// people are least careful -- they name incidents, describe the vulnerability
// that was just closed, and mention customers by name -- so the split here is
// STRUCTURAL rather than a line in a prompt:
//
//   PUBLIC  whitelisted repo -> commit subjects go to the model.
//   PRIVATE repo, any        -> ONLY a per-day count and a conventional-commit
//                               type histogram go to the model. Subjects are read
//                               to compute the histogram and then dropped on the
//                               floor. They never enter the prompt.
//
// The model cannot leak what it was never given. A reworded prompt, a swapped
// model, or a hostile commit message cannot widen this -- the data is simply
// absent from the request. Redacting names in the prompt instead would hide the
// least sensitive part (which repo) while publishing the most sensitive (what
// you actually did to it).
//
// ---------------------------------------------------------------------------
// TWO TOKENS, on purpose
// ---------------------------------------------------------------------------
//   GH_META_TOKEN    Metadata: Read-only, ALL repositories. Decides what exists
//                    and when it was pushed. Cannot read a line of code.
//   GH_DIGEST_TOKEN  Contents: Read-only, scoped to the WHITELISTED REPOS ONLY.
//                    This is what makes projects.json enforceable at the
//                    credential instead of in this file: an unlisted repo is not
//                    merely skipped, it is unreadable.
//
// Be honest about what changed: the old design could promise "the token cannot
// read your code". This one promises "the script reads it and does not forward
// it". That is a real step down, which is why the digest token is repo-scoped
// and why the gate below exists.
//
// Env:
//   GH_META_TOKEN, GH_DIGEST_TOKEN, GH_USER   required
//   ANTHROPIC_API_KEY                          required
//   DIGEST_MODEL   optional, default claude-haiku-4-5
//   DIGEST_DAYS    optional, default 5
//   DRY_RUN        optional, "1" prints and writes nothing

import { readFile, writeFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';

const META_TOKEN = process.env.GH_META_TOKEN;
const DIGEST_TOKEN = process.env.GH_DIGEST_TOKEN;
const USER = process.env.GH_USER;
const MODEL = process.env.DIGEST_MODEL ?? 'claude-haiku-4-5';
const DAYS = Number(process.env.DIGEST_DAYS ?? 5);
const DRY_RUN = process.env.DRY_RUN === '1';

const START = '<!-- NOW:START -->';
const END = '<!-- NOW:END -->';

if (!META_TOKEN || !DIGEST_TOKEN || !USER) {
  console.error('GH_META_TOKEN, GH_DIGEST_TOKEN and GH_USER are required.');
  process.exit(1);
}

async function gh(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `${USER}-profile-digest`,
    },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

// Author date, not push date. "What I did Tuesday" should mean Tuesday -- a repo
// pushed today can hold commits written last week, and dating those to the push
// makes a quiet day look busy.
const dayKey = (iso) => iso.slice(0, 10);

const dayLabel = (key) =>
  new Date(`${key}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

const ccType = (subject) => (subject.match(/^([a-z]+)[(:]/)?.[1] ?? 'other');

// --- gather ------------------------------------------------------------------

const config = JSON.parse(await readFile(new URL('./projects.json', import.meta.url), 'utf8'));
const allowed = config.projects ?? {};

const repos = [];
for (let page = 1; page <= 4; page++) {
  const batch = await gh(
    `/user/repos?sort=pushed&per_page=100&page=${page}&affiliation=owner,organization_member`,
    META_TOKEN,
  );
  repos.push(...batch);
  if (batch.length < 100) break;
}

const since = new Date(Date.now() - DAYS * 86_400_000);
const days = new Map(); // dayKey -> { public: [], private: Map<label, Map<type, n>> }
const privateCorpus = []; // for the canary only; never sent anywhere

for (let i = 0; i < DAYS; i++) {
  const key = dayKey(new Date(Date.now() - i * 86_400_000).toISOString());
  days.set(key, { public: [], private: new Map() });
}

for (const repo of repos) {
  const entry = allowed[repo.full_name];
  if (!entry) continue; // not whitelisted -- and the digest token cannot read it anyway
  if (new Date(repo.pushed_at) < since) continue;

  let commits;
  try {
    commits = await gh(
      `/repos/${repo.full_name}/commits?since=${since.toISOString()}&per_page=100`,
      DIGEST_TOKEN,
    );
  } catch (err) {
    // A repo the digest token is not scoped to answers 404. That is the whitelist
    // working at the credential layer, not an error worth failing the run over.
    console.warn(`skip ${repo.full_name}: ${err.message.slice(0, 80)}`);
    continue;
  }

  for (const c of commits) {
    const subject = c.commit.message.split('\n')[0];
    const key = dayKey(c.commit.author.date);
    const bucket = days.get(key);
    if (!bucket) continue;

    if (repo.private) {
      // Aggregate ONLY. The subject is used for its type prefix and the canary,
      // then dropped -- it is never placed in the model payload.
      privateCorpus.push(subject);
      const type = ccType(subject);
      const hist = bucket.private.get(entry.label) ?? new Map();
      hist.set(type, (hist.get(type) ?? 0) + 1);
      bucket.private.set(entry.label, hist);
    } else {
      bucket.public.push({ label: entry.label, subject });
    }
  }
}

// --- the payload the model actually receives ---------------------------------

const payload = [...days.entries()]
  .sort((a, b) => b[0].localeCompare(a[0]))
  .map(([key, bucket]) => {
    const lines = [];
    for (const { label, subject } of bucket.public) lines.push(`  PUBLIC ${label}: ${subject}`);
    for (const [, hist] of bucket.private) {
      const counts = [...hist.entries()].map(([t, n]) => `${t}=${n}`).join(' ');
      const total = [...hist.values()].reduce((a, b) => a + b, 0);
      lines.push(`  PRIVATE (name withheld): ${total} commits [${counts}]`);
    }
    return `${dayLabel(key)}\n${lines.length ? lines.join('\n') : '  (no commits anywhere)'}`;
  })
  .join('\n\n');

const SYSTEM = `You write the "What I'm working on" section of Mike Santoro's GitHub profile.
He runs Good Stuff Software, an independent studio. The audience is other engineers --
often a maintainer deciding whether to take his patches. Write for that reader.

Output: one short paragraph per day, newest first, in the exact order given. Each begins
with the bolded day label exactly as provided, an em dash, then the prose. Markdown, no
headings, no bullets, no preamble, no closing line.

VOICE. Dry, specific, understated. Assume the reader is technical and needs nothing
explained twice. No exclamation marks, no hype, no "excited to share", no emoji.
Confidence comes from specificity, never from adjectives. Where the shape of a day says
something -- many fixes and merges against few features means a day spent landing and
hardening rather than starting -- say that. It is more interesting than the raw count.

PUBLIC entries: name the project and be concrete about what changed.

PRIVATE entries: you are given a commit COUNT and a type histogram and nothing else. You
genuinely do not know what the work was. Never speculate about content, never invent a
feature, never guess the repo name. Refer to it as [REDACTED] in backticks and describe
only cadence and shape. This constraint is the point of the section, so wear it lightly
rather than apologising for it.

EMPTY DAYS: a day with no commits anywhere gets one witty line and nothing else. This is
the one place to be funny -- dry, not zany, and different every time. The register to aim
for: "Nothing. Even the bots took the day off." / "No commits. The code was left
unsupervised and survived." / "Nothing shipped. A day spent thinking, or a day spent not
thinking -- the log cannot tell the difference." Write a fresh one; do not reuse those.

Never output: version numbers, issue or PR numbers, dates other than the supplied labels,
customer or product names absent from the input, URLs, or anything describing a security
fix.`;

// The local audit hatch: print the EXACT bytes the model is about to receive and
// stop. Nothing else in this file is worth trusting on faith -- if a private repo's
// subject line ever shows up in this output, the boundary is broken.
if (process.env.PAYLOAD_ONLY === '1') {
  console.log('--- system prompt ---\n' + SYSTEM);
  console.log('\n--- user payload ---\n' + payload);
  console.log(`\n--- withheld: ${privateCorpus.length} private commit subjects never sent ---`);
  process.exit(0);
}

const client = new Anthropic();

const req = {
  model: MODEL,
  max_tokens: 2000,
  system: SYSTEM,
  messages: [{ role: 'user', content: `Write the digest for these ${DAYS} days.\n\n${payload}` }],
};
// effort is rejected with a 400 on Haiku 4.5 -- it belongs only on the larger models.
if (/^claude-(sonnet|opus|fable)/.test(MODEL)) req.output_config = { effort: 'low' };

// DIGEST_FIXTURE substitutes a canned string for the model call, so the gate below
// can be exercised -- including against deliberately leaky prose -- without spending
// a request. A gate nobody tests is a gate nobody should trust.
const prose = process.env.DIGEST_FIXTURE
  ? process.env.DIGEST_FIXTURE.trim()
  : await (async () => {
      const response = await client.messages.create(req);
      return response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
    })();

// --- the gate ----------------------------------------------------------------
// Defence in depth, and openly partial: this catches MECHANICAL leaks. It cannot
// catch a semantic one -- "a rate limiter that trusted a spoofable header" contains
// no forbidden token. The structural split above is what handles those. A trip fails
// the run and the README keeps its last good content, because failing loud and stale
// beats failing quiet and wrong.

// Ordinary English. Without this the canary flags words like "run", "shape" and
// "open" -- they appear in private commit subjects because they appear in all
// English -- and a gate that fires on every run is a gate that gets deleted.
const STOPWORDS = new Set(
  `the and for that with this from have has had not but all any can will would should could
   its it is are was were been being they them their there here when while what which who how
   why into out over under about after before more most less least only also than then some
   such same other another each both few many much own one two three first second third new
   old now still just even ever never always again back down up off on in of to at by as or
   if so no yes do does did done make makes made made use uses used using get gets got give
   given take takes taken keep keeps kept let lets leave leaves left go goes going come comes
   came run runs running ran work works working worked day days week weeks month months year
   time times shape shapes open opens opened close closes closed real true false good bad big
   small long short high low fast slow early late next last full empty part parts whole thing
   things way ways case cases point points line lines side sides end ends start starts across
   against between through during without within along around behind beyond
   add adds added fix fixes fixed feat feature features doc docs test tests chore build builds
   ci refactor perf merge merges merged release releases released update updates updated
   change changes changed set sets setting remove removes removed drop drops dropped
   support supports supported handle handles handled return returns returned call calls called`
    .trim()
    .split(/\s+/),
);

const tokens = (s) => s.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
const publicTokens = new Set(
  [...days.values()].flatMap((b) => b.public).flatMap(({ subject }) => tokens(subject)),
);
// Distinctive vocabulary appearing ONLY in private commit subjects.
//
// Given the structural split the model never sees those subjects, so this is not
// the primary defence -- it is a REGRESSION DETECTOR. If someone later edits this
// file and starts forwarding private subjects, a real leak dumps whole sentences
// and trips many tokens at once. Tuned accordingly: short and common words are
// excluded, then two or more distinct hits fail, or a single long one (>= 8 chars,
// which is jargon rather than prose: "spoofable", "resolver").
const canary = new Set(
  privateCorpus
    .flatMap(tokens)
    .filter((t) => t.length >= 5 && !STOPWORDS.has(t) && !publicTokens.has(t)),
);

const failures = [];
const PATTERNS = [
  [/\bv?\d+\.\d+\.\d+\b/, 'a version number'],
  [/#\d+/, 'an issue or PR reference'],
  [/\bD\d{2,4}\b/, 'a decision id'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, 'an email address'],
  [/\bhttps?:\/\//, 'a URL'],
  [/\b[0-9a-f]{16,}\b/, 'a long hex string'],
  [/\b(sk|ghp|gho|github_pat|AKIA)[-_A-Za-z0-9]{8,}/, 'something shaped like a credential'],
];
for (const [re, what] of PATTERNS) {
  const hit = prose.match(re);
  if (hit) failures.push(`${what}: ${hit[0]}`);
}
const tripped = [...new Set(tokens(prose).filter((t) => canary.has(t)))];
const jargon = tripped.filter((t) => t.length >= 8);
if (tripped.length >= 2 || jargon.length >= 1) {
  failures.push(`private-only vocabulary: ${tripped.slice(0, 8).join(', ')}`);
} else if (tripped.length === 1) {
  console.warn(`note: "${tripped[0]}" also occurs in private commits. Below the fail line.`);
}

if (failures.length) {
  console.error('Sanitation gate FAILED. README left unchanged.');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`\n--- blocked output ---\n${prose}`);
  process.exit(1);
}

// --- write -------------------------------------------------------------------

const block = [
  START,
  '',
  "### What I'm working on",
  '',
  prose,
  '',
  '<sub>Written daily by a model from commit metadata. Private repositories contribute a',
  'commit count and nothing else, so it has no idea what half of this is.</sub>',
  '',
  END,
].join('\n');

if (DRY_RUN) {
  console.log(block);
  process.exit(0);
}

// A machine-readable copy for anything downstream -- currently the local Discord
// presence agent, which cannot parse prose out of a README reliably. Written from
// the SAME gated values, so a consumer cannot reach anything the profile would not
// already show. `headline` is deliberately shapeless: counts only, no repo names.
const totals = [...days.values()].reduce(
  (acc, b) => {
    acc.public += b.public.length;
    for (const [, hist] of b.private) for (const n of hist.values()) acc.private += n;
    return acc;
  },
  { public: 0, private: 0 },
);
const todayBucket = days.get(dayKey(new Date().toISOString()));
const todayCount =
  (todayBucket?.public.length ?? 0) +
  [...(todayBucket?.private.values() ?? [])].reduce(
    (a, h) => a + [...h.values()].reduce((x, y) => x + y, 0),
    0,
  );
await writeFile(
  new URL('../digest.json', import.meta.url),
  `${JSON.stringify(
    {
      generated: new Date().toISOString().slice(0, 10),
      days: DAYS,
      commitsToday: todayCount,
      commitsInWindow: totals.public + totals.private,
      headline: todayCount ? `${todayCount} commits today` : 'no commits today',
      prose,
    },
    null,
    2,
  )}\n`,
);

const readmePath = new URL('../README.md', import.meta.url);
const readme = await readFile(readmePath, 'utf8');
if (!readme.includes(START) || !readme.includes(END)) {
  console.error(`README.md is missing the ${START} / ${END} markers.`);
  process.exit(1);
}
const updated = readme.replace(new RegExp(`${START}[\\s\\S]*?${END}`), () => block);
const changed = updated !== readme;

if (changed) {
  await writeFile(readmePath, updated);
  console.log(`Wrote digest (${MODEL}).`);
} else {
  console.log('No change.');
}

// --- optional: mirror to a Discord channel ------------------------------------
// Posts ONLY on a real change, so a quiet stretch does not repost the same text
// every night, and ONLY after the gate above has passed -- whatever reaches Discord
// carries exactly the same guarantees as the profile.
//
// A webhook URL is a channel-scoped credential, not an account one: it can post to
// that one channel and do nothing else. Unset, this whole block no-ops, so the
// workflow is safe to ship before the server exists.
//
// Deliberately never fatal. The README is the deliverable; a webhook that 404s
// because a channel was renamed must not fail the run or block the commit.
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
if (WEBHOOK && changed && !DRY_RUN) {
  // Discord caps an embed description at 4096 chars.
  const description = prose.length > 4000 ? `${prose.slice(0, 3997)}...` : prose;
  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [
          {
            title: "What I'm working on",
            description,
            footer: {
              text: 'Written from commit metadata. Private repos contribute a commit count and nothing else.',
            },
          },
        ],
      }),
    });
    console.log(res.ok ? 'Posted to Discord.' : `Discord POST -> ${res.status} (ignored)`);
  } catch (err) {
    console.warn(`Discord post failed, continuing: ${err.message}`);
  }
} else if (WEBHOOK && !changed) {
  console.log('Discord: nothing new to say, skipped.');
}
