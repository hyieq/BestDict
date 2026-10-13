# BestDict — AI maintainer notes

BestDict is an Electron / React / TypeScript desktop dictionary with local Python inference.
Read the relevant code and `docs/TESTING.md` before changing behavior. Preserve user changes.
Desktop tests use isolated configuration; do not change the user's installed client or settings.

## README previews

Keep public screenshots in `docs/assets` aligned with the current UI. Capture the actual
client in an isolated session, using real installed models when showcasing AI output.
Show the GitHub entry, pronunciation buttons, and cache controls where relevant.
Inspect the final screenshots for clipped content, transient loading states, and readable text.
Keep the public README focused on usage; retain publishing instructions in this file.

## Release procedure

Publish only when the user asks to release, or asks to push and build a new version.
Use a new version for changed application behavior. Synchronize `package.json`, both root
versions in `package-lock.json`, the README badge, and `CHANGELOG.md`.

The workflow `.github/workflows/release.yml` runs on a pushed `v*` tag. The tag must exactly
match `v` + the package version. Commit the completed changes, create an annotated version
tag, and push the branch and tag (prefer an atomic push). Never overwrite a published tag.
Check the remote branch/tag state before pushing and resolve any divergence normally.

The Release workflow prepares Windows x64 runtimes and the offline dictionary, tests
resources and the speech installer, builds the installer, and tests the packaged desktop,
glass UI, query modes, AI menus/styles, and speech/cache interactions. It then publishes
the installer and SHA-256 file as the latest GitHub Release. Optional model weights and
user audio caches must not be bundled. Local builds use `npm.cmd run package`; an isolated
output directory can be set with `BESTDICT_RELEASE_DIR` (for example `release/v<version>`).

GitHub publication uses the workflow's temporary `GITHUB_TOKEN`; no personal token is
needed for that workflow. Track the actual run through completion and verify the public
release has the correct tag, installer, checksum, and latest status. If it fails, inspect
the failed step and logs; fix the cause before retrying. A manual workflow run must target
a version tag because the Windows release job skips non-tag refs. Do not replace an
already published release with different binaries.
