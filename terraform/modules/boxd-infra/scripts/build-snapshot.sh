#!/usr/bin/env bash
# Build the Open-Inspect boxd base snapshot through the boxd API.
# Mirrors terraform/modules/boat-infra/scripts/build-snapshot.sh.
#
# Delegates to packages/boxd-infra/build-template.py — the same script used
# for manual/local builds (single source of truth).
set -euo pipefail

if [[ -z "${BOXD_API_KEY:-}" ]]; then
  echo "Error: BOXD_API_KEY is not set (required to build and verify the snapshot)" >&2
  exit 1
fi
if [[ -z "${BOXD_BASE_SNAPSHOT:-}" ]]; then
  echo "Error: BOXD_BASE_SNAPSHOT is not set" >&2
  exit 1
fi

echo "Building boxd snapshot: ${OPENINSPECT_IMAGE_CANDIDATE:-$BOXD_BASE_SNAPSHOT}"
echo "Deploy path: ${DEPLOY_PATH}"

cd "${DEPLOY_PATH}" || {
  echo "Error: failed to cd to ${DEPLOY_PATH}" >&2
  exit 1
}

# The builder uses the boxd Python SDK, pinned in uv.lock.
if ! command -v uv >/dev/null 2>&1; then
  echo "Error: uv is required to build the boxd snapshot. Install uv, then run 'cd ${DEPLOY_PATH} && uv sync --frozen'." >&2
  exit 1
fi

uv sync --frozen
uv run --frozen python build-template.py

echo "boxd snapshot ${OPENINSPECT_IMAGE_CANDIDATE:-$BOXD_BASE_SNAPSHOT} built successfully"
