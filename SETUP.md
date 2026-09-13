# "What I'm working on" — auto-updating profile section

Ordering comes from real push activity. **Visibility comes only from `projects.json`.**
A repo you push to that isn't in that file never appears — that's the whole point, and it's
why this is a whitelist rather than a blacklist. A new private experiment can't leak onto your
profile by forgetting to exclude it.

## Layout in `msantoro12/msantoro12`

```
README.md
scripts/
  build-now.mjs
  projects.json
.github/workflows/
  update-now.yml
```

## Setup — about five minutes

**1. Put the markers in `README.md`** where you want the section to appear. The script replaces
everything between them and fails loudly if they're missing:

```markdown
<!-- NOW:START -->
<!-- NOW:END -->
```

**2. Create a fine-grained PAT.**
Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new.

- **Resource owner:** your account
- **Repository access:** All repositories *(this is what lets private pushes affect ordering)*
- **Permissions:** Repository permissions → **Metadata: Read-only**. Nothing else. Do **not**
  grant Contents.
- **Expiration:** set a real one. 90 days is sensible; GitHub emails you before it lapses, and
  the workflow fails loudly rather than silently publishing stale data.

Metadata-only is deliberate: the token can see *that* a repo was pushed and when. It cannot read
your code, commit messages or branch names, so there's nothing sensitive for the job to leak
even if the output were wrong.

**3. Add it as a secret** in `msantoro12/msantoro12`:
Settings → Secrets and variables → Actions → New repository secret →
name `PROFILE_READ_TOKEN`.

**4. Copy the files in**, then Actions → "Update now section" → **Run workflow** to test it
without waiting for the cron.

## Adding a project

Edit `scripts/projects.json`. Pushing that file re-renders immediately — no waiting for the
schedule.

```json
"msantoro12/some-private-repo": {
  "label": "What it is",
  "blurb": "One short line.",
  "private": true
}
```

For private repos, **omit `link`** — a 404 looks worse than no link.

## Things to know

- **GitHub disables scheduled workflows after 60 days of repo inactivity.** It emails you first.
  This job commits to the repo when something changes, which usually counts as activity — but a
  quiet stretch where nothing shifts can still trip it. Re-enable from the Actions tab.
- **The bot commits to your profile repo**, so your contribution graph shows daily activity.
  If that bothers you, drop the cron to weekly (`'15 7 * * 1'`) — the section is rarely more
  than a few days stale anyway.
- **Relative dates only** ("3 days ago"), never timestamps. Exact push times on private repos
  say more about your working patterns than you probably want public.
- If the token expires the run fails and the README keeps its last good content. Failing loud
  and stale beats failing quiet and wrong.
