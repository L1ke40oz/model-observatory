#!/usr/bin/env bash
# Install a copy at /usr/local/bin/model-observatory-deploy for the restricted SSH key.
set -euo pipefail
export GIT_TERMINAL_PROMPT=0

observatory_dir=/opt/model-observatory
revision="${SSH_ORIGINAL_COMMAND:-${1:-}}"
if [[ ! "$revision" =~ ^[a-f0-9]{40}$ ]]; then
  echo 'Expected exactly one Git commit SHA.' >&2
  exit 64
fi

for required in git docker curl flock; do
  command -v "$required" >/dev/null || { echo "Missing command: $required" >&2; exit 1; }
done
cd "$observatory_dir"
# Serialize both Actions deployments and manual invocations on the VPS.
exec 9> .git/model-observatory-deploy.lock
flock -w 600 9

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo 'Tracked files were modified on the VPS. Save those changes before deploying.' >&2
  exit 1
fi
git fetch --no-tags origin main
if [[ "$revision" != "$(git rev-parse refs/remotes/origin/main)" ]]; then
  echo 'Deployment superseded: this commit is no longer the main branch head.'
  exit 0
fi
git merge --ff-only "$revision"
docker compose config --quiet

previous_container="$(docker compose ps --quiet stella)"
previous_image=''
if [[ -n "$previous_container" ]]; then
  previous_image="$(docker inspect --format '{{.Image}}' "$previous_container")"
  if [[ "$previous_image" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    docker image tag "$previous_image" model-observatory-rollback:previous
  fi
fi

# Build first; a build failure leaves the running service in place.
docker compose build stella
if docker compose up -d --no-build --wait --wait-timeout 90 stella; then
  if curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8787/api/health; then
    printf '\nDeployed %s\n' "$revision"
    exit 0
  fi
fi

echo 'Deployment health check failed.' >&2
docker compose logs --tail=50 stella || true
if [[ "$previous_image" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  rollback_file="$(mktemp)"
  trap 'rm -f "$rollback_file"' EXIT
  printf 'services:\n  stella:\n    image: model-observatory-rollback:previous\n    pull_policy: never\n' > "$rollback_file"
  if docker compose -f compose.yaml -f "$rollback_file" up -d --no-build --wait --wait-timeout 90 stella; then
    echo 'Previous container image restored; application source remains at the requested commit.' >&2
  else
    echo 'Automatic recovery failed. Inspect docker compose logs on the VPS.' >&2
  fi
fi
exit 1
