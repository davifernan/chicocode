# T3 Code — Remote Server Setup Guide

This guide is for **server admins** who want to run T3 Code on a remote machine so that other users can connect to it from their local T3 desktop or browser.

> **What this enables:** A user opens T3 Code locally, enters your server details in Settings → Remote Host, and T3 automatically creates a secure SSH tunnel to your server. Their local threads are synced to the server and the app switches to remote mode — all without a page reload.

---

## How it works

```
User's Machine                          Your Server
┌─────────────────────┐                ┌──────────────────────┐
│  T3 Code (browser)  │                │  T3 Code Server      │
│                     │  SSH Tunnel    │  port 3773           │
│  appTransport ──────┼──────────────► │  Codex / OpenCode    │
│  (via tunnel)       │                │  Threads, Sessions   │
│                     │                │  Event Store         │
└─────────────────────┘                └──────────────────────┘
```

1. The user enters your SSH connection details in T3 Settings → Remote Host.
2. T3 opens an SSH tunnel from their machine: `localhost:random_port → your_server:3773`.
3. Local threads are synced to the remote server (event-log push, idempotent).
4. The app transport switches seamlessly — all new sessions run on your server.

No port forwarding required. No VPN required. Just SSH access.

---

## Server Requirements

| Requirement                             | Notes                                                                 |
| --------------------------------------- | --------------------------------------------------------------------- |
| Linux / macOS                           | Tested on Ubuntu 22.04+, Debian 12+, macOS 13+                        |
| `bun` ≥ 1.1                             | [Install bun](https://bun.sh)                                         |
| `codex` CLI                             | [Install Codex](https://github.com/openai/codex) — must be authorized |
| SSH server (`sshd`)                     | Required for tunnel — installed by default on most servers            |
| SSH port open                           | Default port 22 inbound must be reachable from the user's machine     |
| T3 server port **NOT** exposed publicly | Port 3773 stays bound to `127.0.0.1` — only accessible via SSH tunnel |

---

## Step 1 — Install T3 Code on the server

```bash
# Install globally via npm/bun
npm install -g t3code@latest

# Or run directly without installing
npx t3code --help
```

Verify it works:

```bash
t3 --version
```

---

## Step 2 — Generate an auth token

The auth token protects your T3 server. Anyone with the token can control the Codex agent on your machine — treat it like a password.

```bash
TOKEN="$(openssl rand -hex 32)"
echo "Your token: $TOKEN"
```

Save this token — you'll need it for Step 3 and to share with users.

---

## Step 3 — Start the T3 server

T3 Code must listen on `127.0.0.1` (loopback only). The SSH tunnel handles all remote access — **do not bind to `0.0.0.0`**.

```bash
t3 serve \
  --host 127.0.0.1 \
  --port 3773 \
  --auth-token "$TOKEN" \
  --no-browser
```

Or with environment variables:

```bash
T3CODE_HOST=127.0.0.1 \
T3CODE_PORT=3773 \
T3CODE_AUTH_TOKEN="your-token-here" \
T3CODE_NO_BROWSER=true \
t3 serve
```

### Run as a persistent service (systemd)

Create `/etc/systemd/system/t3code.service`:

```ini
[Unit]
Description=T3 Code Server
After=network.target

[Service]
Type=simple
User=your_unix_user
WorkingDirectory=/home/your_unix_user
Environment="T3CODE_HOST=127.0.0.1"
Environment="T3CODE_PORT=3773"
Environment="T3CODE_AUTH_TOKEN=your-token-here"
Environment="T3CODE_NO_BROWSER=true"
# Make sure codex is on PATH:
Environment="PATH=/home/your_unix_user/.local/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=/usr/local/bin/t3 serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable t3code
sudo systemctl start t3code
sudo systemctl status t3code
```

---

## Step 4 — Verify the server is running

From the server itself:

```bash
curl http://127.0.0.1:3773/api/health
# Expected: {"ok":true} or similar
```

If the server requires an auth token, pass it:

```bash
curl -H "Authorization: Bearer your-token-here" http://127.0.0.1:3773/api/health
```

---

## Step 5 — Set up SSH access for users

Each user who will connect needs:

1. **SSH access** to the server (username + key or password)
2. **Their public key added** to `~/.ssh/authorized_keys` on the server

```bash
# On the server — add user's public key
echo "ssh-ed25519 AAAA...their-key... user@their-machine" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Test that the user can SSH in without a password:

```bash
# From the user's machine
ssh -i ~/.ssh/id_ed25519 your_user@your_server_ip "echo ok"
```

---

## What to give to users

Hand each user the following four values:

| Field          | Example                                  | Description                                            |
| -------------- | ---------------------------------------- | ------------------------------------------------------ |
| **Host**       | `203.0.113.42` or `myserver.example.com` | IP or hostname of your server                          |
| **SSH Port**   | `22`                                     | SSH port (default 22, change if you use a custom port) |
| **SSH User**   | `ubuntu`                                 | Unix username the user SSHs in as                      |
| **Auth Token** | `a3f9b2...`                              | The token you generated in Step 2                      |

The user also needs:

- Their **SSH private key path** (`~/.ssh/id_ed25519` by default) — this is on their own machine
- Their public key pre-authorized on your server (see Step 5)

### Sharing securely

- Send the **Host** and **SSH User** via any channel (not sensitive).
- Send the **Auth Token** via a secure channel (Signal, encrypted email, 1Password share, etc.).
- **Never** send the auth token in plaintext over email or Slack.

---

## User instructions (what to tell them)

Once you've shared the credentials, give users this brief:

> 1. Open T3 Code, go to **Settings → Remote Host**
> 2. Enter the values I sent you (Host, SSH Port, SSH User, Auth Token)
> 3. Set **SSH Key Path** to your local key: `~/.ssh/id_ed25519` (or wherever your key is)
> 4. Toggle **Enable Remote Mode** on
> 5. Click **Test Connection** — all four steps should show ✓
> 6. Click **Save & Connect**
> 7. T3 will sync your local chats and switch to the remote server automatically

---

## Troubleshooting

### `ssh-connect` step fails

- Check that the server hostname/IP is correct and reachable: `ping your_server_ip`
- Check that SSH port is open: `nc -zv your_server_ip 22`
- Check that the user's public key is in `~/.ssh/authorized_keys` on the server

### `port-test` step fails

- The T3 server is not running or not listening on port 3773
- Check: `sudo systemctl status t3code` or `ps aux | grep t3`
- Check: `curl http://127.0.0.1:3773/api/health` from the server itself

### `t3-handshake` step fails

- T3 is running but not responding correctly — check logs: `journalctl -u t3code -n 50`
- Version mismatch between client and server T3 — update both to the same version

### `auth` step fails (401 Unauthorized)

- Token mismatch — re-check that the user entered exactly the right token
- Token may have changed if you restarted the service with a new token

### Tunnel connects but app does not switch

- Check browser console for errors
- Try clicking Disconnect and Save & Connect again
- Ensure the user's local T3 version supports Remote Mode (requires this feature branch)

---

## Security notes

| Practice                               | Why                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| Bind T3 to `127.0.0.1` only            | Prevents direct internet access — tunnel is the only entry point               |
| Always set `--auth-token`              | Prevents unauthenticated WebSocket connections through the tunnel              |
| Use SSH key auth, not passwords        | Safer, no brute-force risk — disable `PasswordAuthentication` in `sshd_config` |
| Rotate auth token regularly            | `openssl rand -hex 32` and update the service + notify users                   |
| One user per SSH key                   | Easier to revoke individual access via `authorized_keys`                       |
| Consider `AllowUsers` in `sshd_config` | Limits SSH to only the T3 service account                                      |

### Revoking access

To revoke a user's access immediately:

```bash
# Remove their public key from authorized_keys
nano ~/.ssh/authorized_keys
# Delete the line with their key, save, done

# To also invalidate the auth token (affects ALL users):
# Update T3CODE_AUTH_TOKEN in the systemd service and restart
sudo systemctl restart t3code
```

---

## Full configuration reference

All options are available as CLI flags or environment variables:

| CLI flag       | Env var             | Default     | Description                                             |
| -------------- | ------------------- | ----------- | ------------------------------------------------------- |
| `--host`       | `T3CODE_HOST`       | `127.0.0.1` | Bind address — keep as `127.0.0.1` for remote setup     |
| `--port`       | `T3CODE_PORT`       | `3773`      | HTTP/WebSocket port                                     |
| `--auth-token` | `T3CODE_AUTH_TOKEN` | _(none)_    | Required — WebSocket auth token                         |
| `--no-browser` | `T3CODE_NO_BROWSER` | `false`     | Disable auto-open browser on start                      |
| `--state-dir`  | `T3CODE_STATE_DIR`  | `~/.t3`     | Directory for SQLite DB, keybindings, etc.              |
| `--mode`       | `T3CODE_MODE`       | `web`       | Runtime mode (`web` for server, `desktop` for Electron) |

---

## Architecture note

T3 Code uses **event sourcing**: all thread activity is stored as an immutable append-only event log in SQLite. When a user first connects, their local events are pushed to your server idempotently (duplicates are silently skipped via `event_id` uniqueness). This means:

- Re-connecting is safe — no data duplication
- Disconnecting mid-sync is safe — the next connect resumes from where it left off
- Multiple users can connect to the same server — each user has isolated threads

There is no shared-thread collaboration model yet. Each user's threads are independent.
