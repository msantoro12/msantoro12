# "What I'm working on" — the auto-updating digest

A model writes a five-day digest, one short paragraph per day, daily. Ordering and content
both come from real commit activity. **What may be published at all comes only from
`scripts/projects.json`** — a repo that isn't in that file never appears, and with the token
setup below it isn't even readable.

## The one thing to understand

The digest is only as safe as what the model is handed, so the split is structural rather
than a line in a prompt:

| | What the model receives |
|---|---|
| **Public** whitelisted repo | commit subjects — it writes specifically about them |
| **Private** repo, any | a commit **count** and a type histogram. Nothing else. |

For private repos the subjects are read to compute the histogram and then dropped. They
never enter the request, so the model cannot leak them — not with a reworded prompt, not
on a different model, not if a commit message itself tries something. Redacting names in
the prompt instead would hide the least sensitive part (which repo) and publish the most
sensitive (what you did to it).

A sanitation gate runs over the output as a second layer. It is openly partial: it catches
mechanical leaks — version numbers, issue refs, emails, URLs, credential shapes — plus
distinctive vocabulary that appears only in private commits. It cannot catch a semantic
leak, because "a rate limiter that trusted a spoofable header" contains no forbidden
token. The structural split is what handles those. If the gate trips, the run fails and
the README keeps its last good content.

## Layout

```
README.md
package.json           # one dependency, the Anthropic SDK
scripts/
  build-digest.mjs     # the digest (what the workflow runs)
  build-now.mjs        # model-free fallback: a plain table, metadata only
  projects.json        # the whitelist
.github/workflows/
  update-now.yml
```

## Setup

**1. Markers in `README.md`** where the section should appear. The script replaces
everything between them and fails loudly if they're missing:

```markdown
<!-- NOW:START -->
<!-- NOW:END -->
```

**2. Two fine-grained PATs**, and the difference between them is the point.
Settings → Developer settings → Personal access tokens → Fine-grained tokens.

| Secret | Repository access | Permissions |
|---|---|---|
| `PROFILE_READ_TOKEN` | **All repositories** | Metadata: Read-only. Nothing else. |
| `PROFILE_DIGEST_TOKEN` | **Only select repositories** — pick exactly the ones in `projects.json` | Metadata: Read-only **and** Contents: Read-only |

Set a real expiration on both; 90 days is sensible. GitHub emails before they lapse and
the workflow fails loudly rather than publishing stale data.

> **Be clear-eyed about what changed here.** The earlier metadata-only design could
> promise *the token cannot read your code*. Per-day commit counts need `Contents: read`,
> so this one promises *the script reads it and does not forward it* — a weaker claim,
> enforced by code rather than by the credential. Scoping the digest token to selected
> repositories is what claws most of that back: a new private experiment isn't merely
> unlisted, it's unreadable. **When you add a repo to `projects.json`, add it to that
> token's repository list too, or it silently won't appear.**

**3. An Anthropic API key** as `ANTHROPIC_API_KEY`.

**4. Add all three** in Settings → Secrets and variables → Actions → New repository secret.

**5. Run it** from Actions → "Update now section" → Run workflow, rather than waiting for
the cron.

## Checking it yourself

```bash
PAYLOAD_ONLY=1 GH_META_TOKEN=… GH_DIGEST_TOKEN=… GH_USER=msantoro12 node scripts/build-digest.mjs
```

Prints the exact bytes the model is about to receive, and stops. If a private repo's
commit subject ever appears in that output, the boundary is broken — that is the check
worth running after touching the script.

```bash
DIGEST_FIXTURE="…some deliberately leaky prose…" node scripts/build-digest.mjs
```

Runs the gate against a canned string instead of calling the model, so you can confirm it
still catches things without spending a request.

## Model

`DIGEST_MODEL` in the workflow, default `claude-haiku-4-5`. At one run a day this costs
roughly **$2/year** on Haiku, $4 on Sonnet 5, $10 on Opus 5 — the whole decision spans
about eight dollars, so choose on how the prose reads, not on price. Develop prompt
changes against `claude-sonnet-5`, then drop back and diff.

One API detail: `output_config.effort` is rejected with a 400 on Haiku 4.5. The script
only sets it for the larger models.

## Adding a project

Edit `scripts/projects.json` — pushing that file re-renders immediately. Then **add the
repo to `PROFILE_DIGEST_TOKEN`'s repository list**, or it stays invisible. For private
repos make `label` say what the thing *is* without naming it, and omit `link` unless it
points at a product rather than a repo.

## Things to know

- **GitHub disables scheduled workflows after 60 days of repo inactivity.** It emails you
  first. This job commits when something changes, which usually counts — but a quiet
  stretch can still trip it. Re-enable from the Actions tab.
- **The bot commits daily**, so your contribution graph shows activity. Drop the cron to
  weekly (`'15 7 * * 1'`) if that bothers you.
- **Dates are relative and author-based**, never timestamps. Author date, not push date —
  "what I did Tuesday" should mean Tuesday. A repo pushed today can hold commits written
  last week, so the digest and a push-ordered view will sometimes disagree.
- **A failed run leaves the last good README in place.** Failing loud and stale beats
  failing quiet and wrong.
