# A release, in order

1. On `develop`: bump the version in all five places (`../CLAUDE.md` § Rules), and move `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] — date`. Every merge into `main` publishes, so a pre-release suffix (`-dev.N`, `-alpha`) becomes the real release version here.
2. `make release-check` passes, after `git fetch origin main`.
3. Open the `develop → main` pull request. Its `ci.yml` runs the same make targets, `check` on Linux and macOS and `release`, and its `ci` job passes only when every one succeeded; `release` requires the version to have moved past `main`'s and the CHANGELOG section to yield notes.
4. Merge once `ci` is green. The merge is the release: `publish.yml`'s `publish` job tags the merge commit `forward-compaction--vX.Y.Z` and publishes the GitHub release from the CHANGELOG section. No tag is pushed by hand.
