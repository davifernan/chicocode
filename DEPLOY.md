# T3 Code — Remote Server Deployment Guide

Target URL: `code.nilo.live`  
Stack: Ubuntu/Debian · Bun · Nginx · Cloudflare · systemd

> **Why systemd and not Docker?**  
> T3 Code runs Codex as a subprocess. Codex needs access to your real server filesystem
> and your installed tooling (git, node, python, etc.). Running natively via systemd gives
> Codex full access to the server environment — Docker isolation would break this.

---

## Prerequisites

```bash
# 1. Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc   # or restart shell

# 2. Verify Node.js >= 20
node --version   # must be >= 20

# 3. Install Codex CLI (T3 Code spawns this as a subprocess)
npm install -g @openai/codex

# 4. git
git --version
```

---

## 1. Clone & Build

```bash
git clone https://github.com/davifernan/chicocode.git /opt/t3code
cd /opt/t3code

bun install
bun run build
```

After the build, the server artifact is at `apps/server/dist/index.mjs`  
and the web bundle is embedded at `apps/server/dist/client/`.

---

## 2. Environment & Auth Token

```bash
openssl rand -hex 32
# → copy this value as your auth token
```

```bash
sudo mkdir -p /etc/t3code
sudo tee /etc/t3code/env > /dev/null <<EOF
T3CODE_HOST=127.0.0.1
T3CODE_PORT=3773
T3CODE_AUTH_TOKEN=<your-token>
T3CODE_MODE=web
T3CODE_NO_BROWSER=true
T3CODE_STATE_DIR=/var/lib/t3code
OPENAI_API_KEY=<your-openai-key>
EOF

sudo chmod 600 /etc/t3code/env
```

Create the state directory and a dedicated system user:

```bash
sudo useradd -r -m -s /bin/bash t3code
sudo mkdir -p /var/lib/t3code
sudo chown t3code:t3code /var/lib/t3code
sudo chown -R t3code:t3code /opt/t3code

# Install Bun for the t3code user
sudo -u t3code bash -c 'curl -fsSL https://bun.sh/install | bash'

# Install Codex for the t3code user
sudo -u t3code bash -c 'npm install -g @openai/codex'
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
ExecStart=/home/t3code/.bun/bin/bun run /opt/t3code/apps/server/dist/index.mjs \
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

sudo systemctl status t3code
```

Logs:

```bash
journalctl -u t3code -f
```

---

## 4. Nginx Config

T3 Code serves HTTP **and** WebSocket on the same port.  
The `Upgrade`/`Connection` headers are **required** — without them WebSocket breaks.

```bash
sudo tee /etc/nginx/sites-available/t3code > /dev/null <<'EOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name code.nilo.live;

    # SSL cert — use a Cloudflare Origin Certificate (see step 5)
    ssl_certificate     /etc/ssl/cloudflare/code.nilo.live.crt;
    ssl_certificate_key /etc/ssl/cloudflare/code.nilo.live.key;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers   HIGH:!aNULL:!MD5;

    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;

    location / {
        proxy_pass         http://127.0.0.1:3773;
        proxy_http_version 1.1;

        # WebSocket upgrade — do NOT remove these two lines
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Keep long-lived WS connections alive
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}

server {
    listen 80;
    server_name code.nilo.live;
    return 301 https://$host$request_uri;
}
EOF

sudo ln -s /etc/nginx/sites-available/t3code /etc/nginx/sites-enabled/t3code
sudo nginx -t && sudo systemctl reload nginx
```

---

## 5. SSL Certificate (Cloudflare Origin Cert)

In the Cloudflare dashboard:

1. **SSL/TLS → Origin Server → Create Certificate**
2. Hostname: `code.nilo.live`, validity: 15 years
3. Download `.crt` and `.key`, then on the server:

```bash
sudo mkdir -p /etc/ssl/cloudflare
sudo nano /etc/ssl/cloudflare/code.nilo.live.crt   # paste cert
sudo nano /etc/ssl/cloudflare/code.nilo.live.key   # paste key
sudo chmod 600 /etc/ssl/cloudflare/code.nilo.live.key
```

---

## 6. Cloudflare DNS & Proxy Settings

| Setting             | Value                                                      |
| ------------------- | ---------------------------------------------------------- |
| DNS A Record        | `code.nilo.live → <SERVER_IP>` · Proxied (orange cloud ON) |
| SSL/TLS Mode        | **Full (strict)**                                          |
| WebSockets          | **On** — Network → WebSockets                              |
| Minimum TLS Version | TLS 1.2                                                    |

> **WebSockets must be ON.** Without it the UI loads but immediately disconnects.

---

## 7. Firewall

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 3773/tcp   # internal only
sudo ufw enable
```

---

## 8. Connecting from the T3 Code UI

1. Open `https://code.nilo.live` in your browser
2. Go to **Settings → Remote Host**
3. Enter:
   - **Host:** `code.nilo.live`
   - **Port:** `443`
   - **Auth Token:** _(the token from step 2)_
   - **Use TLS:** on
4. Click **Connect**

---

## 9. Updates

```bash
cd /opt/t3code
git pull
bun install
bun run build
sudo systemctl restart t3code
```

---

## Troubleshooting

| Symptom                               | Fix                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------- |
| UI loads but WS disconnects instantly | Cloudflare **WebSockets is OFF** — enable under Network → WebSockets   |
| `401` on WS connection                | Token mismatch — check `/etc/t3code/env` vs UI input                   |
| 502 Bad Gateway                       | Service not running — `systemctl status t3code`                        |
| Blank page                            | Nginx missing `Upgrade`/`Connection` headers                           |
| `codex: command not found`            | Install for t3code user: `sudo -u t3code npm install -g @openai/codex` |

---

## Quick Health Check

```bash
systemctl is-active t3code        # → active
ss -tlnp | grep 3773              # → port bound
curl -I https://code.nilo.live    # → 200
journalctl -u t3code --since "5 min ago"
```
