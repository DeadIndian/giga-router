#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [ "$(id -u)" -ne 0 ]; then
  echo 'Run this script with sudo to enable Docker at boot and rebuild the app.' >&2
  exit 1
fi

systemctl enable --now docker
docker compose config --quiet

snapshot_script='const fs=require("fs"),crypto=require("crypto");const p="/app/data/config.json";if(!fs.existsSync(p)){console.log("none");process.exit(0)}const c=JSON.parse(fs.readFileSync(p));const a="/app/data/admin-auth.json";const stable={providers:c.providers,activeId:c.activeId,routing:c.routing,mcpServers:c.mcpServers,skills:c.skills,accessKeys:c.accessKeys,account:fs.existsSync(a)?fs.readFileSync(a,"utf8"):null};console.log(crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex"))'
previous_container=$(docker compose ps -q llmrouter)
before='none'
if [ -n "$previous_container" ]; then
  before=$(docker exec "$previous_container" node -e "$snapshot_script")
  docker exec "$previous_container" node -e 'const fs=require("fs");for(const name of ["config","admin-auth"]){const p="/app/data/"+name+".json";if(fs.existsSync(p)){const backup="/app/data/"+name+".pre-deployment.json";fs.copyFileSync(p,backup);fs.chmodSync(backup,0o600)}}'
fi

docker compose up -d --build --wait --wait-timeout 120 llmrouter
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
