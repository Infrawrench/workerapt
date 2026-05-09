#!/usr/bin/env bash
# Stage and publish the workerapt-upload CLI to npm as a standalone package.
#
# Usage:
#   scripts/publish-workerapt-upload.sh <version> [--dry-run] [--tag <tag>]
#
# Examples:
#   scripts/publish-workerapt-upload.sh 0.1.0
#   scripts/publish-workerapt-upload.sh 0.1.0 --dry-run
#   scripts/publish-workerapt-upload.sh 0.2.0-beta.1 --tag beta

set -euo pipefail

if [[ $# -lt 1 ]]; then
	echo "Usage: $0 <version> [--dry-run] [--tag <tag>]" >&2
	exit 2
fi

VERSION="$1"
shift

DRY_RUN=0
TAG=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		--dry-run) DRY_RUN=1; shift ;;
		--tag) TAG="${2:?--tag requires a value}"; shift 2 ;;
		*) echo "Unknown flag: $1" >&2; exit 2 ;;
	esac
done

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
	echo "Invalid semver: $VERSION" >&2
	exit 2
fi

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/bin/workerapt-upload.mjs"
LICENSE="$REPO_ROOT/LICENSE"

[[ -f "$SRC" ]] || { echo "Missing $SRC" >&2; exit 1; }
[[ -f "$LICENSE" ]] || { echo "Missing $LICENSE" >&2; exit 1; }

STAGE="$(mktemp -d -t workerapt-upload-publish.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/bin"
cp "$SRC" "$STAGE/bin/workerapt-upload.mjs"
chmod +x "$STAGE/bin/workerapt-upload.mjs"
cp "$LICENSE" "$STAGE/LICENSE"

cat > "$STAGE/package.json" <<EOF
{
  "name": "workerapt-upload",
  "version": "$VERSION",
  "description": "CLI to upload .deb packages to a workerapt-backed APT repository on Cloudflare Workers + R2.",
  "license": "MIT",
  "type": "module",
  "main": "bin/workerapt-upload.mjs",
  "bin": {
    "workerapt-upload": "bin/workerapt-upload.mjs"
  },
  "files": [
    "bin/workerapt-upload.mjs",
    "LICENSE",
    "README.md"
  ],
  "engines": {
    "node": ">=18"
  },
  "keywords": ["apt", "debian", "cloudflare", "workers", "r2", "cli"]
}
EOF

cat > "$STAGE/README.md" <<'EOF'
# workerapt-upload

CLI for uploading `.deb` packages to a [workerapt](https://github.com/) APT
repository running on Cloudflare Workers + R2.

## Usage

```sh
npx workerapt-upload --help
```

See `workerapt-upload --help` for the `pool` / `publish` subcommands and flags.
EOF

echo "Staged package at: $STAGE"
( cd "$STAGE" && npm pack --dry-run )

PUBLISH_ARGS=()
[[ -n "$TAG" ]] && PUBLISH_ARGS+=(--tag "$TAG")
[[ "$DRY_RUN" -eq 1 ]] && PUBLISH_ARGS+=(--dry-run)

echo
echo "Running: npm publish ${PUBLISH_ARGS[*]:-}"
( cd "$STAGE" && npm publish ${PUBLISH_ARGS[@]+"${PUBLISH_ARGS[@]}"} )

if [[ "$DRY_RUN" -eq 1 ]]; then
	echo "Dry run complete (nothing was published)."
else
	echo "Published workerapt-upload@$VERSION"
fi
