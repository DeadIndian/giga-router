#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [ "$(id -u)" -ne 0 ]; then
  echo 'Run this script with sudo to enable Docker at boot and rebuild the app.' >&2
  exit 1
fi

systemctl enable --now docker
docker compose config --quiet
snapshot_script=$(cat scripts/config-fingerprint.cjs)
previous_container=$(docker compose ps -q llmrouter)
before='none'
if [ -n "$previous_container" ]; then
  previous_image=$(docker inspect "$previous_container" --format '{{.Image}}')
  # A running container can outlive its image metadata. Rollback is optional;
  # saved-data backup and verification below must still run if tagging fails.
  # Tag before building so replacing the Compose image cannot lose the old tag.
  if docker image inspect "$previous_image" >/dev/null 2>&1 && docker image tag "$previous_image" giga-router:previous; then
    echo 'Previous image saved as giga-router:previous.'
  else
    echo 'Previous image could not be saved for rollback; continuing with data backup. An existing giga-router:previous tag may be older.' >&2
  fi
fi

# Build while the current container keeps serving. A failed build leaves it running.
docker compose build llmrouter

if [ -n "$previous_container" ]; then
  before=$(docker exec "$previous_container" node -e "$snapshot_script")
  docker exec "$previous_container" node -e 'const fs=require("fs");for(const name of ["config","admin-auth"]){const p="/app/data/"+name+".json";if(fs.existsSync(p)){const backup="/app/data/"+name+".pre-deployment.json";fs.copyFileSync(p,backup);fs.chmodSync(backup,0o600)}}'
  docker exec "$previous_container" node -e 'const fs=require("fs"),path=require("path");const dest="/app/data/backups/credentials-"+Date.now();for(const name of ["mcp-credentials.key","mcp-credentials"]){const p=path.join("/app/data",name);if(fs.existsSync(p)){fs.mkdirSync(dest,{recursive:true,mode:0o700});fs.cpSync(p,path.join(dest,name),{recursive:true})}}'
fi

docker compose up -d --no-build --wait --wait-timeout 120 llmrouter
container=$(docker compose ps -q llmrouter)
after=$(docker exec "$container" node -e "$snapshot_script")
if [ "$before" != 'none' ] && [ "$before" != "$after" ]; then
  echo 'Saved configuration changed during deployment. Review config.pre-deployment.json in the data volume.' >&2
  exit 1
fi
docker exec "$container" node -e 'fetch("http://127.0.0.1:3002/api/ping").then(r=>{if(!r.ok)throw Error("Health check failed");console.log("Giga Router responds on port 3002.")}).catch(e=>{console.error(e.message);process.exit(1)})'
docker inspect "$container" --format 'Status: {{.State.Status}} / {{.State.Health.Status}}; restart: {{.HostConfig.RestartPolicy.Name}}'
docker compose port llmrouter 3002
echo 'Docker is enabled at boot. Saved configuration is preserved.'
