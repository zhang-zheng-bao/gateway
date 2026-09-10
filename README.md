# LZGO Gateway

Independent TLS-terminating reverse proxy for the two sites on the Tencent Cloud
Windows box. It replaces the gateway logic that used to be embedded inside the
luzhougo process.

## Why this exists

Before the split, `luzhougo.cn` ran on ports **80 + 443** and its `server/index.ts`
did double duty: it served the site *and* acted as the entry point for
`zhengbao.work` (TLS termination + reverse proxy). That coupling meant:

- Restarting luzhougo briefly took `zhengbao.work` down with it.
- Adding a new site required editing business code.
- Port 443 could only ever be owned by one of the two apps.

Now 443/80 belong to this gateway only. Each site is a plain HTTP app on a local
port, and routing is pure configuration.

## Architecture

```
                        Internet
                            |
              +-------------+-------------+
              |   gateway  (80, 443)      |   TLS termination + SNI
              |   C:\deploy-gateway       |
              +-------------+-------------+
                            |
                 Host-based routing (ROUTES)
                    /                  \
        luzhougo.cn:3001          zhengbao.work:3002
        (庐州GO site + API)         (我的空间 portfolio)
```

| Site | Domain | Local port | Server directory |
|---|---|---|---|
| 庐州GO | luzhougo.cn | 3001 | `C:\deploy-package` |
| 我的空间 | zhengbao.work | 3002 | `C:\deploy-zhengbao` |
| Gateway | — | 80, 443 | `C:\deploy-gateway` |

Each site also registers its own `www.` alias automatically.

## Configuration

All configuration is environment-driven, read from `.env` (git-ignored):

```ini
HTTP_PORT=80
HTTPS_PORT=443
CERT_DIR=certs
ROUTES=luzhougo.cn:3001,zhengbao.work:3002
DEFAULT_PORT=
```

- **`ROUTES`** — comma-separated `domain:localport` pairs. This is the entire
  routing table. Adding a site is a one-line change plus a certificate
  directory; no code changes and no restart of the other sites.
- **`DEFAULT_PORT`** — optional catch-all for unmatched hosts. Leave empty so
  unknown hosts get an explicit 404 rather than leaking traffic to a backend.
- **`CERT_DIR`** — relative to the project root, or absolute.

### Certificates

Certificates are stored **only here** — the two sites no longer hold their own
copies. Layout mirrors the Tencent Cloud naming so files can be dropped in
unchanged:

```
certs/
├── luzhougo.cn_tomcat/
│   ├── cert.pem        <- full chain (3 blocks)
│   └── key.pem
└── zhengbao.work_tomcat/
    ├── cert.pem
    └── key.pem
```

The directory name minus the `_tomcat` suffix becomes the SNI hostname. PEM is
preferred over PFX (the Tencent PEM is a complete chain); a `.pfx` in the same
directory is used only as a fallback via `keystorePass.txt`.

`certs/` is **git-ignored** — certificates never enter the repository.

> **Watch out when copying certificates in.** Before the split, the live
> certificates were kept in `C:\deploy-package\server\<domain>_tomcat\` (the
> embedded gateway read them from there). The copy under
> `C:\deploy-zhengbao\zhengbao.work_tomcat\` is **stale** and holds the old
> June certificate. Always confirm a certificate's expiry after copying:
>
> ```bash
> openssl x509 -in certs/<domain>_tomcat/cert.pem -noout -enddate
> ```
>
> Both domains should report **Dec 9 2026**.

Renewal is a manual step: download the new Nginx-format bundle from the Tencent
Cloud console and replace these files, then restart the gateway. See the renewal
note below.

### Health endpoint

```
GET http://localhost/__gateway/health
```

Returns the loaded route table and uptime. Deliberately served over plain HTTP so
it can be polled without certificate validation. Actions and monitoring use it.

## Running

```powershell
.\run-deploy-server.ps1 -Start        # start in background
.\run-deploy-server.ps1 -Stop         # stop
.\run-deploy-server.ps1 -Restart      # restart
.\run-deploy-server.ps1 -Status       # status + route table + health
.\run-deploy-server.ps1 -Foreground   # run attached, for debugging
```

In production the process is owned by the scheduled task **`Gateway-App`**
(SYSTEM, runs at boot) so it survives SSH disconnects. Always start it through
the task, never by launching node directly in an SSH session:

```powershell
schtasks /run /tn "Gateway-App"
```

## Deployment

Pushing to `main` triggers the self-hosted Actions runner (`gw-win`) which
fetches, builds, verifies certificates are present, restarts the scheduled task,
and polls until 443/80 are listening.

`git reset --hard` is safe here: `.env`, `certs/`, `node_modules/`, and `logs/`
are all git-ignored.

### Two hard-won constraints

1. **The workflow body must be pure ASCII.** The Windows runner writes the step
   script to a temp `.ps1` and reads it back using the system ANSI code page
   (GBK). Non-ASCII characters get mangled and produce misleading parser errors
   like `TerminatorExpectedAtEndOfString`. Comments are in English on purpose.
2. **Use `shell: powershell`, not `pwsh`.** The server only has Windows
   PowerShell 5.1.

## Maintenance notes

- **Restart ordering.** The gateway is the single entry point: while it is down,
  *both* sites are unreachable. Deploys of the two sites do not touch it, but
  gateway deploys cause a short interruption for everything.
- **Certificate renewal.** Certificates expire 2026-12-09. Renew by downloading
  the new bundle from the Tencent Cloud console, replacing the files under
  `certs/`, and restarting. The full chain (3 blocks) must be preserved.
- **Port 80** is not currently open in the cloud security group, so plain-HTTP
  access from the internet does not work. This only affects the local health
  check and any future HTTP-to-HTTPS redirect.
