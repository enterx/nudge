---
name: release
description: >-
  Cut and ship a new release of the @enterx/nudge plugin: bump the version,
  update the CHANGELOG, rebuild dist, run tests, merge the PR, publish to npm,
  and create the git tag + GitHub Release. Use when the user wants to "release",
  "ship the next version", "publish to npm", "cut a release", "配布する",
  "次のバージョンを出す", or roll a merged/ready PR into a distributed version.
---

# Release @enterx/nudge

End-to-end release flow for this repo. Follow the steps in order. Stop and ask
the user only at the explicit decision/hand-off points called out below.

## 0. Preconditions

- The change is on a feature branch with an **open, mergeable PR** (or already on
  `main` if doing a tag-only release). Verify: `gh pr view <N> --json state,mergeable`.
- Working tree is clean except the release-prep edits you are about to make.
- Decide the version bump with **SemVer**: new user-facing feature → **minor**
  (`1.2.0 → 1.3.0`); bug-fix only → **patch** (`1.3.0 → 1.3.1`); breaking → major.
  If ambiguous, confirm the number with the user before committing.

## 1. Bump the version — TWO files

The version lives in two places and **both** must match:

1. `core/lib/constants.mjs` → `export const SERVER_VERSION = 'X.Y.Z';`
   This is the **single source `build.sh` reads** to stamp `plugin.json` and the
   `marketplace.json` manifests — do this one first.
2. `package.json` → `"version": "X.Y.Z"` (npm publishes from this).

The MCP `initialize` test imports `SERVER_VERSION` (it does not hard-code the
number), so no test edit is needed for a version bump.

## 2. CHANGELOG

Add a new section at the top of `CHANGELOG.md` (above the previous version):

```
## [X.Y.Z] - YYYY-MM-DD

<one-line summary; note backwards-compatibility explicitly>

### Added
- ...
### Fixed
- ...
```

Use today's date. Keep the entries user-facing.

## 3. Rebuild dist + run tests

```
bash build.sh            # regenerates dist/ + plugin.json + both marketplace.json from constants.mjs
bash core/tests/run-all.sh   # must be all green
```

Confirm the version propagated:
`grep -H '"version"' dist/claude-code/plugins/nudge/.claude-plugin/plugin.json .claude-plugin/marketplace.json`

## 4. Commit + push + merge the PR

```
git add -A
git commit -m "chore: release X.Y.Z — <headline>"
git push
```

Merge with **squash**, matching the repo convention `... (#NN)`:

```
gh pr merge <N> --squash --delete-branch --subject "<pr title> (#<N>)"
git checkout main && git pull
```

## 5. Publish to npm — HAND OFF TO THE USER

npm publish needs 2FA. **You cannot run this yourself**, because:
- it requires npm **11+** for browser-based 2FA (`--auth-type=web`);
- the web-auth URL is **redacted** in the agent's view, and the command needs a
  real TTY to open the browser and poll for completion.

So ask the user to run it in their own shell via the `!` prefix:

```
! cd /Users/rayuron/works/github/nudge-plugin && npm publish --access public --auth-type=web
```

(If npm < 11: `! npm i -g npm@11` first.) Wait for them to confirm. Then verify:

```
npm view @enterx/nudge version dist-tags.latest   # should show X.Y.Z / X.Y.Z
```

Do **not** attempt to harvest OTP codes or auth tokens from logs/history — that
gets blocked as credential exploration and is not the right path anyway.

## 6. git tag + GitHub Release

Tag convention is annotated `vX.Y.Z` on the merge commit:

```
git tag -a vX.Y.Z -m "vX.Y.Z — <headline>" <merge-sha>
git push origin vX.Y.Z
```

Create the GitHub Release using the CHANGELOG section as notes:

```
gh release create vX.Y.Z --title "vX.Y.Z — <headline>" --verify-tag --notes "<changelog body + npm install line>"
```

## Done — report back

Summarize: npm version live, PR merged commit, tag, and the release URL.
