# "What I'm working on" — the auto-updating digest

A model writes a five-day digest, one short paragraph per day, daily. Ordering and content
both come from real commit activity. **What may be published at all comes only from
`scripts/projects.json`** — a repo that isn't in that file never appears.

## How it works

The run is split into three steps, each its own trust boundary:

1. **`PAYLOAD_FILE=<path> node scripts/build-digest.mjs`** — a GitHub Action, holding the one
   read-only GitHub token, gathers commit activity and writes a payload: the prompt
   instructions plus data that is already split (public commit subjects, private repos as
   counts and a conventional-commit type histogram only). It exits without writing anything
   else.
2. **A Claude cloud routine** reads that payload from the public `digest-input` branch and
   writes one paragraph per day to `digest-prose.md`, force-pushed to `claude/digest-prose`.
3. **`DIGEST_PROSE_FILE=<path> node scripts/build-digest.mjs`** — a GitHub Action re-gathers
   the same activity, runs the sanitation gate against it (including a canary check against
   the private commit corpus and a check that every day label is present), and only then
   rewrites `README.md` and `digest.json`, and optionally posts to Discord.

The key property: **the agent writing the words is given no token for the private
repositories.** Its only GitHub access is whatever Claude's GitHub integration grants the
routine — so confirm that integration is scoped to this repository alone. If it is, even a
routine that ignored its own prompt could not go and read a private commit. Before this
split, "write only from the payload" was purely a line in a prompt.

| | What the routine receives |
|---|---|
| **Public** whitelisted repo | commit subjects — it writes specifically about them |
| **Private** repo, any | a commit **count** and a type histogram. Nothing else. |

A sanitation gate runs over the routine's output as a second layer, back inside the GitHub
Action that holds the token. It is openly partial: it catches **mechanical** leaks — version
numbers, issue refs, emails, URLs, credential shapes, plus any three-word phrase, or cluster
of three or more words, that appears only in private commits. It cannot catch a **semantic**
leak, because "a rate limiter that trusted a spoofable header" contains no forbidden token.
The structural split above is what handles those. If the gate trips, the run fails and the
README keeps its last good content.

**In CI the gate names only the kind of problem, never the text.** Actions logs on a public
repo are public, so printing what it blocked would publish the leak it just stopped. Run it
locally (below) to see the detail.

## Setup

**One fine-grained, read-only token.** Settings → Developer settings → Personal access
tokens → Fine-grained tokens.

- **Needs:** Contents: Read-only on the **private** repos in `projects.json` (today
  `deckhand` and `best-sudoku`). Metadata comes with it. Nothing else — no write
  permissions of any kind.
- **Public repos need no grant.** GitHub lets every token read every public repository, so
  the five GoodStuffSoftware repos are covered whatever the token's owner or repo list.
- **Narrowest option:** Repository access → *Only select repositories* → just those private
  repos. That makes `projects.json` enforceable at the credential: an unlisted private repo
  is unreadable, not merely skipped. An *All repositories* read-only token also works; the
  difference is only what it could read if it ever leaked.
- Set a real expiration; 90 days is sensible. GitHub emails before it lapses, and the run
  fails loudly rather than publishing stale data.

Repos are fetched **by name** from `projects.json`, so the token never needs to list your
repositories. A whitelisted repo it cannot see, or whose commits it cannot read, raises a
warning in the run summary instead of quietly disappearing.

> **Be clear-eyed about what this token is.** Per-day commit counts need `Contents: read`,
> so the promise is *the script reads your private commits and does not forward them* —
> enforced by code and the gate, not by the credential.

**Add it as a secret of the `digest` environment — never as a repository secret.** Name it
`PROFILE_READ_TOKEN`. Settings → Environments → `digest` → Environment secrets. The
environment already exists and only `main` may use it. That rule is load-bearing: a
repository secret is readable by a workflow file pushed to *any* branch, and the cloud
routine can push `claude/*` branches — so a repository secret would hand the routine the
very credential this design keeps from it.

**Optional: `DISCORD_WEBHOOK_URL`**, also in the `digest` environment — a channel-scoped
webhook, not an account credential. Unset, the Discord step no-ops, so it's safe to leave
out until the channel exists.

**No Anthropic API key.** The prose is written by a Claude cloud routine on the owner's own
subscription, not by an API call this repo pays for. Manage it at
[claude.ai/code/routines](https://claude.ai/code/routines) — it needs the Claude GitHub app
to have access to this repository.

## The data branch

`digest-input` is a public branch, and that is fine. It holds only what the digest itself
would show on the profile: public commit subjects (already public) and private repos as
counts and a type histogram (never a subject).

## Schedule

- **Payload**: `0 3 * * *` (03:00 UTC), plus `workflow_dispatch` and a push to
  `scripts/projects.json` on `main`.
- **Routine**: 13:00 UTC (9am Eastern), on the owner's Claude subscription. The payload job
  runs ten hours earlier on purpose — GitHub delays scheduled runs by hours (5–7 hours late
  has been observed on this repo), and the margin keeps the payload ahead of the routine.
- **Publish**: `0 15 * * *` (15:00 UTC), plus `workflow_dispatch`. Deliberately a schedule,
  not a push trigger: on push, GitHub runs the *pushed branch's* copy of a workflow, so a
  push-triggered publish would let whatever the routine pushed decide what runs beside the
  token. A scheduled run always uses `main`'s copy. It must also land on the same UTC day as
  the payload, because the gate requires every day label of the current window.
- **Watchdog**: once the secret is configured, the payload job reads the `generated` date
  out of `digest.json` on `main`. Null (never published) is fine. Anything older than 72
  hours fails the job loudly — the routine or the publish step has stopped producing
  digests, and that is worth an email.

## Checking it yourself

```bash
PAYLOAD_ONLY=1 GH_READ_TOKEN=… GH_USER=msantoro12 node scripts/build-digest.mjs
```

Prints the exact bytes the routine is about to receive, and stops. If a private repo's commit
subject ever appears in that output, the boundary is broken — that is the check worth running
after touching the script.

```bash
DIGEST_PROSE_FILE=some-leaky-file.md DRY_RUN=1 GH_READ_TOKEN=… GH_USER=msantoro12 node scripts/build-digest.mjs
```

Runs the gate against a file you control instead of a real routine run, `DRY_RUN=1` so
nothing is written. Point it at deliberately leaky prose to confirm the gate still catches
things without waiting on a routine.

## Adding a project

Edit `scripts/projects.json` — pushing that file re-gathers the payload immediately. If the
repo is **private** and the token uses *Only select repositories*, **add it to the token's
repository list too**; the run warns if it can't read it. For private repos make `label` say
what the thing *is* without naming it, and omit `link` unless it points at a product rather
than a repo.

## Things to know

- **GitHub disables scheduled workflows after 60 days of repo inactivity.** It emails you
  first. This job commits when something changes, which usually counts — but a quiet stretch
  can still trip it. Re-enable from the Actions tab.
- **Dates are relative and author-based**, never timestamps. Author date, not push date —
  "what I did Tuesday" should mean Tuesday. A repo pushed today can hold commits written last
  week, so the digest and a push-ordered view will sometimes disagree.
- **A failed run leaves the last good README in place.** Failing loud and stale beats failing
  quiet and wrong.
