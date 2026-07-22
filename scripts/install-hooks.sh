#!/bin/sh
# Symlinks tracked hooks/ into .git/hooks/ so the version-bump pre-commit
# hook is active after `npm install`. See CLAUDE.md "Versioning". No-op
# outside a git checkout (e.g. when installed as a dependency).
set -e
hooks_dir=".git/hooks"
[ -d "$hooks_dir" ] || exit 0
for hook in hooks/*; do
  name=$(basename "$hook")
  ln -sf "../../hooks/$name" "$hooks_dir/$name"
done
