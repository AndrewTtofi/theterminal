# The Terminal as a headless Linux server: remote access on, secrets in the encrypted file store.
#
#   docker build -t theterminal-server .
#   docker run -d --name tt -p 4318:4318 -v tt-data:/data -v tt-key:/key theterminal-server
#   docker logs tt   # prints "Open this link once to claim the Owner identity: <url>" (also in /data/bootstrap-invite)
#
# Volumes: /data holds the ledger, the database and the ciphertext (secrets.enc.json); /key holds the 32-byte key
# (secret.key, 0600). Keep them on separate volumes and back them up separately: a backup of /data alone must never
# hold the key and the ciphertext together. The server refuses a key file inside the data folder.
#
# Client addresses and the sign-in throttle: with `-p`, Docker may hand connections over through its userland proxy
# (docker-proxy), and then every client appears to come from the bridge gateway, so all of them share one throttle
# and lockout bucket (one attacker can slow everyone's sign-in down). On Linux, prefer `--network host` (the server
# then sees real client addresses; publish nothing), or set `"userland-proxy": false` in the Docker daemon's
# daemon.json so published ports use NAT rules that keep the source address. A reverse proxy in front has the same
# effect and is out of scope.
#
# The join link names the first address the container sees (a bridge address under `-p`). Pass `--remote-domain NAME`
# (appended to the entrypoint: `docker run … theterminal-server --remote-domain tt.example.org`) so the link names
# the address people actually reach.

# node:24.22.2-bookworm-slim, pinned by digest (the multi-arch index).
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /app
COPY . .
# --filter keeps apps/desktop (Electron, electron-builder) out of the install. Its package.json stays in the context:
# a frozen lockfile needs every workspace package present.
RUN pnpm install --frozen-lockfile --filter "@theterminal/core..." --filter "@theterminal/ui..." \
 && pnpm --filter @theterminal/shared --filter @theterminal/core --filter @theterminal/ui build

# The same tree with production dependencies only, and the build output copied in.
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS prod
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod --filter "@theterminal/core..."
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/apps/ui/dist apps/ui/dist

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
# git for project worktrees; the one shell step, at build time only. The volume folders belong to the node user.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /key && chown node:node /data /key && chmod 0700 /data /key
COPY --from=prod --chown=node:node /app/node_modules /app/node_modules
COPY --from=prod --chown=node:node /app/packages/shared /app/packages/shared
COPY --from=prod --chown=node:node /app/packages/core /app/packages/core
COPY --from=prod --chown=node:node /app/apps/ui/dist /app/apps/ui/dist
USER node
VOLUME ["/data", "/key"]
# 4318: the remote TLS listener. 80: only for --remote-tls acme (the HTTP-01 challenge).
EXPOSE 4318 80
# /healthz is exempt from the remote Host check, so this passes with --remote-domain too. It asks port 4318: a
# --remote-port other than 4318 needs a HEALTHCHECK of its own (`node …/healthcheck.js <port>`).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["node", "/app/packages/core/dist/healthcheck.js"]
ENTRYPOINT ["node", "/app/packages/core/dist/cli.js", "start", "--data-dir", "/data", "--ui-dir", "/app/apps/ui/dist", "--secret-store", "file", "--secret-key-file", "/key/secret.key", "--remote", "--remote-bind", "0.0.0.0"]
