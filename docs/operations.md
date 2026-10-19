# Production updates

The daily-use production dashboard and gateway run at **http://localhost:3002**.
Development and tests must use a temporary `DATA_DIR` and an ephemeral loopback
port. Never test account creation, password changes, imports, or routing changes
on production.

## Standard update

Run these commands in a host terminal after the new commit passes
[CI](https://github.com/DeadIndian/giga-router/actions/workflows/ci.yml):

```bash
cd /home/dead/giga-router
git status --short
git pull --ff-only
sudo ./scripts/deploy-local.sh
```

If `git status` shows local changes, preserve or commit them before pulling;
do not discard them. The deployment script:

1. Enables Docker at boot and validates Compose configuration.
2. Builds the image while the previous container continues serving. Build
   failure leaves that container running.
3. Tags the running image `giga-router:previous` for rollback, takes a configuration
   fingerprint, and backs up `config.json` and `admin-auth.json` inside the volume
   with mode 0600. Each deployment replaces these two recovery copies.
4. Recreates only the router with the new image, waits for health, and verifies
   port 3002, restart policy, and the saved account/configuration fingerprint.

There is a brief interruption during container recreation. Requests and streams
in flight may disconnect; clients should retry. The router is normally ready
within seconds; the script allows up to 120 seconds for health checks. Avoid
dashboard edits while it takes the fingerprint and recreates the container.

The script does not pull Git commits itself. Repeat the commands above for each
update. A Git push alone does not update this local Docker service.

## Data and deployment identity

Keep these identities stable even if source folders or branding change:

| Setting | Value |
| --- | --- |
| Source directory | `/home/dead/giga-router` |
| Origin | `git@github.com:DeadIndian/giga-router.git` |
| Compose project / service | `llmrouter` / `llmrouter` |
| Container | `llmrouter-llmrouter-1` |
| Data volume | `llmrouter_llmrouter-data` (unless explicitly overridden) |
| Mount | `/app/data` |
| Port | `3002` |
| Restart policy | `unless-stopped` |

Preserve `.env`, the full data volume, provider/API keys, routing schedules,
gateway keys, MCP connections, saved skills, and `admin-auth.json` (dashboard
password). Preserve the vault encryption key in the data volume as well; losing
it makes encrypted MCP credentials unreadable. Keep backups private.

Do not run `docker compose down -v`, delete/prune the data volume, reset the
configuration, or restart the Docker daemon to update this app. Other apps,
including FreeLLMAPI on port 3001, should stay running. Automatic restart is
enabled; a manual `docker compose stop` leaves it stopped until started again.

## Check an update

```bash
sudo docker compose ps
curl --max-time 10 --fail http://127.0.0.1:3002/api/ping
sudo docker compose logs --tail 50 llmrouter
```

Sign in to confirm your accounts, selected provider, schedules, and MCP settings
remain. The script checks these saved values without printing credentials. Do
not publish logs or backups that include private upstream error content.

## Full backup before an upgrade

The script's two JSON copies are a quick recovery aid, not a full backup. For
a consistent full backup, briefly stop only this service, archive its volume,
then start it again. From the repository, run:

```bash
backup_dir="$HOME/giga-router-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
cp .env "$backup_dir/env"
chmod 600 "$backup_dir/env"
(
  set -e
  sudo docker compose stop llmrouter
  trap 'sudo docker compose start llmrouter' EXIT
  sudo docker compose run --rm --no-deps -T llmrouter tar -C /app/data -czf - . > "$backup_dir/data.tar.gz"
)
chmod 600 "$backup_dir/data.tar.gz"
```

Always start the router again even if archiving fails. This backup includes
plaintext provider API keys, password hashes, and encrypted MCP credentials;
store it securely outside Git. Use the deployment helper for the upgrade after
the router is running again.

## Roll back code

The previous successful container image remains tagged after an update. Keep
the current `.env` and volume. Create a temporary Compose override in this
repository:

```bash
cat > /tmp/giga-router-rollback.yml <<'YAML'
services:
  llmrouter:
    image: giga-router:previous
YAML
sudo docker compose -f docker-compose.yml -f /tmp/giga-router-rollback.yml up -d --no-build --wait --wait-timeout 120 llmrouter
curl --max-time 10 --fail http://127.0.0.1:3002/api/ping
```

This rolls back code using the same volume. Do not restore configuration backups
unless configuration actually needs recovery; restoration would discard edits
made since the backup. For future schema migrations, review compatibility before
running an older image. The next normal deployment rebuilds from the checkout.

## Agent sessions

[AGENTS.md](../AGENTS.md) applies to every agent working in this repository.
When a tool sandbox blocks Docker or sudo, finish code/tests/documentation and
push authorized changes. Report the exact host-terminal update command and the
deployment limitation; do not claim the live app was updated.
