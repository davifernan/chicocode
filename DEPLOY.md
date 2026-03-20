# T3 Code — Remote Server Deployment Guide

Target URL: `code.nilo.live`  
Stack: Ubuntu/Debian · Bun · Nginx · Cloudflare · systemd

---

## Prerequisites

```bash
# 1. Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc   # or restart shell

# 2. Verify Node.js >= 20 (needed by the built artifact)
node --version     # must be >= 20

# 3. Install Codex CLI (required — T3 Code wraps it)
npm install -g @openai/codex

# 4. Confirm git is installed
git --version
```

---

## 1. Clone & Build

```bash
# Pick a directory, e.g. /opt/t3code
git clone https://github.com/<YOUR_FORK_OR_REPO>/t3code.git /opt/t3code
cd /opt/t3code

# Install dependencies
bun install

# Build everything (server + web bundle)
bun run build
```

After `bun run build`, the server artifact is at `apps/server/dist/index.mjs`  
and the web bundle is embedded at `apps/server/dist/client/`.

---

## 2. Environment & Auth Token

Generate a strong random token:

```bash
openssl rand -hex 32
# example output: a3f8c2...
```

Create the environment file:

```bash
sudo mkdir -p /etc/t3code
sudo tee /etc/t3code/env > /dev/null <<EOF
T3CODE_HOST=127.0.0.1
T3CODE_PORT=3773
T3CODE_AUTH_TOKEN=<PASTE_YOUR_TOKEN_HERE>
T3CODE_MODE=web
T3CODE_NO_BROWSER=true
T3CODE_STATE_DIR=/var/lib/t3code
OPENAI_API_KEY=<YOUR_OPENAI_KEY>
EOF

sudo chmod 600 /etc/t3code/env
```

Create the state directory:

```bash
sudo mkdir -p /var/lib/t3code
# If running as a dedicated user (recommended):
sudo useradd -r -s /bin/false t3code
sudo chown t3code:t3code /var/lib/t3code
```

---

## 3. systemd Service

```bash
sudo tee /etc/systemd/system/t3code.service > /dev/null <<'EOF'
[Unit]
Description=T3 Code Server
After=network.target

[Service]
Type=simple
User=t3code
WorkingDirectory=/opt/t3code
EnvironmentFile=/etc/t3code/env
ExecStart=/root/.bun/bin/bun run /opt/t3code/apps/server/dist/index.mjs \
  --host 127.0.0.1 \
  --port 3773 \
  --no-browser
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable t3code
sudo systemctl start t3code

# Verify it's running
sudo systemctl status t3code
# Should show: Active: active (running)
```

Check logs:

```bash
journalctl -u t3code -f
```

---

## 4. Nginx Config

T3 Code uses HTTP **and** WebSocket on the same port.  
Nginx must proxy both, including the WS upgrade headers.

```bash
sudo tee /etc/nginx/sites-available/t3code > /dev/null <<'EOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name code.nilo.live;

    # SSL certs — Cloudflare Origin Certificate recommended
    ssl_certificate     /etc/ssl/cloudflare/code.nilo.live.crt;
    ssl_certificate_key /etc/ssl/cloudflare/code.nilo.live.key;

    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # Security headers
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;

    location / {
        proxy_pass         http://127.0.0.1:3773;
        proxy_http_version 1.1;

        # WebSocket upgrade (CRITICAL — do not remove)
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection $connection_upgrade;

        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Keep WS connections alive
        proxy_read_timeout  86400;
        proxy_send_timeout  86400;
    }
}

server {
    listen 80;
    server_name code.nilo.live;
    return 301 https://$host$request_uri;
}
EOF

sudo ln -s /etc/nginx/sites-available/t3code /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### SSL Certificate (Cloudflare Origin Cert)

In the Cloudflare dashboard:
- **SSL/TLS → Origin Server → Create Certificate**
- Select `code.nilo.live`, validity 15 years
- Download `.crt` and `.key`
- Save to `/etc/ssl/cloudflare/` on the server

---

## 5. Cloudflare DNS & Proxy Settings

| Setting | Value |
|---|---|
| DNS A Record | `code.nilo.live → <SERVER_IP>` (Proxied = orange cloud ON) |
| SSL/TLS Mode | **Full (strict)** |
| WebSockets | **On** (Network → WebSockets) |
| Minimum TLS | TLS 1.2 |

> **WebSockets must be ON** — T3 Code requires a persistent WS connection.  
> Without it, the UI will connect but immediately disconnect.

---

## 6. Firewall

Only expose 80/443 to the internet. Block 3773 externally:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 22/tcp    # SSH
sudo ufw deny 3773/tcp   # T3 Code internal only
sudo ufw enable
```

---

## 7. Connecting from T3 Code UI

Once the server is running at `https://code.nilo.live`:

1. Open T3 Code in your browser
2. Click the **connection indicator** in the sidebar (bottom left)
3. Or go to **Settings → Remote Host**
4. Enter:
   - **Host:** `code.nilo.live`
   - **Port:** `443`
   - **Auth Token:** `<the token from step 2>`
   - **Use TLS:** `on`
5. Click **Connect**

---

## 8. Updates

```bash
cd /opt/t3code
git pull
bun install
bun run build
sudo systemctl restart t3code
```

---

## Troubleshooting

| Symptom | Check |
|---|---|
| UI loads but WS disconnects immediately | Cloudflare WebSockets OFF — enable it |
| `401` on WS connection | Token mismatch — check `/etc/t3code/env` vs UI input |
| Blank page / 502 | systemd service not running — `systemctl status t3code` |
| WS works on HTTP, broken on HTTPS | Nginx missing `Upgrade`/`Connection` headers |
| `codex` not found | `npm install -g @openai/codex` not done or not in PATH for t3code user |

---

## Quick Health Check

```bash
# Service running?
systemctl is-active t3code

# Port bound?
ss -tlnp | grep 3773

# HTTPS reachable?
curl -I https://code.nilo.live

# Logs
journalctl -u t3code --since "5 min ago"
```
