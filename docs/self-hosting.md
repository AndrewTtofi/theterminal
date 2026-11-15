# Self-hosting

This page describes how to run The Terminal on a server, so a team can reach one workspace over the network. The server image is Linux, runs headless (no window, no desktop app) and has remote access switched on. For what people can do once they are in, see [Collaboration](collaboration.md).

You need Docker on the server. If you only want to share a workspace on your own network, you do not need Docker: see "Without Docker" below.

## Start it

The image is `ghcr.io/<org>/theterminal` (replace `<org>` with the account that publishes the image you use, or build it yourself from the `Dockerfile` in this repository with `docker build -t theterminal-server .`).

```sh
docker run -d --name theterminal \
  -p 4318:4318 \
  -v theterminal-data:/data \
  -v theterminal-key:/key \
  ghcr.io/<org>/theterminal
```

This starts a server on port 4318 with a self-signed certificate. For a name and a trusted certificate (usually what you want for a team), see "A trusted certificate" below.

Then read the log:

```sh
docker logs theterminal
```

It prints one line, `Open this link once to claim the Owner identity:`, followed by a link. That link is how you become the Owner.

### The bootstrap link

- **It is the Owner's invitation.** Open it in a browser, check the fingerprint in it (see [Collaboration](collaboration.md#the-fingerprint-in-the-link): it is in the link after `#fp=`, and the server's log is a channel only you can read), type your name and create a passkey or a key. You are the Owner from then on. Add a second credential straight away, for example on another device.
- **It lives one hour.** After that it is dead and you need a new one.
- **A restart before the Owner has joined replaces it.** Every start, until the Owner has joined, revokes older bootstrap links and prints a new one. A link in an old log is dead.
- **It is also in `/data/bootstrap-invite`,** a file only the server's user can read, for when you keep the log out of reach: `docker exec theterminal cat /data/bootstrap-invite`. The file is removed as soon as the Owner has joined, and on every start after.
- **It is the only time The Terminal prints a secret.** The log never holds a session token, a key, or any other value that could sign someone in. Once the Owner has joined, the log holds no link at all.
- **The link names the address the server can see for itself.** In Docker with `-p`, that is the address on Docker's own bridge network, which nobody outside can reach. Add `--remote-domain NAME` (see below) so the link names the address people actually use, or replace the address in the link yourself, keeping the rest unchanged.

## A trusted certificate

With a domain, Let's Encrypt gives the server a certificate every browser trusts, and people see no warning. You need:

- a domain name, such as `workspace.example.com`, with a DNS **A record** pointing at the server;
- **ports 80 and 443** of the server reachable from the internet. Port 80 is for Let's Encrypt's check that you control the domain (HTTP-01). Port 443 is for people.

```sh
docker run -d --name theterminal \
  -p 443:443 -p 80:80 \
  -v theterminal-data:/data \
  -v theterminal-key:/key \
  --health-cmd "node /app/packages/core/dist/healthcheck.js 443" \
  ghcr.io/<org>/theterminal \
  --remote-port 443 --remote-domain workspace.example.com --remote-tls acme
```

Everything after the image name is passed to The Terminal. A few things follow:

- **`--remote-port 443`** makes the link and the redirect from port 80 name the plain `https://workspace.example.com` address. Without it the server listens on 4318, and the link carries `:4318`.
- **`--health-cmd`.** The image's health check asks port 4318. When you change the port, give Docker a health check for the port you chose, as above.
- **Ports.** Port 80 needs no special permission inside Docker as it is usually set up: the container may bind any port, and Docker maps it. Rootless Docker and Podman are different: the container runs as your user, and Linux stops a normal user from listening below port 1024, so `-p 80:80` fails until you allow it (`sysctl net.ipv4.ip_unprivileged_port_start=80`, or map the port on the host side) or run as root. Outside Docker, on Linux, the same limit applies: `theterminal start --remote --remote-tls acme` as a normal user fails there. Run it in Docker, or grant the program the right to bind low ports.
- **The first start can take up to 3 minutes** while the certificate is issued. A failure (a wrong DNS record, port 80 not reachable) stops the start with a short reason.
- **Let's Encrypt's subscriber agreement** is accepted on your behalf when you choose `acme`.
- **Renewal is automatic.** The certificate is checked twice a day and renewed with 30 days left. Port 80 stays open for that. The certificate chain is stored in `/data/remote/`; its keys are in the secret store.
- **Proxies.** If the server reaches the internet through a proxy, set `HTTPS_PROXY` (and `NO_PROXY` for anything that must skip it) in the container with `-e`. They are used for the certificate order. Let's Encrypt still connects to your port 80 itself.
- **Hairpin NAT.** If the server is behind a router, opening your own domain from inside your own network may fail while it works from outside. Many routers do not loop traffic for their own public address back in. Test from a phone on mobile data.

To keep a self-signed certificate (a small team on a private network, no domain), leave the flags out. The link then carries the certificate's fingerprint, and each person compares it with their browser's certificate details once, as described in [Collaboration](collaboration.md#the-fingerprint-in-the-link). Browsers warn about a self-signed certificate until you click through.

To use a certificate you already have, pass `--remote-tls provided --tls-cert FILE --tls-key FILE` with the files mounted into the container, and `--remote-domain NAME` to match it.

## What the two volumes hold

| Volume | Holds |
|---|---|
| `/data` | The ledger and database, projects and their working copies, `secrets.enc.json` (the encrypted secrets), `remote/` (the certificate and its settings), `bootstrap-invite` while there is one |
| `/key` | `secret.key`: the 32-byte key that opens `secrets.enc.json` |

**Why two volumes.** `secrets.enc.json` holds your connections' secrets, encrypted with AES-256-GCM. The key that decrypts it must not travel with it: a backup of `/data` alone should never be able to decrypt anything. The server refuses to start if the key file is inside the data folder.

- **Back up `/data`** as you would any database, and **keep the backup of `/key` somewhere else**, such as a password manager or a separate store. If `/key` is lost, the secrets cannot be read and have to be added again in Connections. Everything else (the ledger, the board, the people) is unaffected.
- **A bad or unusable key file stops the start.** The server does not carry on with an empty store or make a new key over the top of a broken one. It says so and exits. Restore the key you backed up.
- **The key file is created on the first start** with permission for its owner only.
- **`--allow-key-in-data-dir` exists** for the rare setup where you cannot use a second place. It switches the check off, and it defeats the reason for two volumes.
- **Nothing in the secret store is shown by the workspace.** The key file and `secrets.enc.json` are never served by the web server whatever they are called.

### Secret stores

A computer with a keychain (the desktop app, or `theterminal start` on your own Mac or Windows PC) keeps secrets in the operating system's **keychain**. A server has none, so the image keeps them in the encrypted **file** store described above. `--secret-store keychain|file` and `--secret-key-file FILE` choose it; the image sets `file` and `/key/secret.key`. In Connections, a secret on a server reads "Stored in this server's encrypted secret store" instead of "Stored in your keychain". See [Connections and credentials](connections-and-credentials.md#on-a-self-hosted-server).

## Remote access on a server

On a server, remote access is switched on by the **`--remote` flag**, which the image's entry point already sets. The listener comes up with the server, on all addresses (`0.0.0.0`) inside the container.

- **If remote access cannot come up, the server does not start.** A port already in use, a refused certificate order, a bad certificate file, or a ledger that cannot be written stops the start with a one-line reason. A headless container that ran with nobody able to reach it would look healthy and be useless, so it fails instead. (Switching it on from the People screen of a desktop install is softer: it tells you and stays off.)
- **If the Owner turns remote access off in the screen, nobody can get back in** until the server restarts with the flag, because the screen is on the remote address. `docker restart theterminal` brings it back.

## Client addresses

The server limits sign-in attempts and locks out repeated failures per client address. In Docker with `-p`, connections can reach the server through Docker's userland proxy, and then **every client looks like it comes from the bridge address**. They all share one limit and one lockout bucket, so one person's failures can slow everyone's sign-in down, and traffic from the Docker host itself may share the bucket too. The server does not read a forwarded address from a reverse proxy, because it cannot tell a real one from a forged one.

To keep real client addresses, on Linux, either:

- run with **`--network host`** (publish nothing with `-p`; the server then sees real addresses), or
- set **`"userland-proxy": false`** in Docker's `daemon.json` and restart Docker, so published ports use rules that keep the source address.

A reverse proxy in front has the same effect as the userland proxy, and is not supported.

## Updating, stopping and killing

```sh
docker pull ghcr.io/<org>/theterminal
docker stop theterminal && docker rm theterminal
docker run ...   # the same command as before, with the same two volumes
```

Your data and key stay in the volumes. Nothing is migrated by hand: the database updates itself on start.

Only one server may use a data folder at a time, so a second container on the same `/data` refuses to start. A container that was **killed** (power loss, `docker kill`, the host rebooting) restarts cleanly: the lock a killed container leaves behind is recognised as stale, even though the server is always process number 1 in a container. A restart before the Owner has joined prints a new bootstrap link.

## Without Docker

You can run the same server on a computer on your own network, without Docker:

```sh
theterminal start --remote
```

It listens on all addresses with a self-signed certificate and prints the bootstrap link in the terminal where it runs, until the Owner has joined. The other flags are the same (`--remote-port`, `--remote-domain`, `--remote-tls`, `--secret-store`). The computer's own keychain is used unless you choose the file store.

## What the server image cannot do

- **No keychain.** Secrets use the encrypted file store.
- **No desktop app.** You use the workspace in a browser.
- **No personal subscriptions.** Signing in to your own Claude, ChatGPT or Google plan needs a login on the computer that runs the agent, and a headless server has none. Every run there, the Owner's and the collaborators', uses **API keys**, which is the recommended way anyway: from a connection the Owner adds, or from the provider's environment variable set on the container (for example `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`). Claude's own-plan and Gemini's Google sign-in are also turned off unless the server starts with `THETERMINAL_RESTRICTED_SIGNIN=1` or `--allow-restricted-signin`, because those providers do not allow other apps to use them. Leave it off. See [Which sign-ins are available](connections-and-credentials.md#which-sign-ins-are-available).
- **Agents and Git run inside the container.** The image has Git for project working copies. Whatever an agent may touch is still decided by the approval gate; what it can reach is what the container can reach.
