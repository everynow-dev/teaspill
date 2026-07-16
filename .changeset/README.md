# Changesets

This directory is managed by [Changesets](https://github.com/changesets/changesets).

Every package under `packages/*` is currently `"private": true` and unpublished — `access`
is set to `restricted` as a placeholder. Run `pnpm changeset` to record a change, and
`pnpm version-packages` to apply version bumps. Publishing (`pnpm release`) is not wired
into CI yet; that's a T-later concern once a package is ready to ship to npm.
