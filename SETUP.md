# "What I'm working on" — the auto-updating digest

A model writes a five-day digest, one short paragraph per day, daily. Ordering and content
both come from real commit activity. **What may be published at all comes only from
`scripts/projects.json`** — a repo that isn't in that file never appears, and with the token
setup below it isn't even readable.

## How it works

The run is split into three steps, each its own trust boundary:

1. **`PAYLOAD_FILE=<path> node scripts/build-digest.mjs`** — a GitHub Action, holding both
   GitHub tokens, gathers commit activity and writes a payload: the prompt instructions plus
   data that is already split (public commit subjects, private repos as counts and a
   conventional-commit type histogram only). It exits without writing anything else.
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
Action that still holds the tokens. It is openly partial: it catches **mechanical** leaks —
version numbers, issue refs, emails, URLs, credential shapes, plus any three-word phrase, or
cluster of three or more words, that appears only in private commits. It cannot catch a
**semantic** leak, because "a rate limiter that trusted a spoofable header" contains no
forbidden token. The structural split above is what handles those. If the gate trips, the
run fails and the README keeps its last good content.

**In CI the gate names only the kind of problem, never the text.** Actions logs on a public
repo are public, so printing what it blocked would publish the leak it just stopped. Run it
locally (below) to see the detail.

## Setup

**Two fine-grained PATs**, and the difference between them is the point. Settings →
Developer settings → Personal access tokens → Fine-grained tokens.

| Secret | Repository access | Permissions |
|---|---|---|
| `PROFILE_READ_TOKEN` | **All repositories** | Metadata: Read-only. Nothing else. |
| `PROFILE_DIGEST_TOKEN` | **Only select repositories** — pick exactly the ones in `projects.json` | Metadata: Read-only **and** Contents: Read-only |

Set a real expiration on both; 90 days is sensible. GitHub emails before they lapse and the
workflow fails loudly rather than publishing stale data.

> **Be clear-eyed about what changed here.** The earlier metadata-only design could promise
> *the token cannot read your code*. Per-day commit counts need `Contents: read`, so this one
> promises *the script reads it and does not forward it* — a weaker claim, enforced by code
> rather than by the credential. Scoping the digest token to selected repositories is what
> claws most of that back: a new private experiment isn't merely unlisted, it's unreadable.
> **When you add a repo to `projects.json`, add it to that token's repository list too, or it
> silently won't appear.**

> **The resource-owner trap.** A fine-grained PAT has exactly one resource owner, but
> `projects.json` spans both `msantoro12` and the `GoodStuffSoftware` org. A token created
> under one owner cannot see the other's repos no matter what you tick. After creating
> `PROFILE_DIGEST_TOKEN`, verify it actually sees all seven:
>
> ```bash
> GH_TOKEN=<token> gh api "user/repos?affiliation=owner,organization_member&per_page=100" --jq '.[].full_name'
> ```
>
> If the org repos are missing from that list, one token cannot cover both owners — a second
> org-owned token is needed. Raise it if you hit this; designing that split is out of scope
> here.

**Add both as secrets of the `digest` environment — never as repository secrets.**
Settings → Environments → `digest` → Environment secrets. The environment already exists
and only `main` may use it. That rule is load-bearing: a repository secret is readable by a
workflow file pushed to *any* branch, and the cloud routine can push `claude/*` branches — so
a repository secret would hand the routine the very credential this design keeps from it.

**Optional: `DISCORD_WEBHOOK_URL`**, also in the `digest` environment — a channel-scoped
webhook, not an account credential.
Unset, the Discord step no-ops, so it's safe to leave out until the channel exists.

**No Anthropic API key.** The prose is written by a Claude cloud routine on the owner's own
subscription, not by an API call this repo pays for. Manage it at
[claude.ai/code/routines](https://claude.ai/code/routines) — it needs the Claude GitHub app
to have access to this repository.

## The data branch

`digest-input` is a public branch, and that is fine. It holds only what the digest itself
would show on the profile: public commit subjects (already public) and private repos as
counts and a type histogram (never a subject). Nothing crosses into it that the README
wouldn't eventually carry anyway.

## Schedule

- **Payload**: `0 3 * * *` (03:00 UTC), plus `workflow_dispatch` and a push to
  `scripts/projects.json` on `main`.
- **Routine**: 13:00 UTC (9am Eastern), on the owner's Claude subscription. The payload job
  runs ten hours earlier on purpose — GitHub delays scheduled runs by hours (5–7 hours late
  has been observed on this repo), and the margin keeps the payload ahead of the routine.
- **Publish**: `0 15 * * *` (15:00 UTC), plus `workflow_dispatch`. Deliberately a schedule,
  not a push trigger: on push, GitHub runs the *pushed branch's* copy of a workflow, so a
  push-triggered publish would let whatever the routine pushed decide what runs beside the
  tokens. A scheduled run always uses `main`'s copy. It must also land on the same UTC day as
  the payload, because the gate requires every day label of the current window.
- **Watchdog**: once both secrets are configured, the payload job reads the `generated` date
  out of `digest.json` on `main` before doing anything else. Null (never published) is fine.
  Anything older than 72 hours fails the job loudly — the cloud routine or the publish step
  has stopped producing digests, and that is worth an email.

## Checking it yourself

```bash
PAYLOAD_ONLY=1 GH_META_TOKEN=… GH_DIGEST_TOKEN=… GH_USER=msantoro12 node scripts/build-digest.mjs
```

Prints the exact bytes the routine is about to receive, and stops. If a private repo's commit
subject ever appears in that output, the boundary is broken — that is the check worth running
after touching the script.

```bash
DIGEST_PROSE_FILE=some-leaky-file.md DRY_RUN=1 GH_META_TOKEN=… GH_DIGEST_TOKEN=… GH_USER=msantoro12 node scripts/build-digest.mjs
```

Runs the gate against a file you control instead of a real routine run, `DRY_RUN=1` so
nothing is written. Point it at deliberately leaky prose to confirm the gate still catches
things without waiting on a routine.

## Adding a project

Edit `scripts/projects.json` — pushing that file re-gathers the payload immediately. Then
**add the repo to `PROFILE_DIGEST_TOKEN`'s repository list**, or it silently won't appear.
For private repos make `label` say what the thing *is* without naming it, and omit `link`
unless it points at a product rather than a repo.

## Things to know

- **GitHub disables scheduled workflows after 60 days of repo inactivity.** It emails you
  first. This job commits when something changes, which usually counts — but a quiet stretch
  can still trip it. Re-enable from the Actions tab.
- **Dates are relative and author-based**, never timestamps. Author date, not push date —
  "what I did Tuesday" should mean Tuesday. A repo pushed today can hold commits written last
  week, so the digest and a push-ordered view will sometimes disagree.
- **A failed run leaves the last good README in place.** Failing loud and stale beats failing
  quiet and wrong.
