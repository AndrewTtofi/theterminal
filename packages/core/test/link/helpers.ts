import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { LinkIdentity } from "../../src/link/identity.js";

/** A fresh identity over its own memory store. */
export const newIdentity = () => LinkIdentity.load({ secrets: new MemorySecretStore(), onCreated: () => undefined });

export type RawReply = { kind: "reply"; status: number; body: string } | { kind: "closed"; error?: string };

/**
 * A raw TLS 1.3 GET that never checks the server: either the reply, or how the connection ended without one.
 * `identity` null sends no client certificate.
 */
export function rawTlsGet(port: number, path: string, identity: LinkIdentity | null): Promise<RawReply> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        agent: false,
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
        checkServerIdentity: () => undefined,
        ...(identity ? identity.tls() : {}),
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ kind: "reply", status: res.statusCode ?? 0, body }));
        res.on("error", (e) => resolve({ kind: "closed", error: e.message }));
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ kind: "closed", error: e.message }));
    req.end();
  });
}

/** Whether a TCP connection to the port is accepted (true) or refused (false). */
export function tcpAccepts(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Binds an ephemeral loopback port and keeps it, so a test can see a scan move past it. */
export function holdPort(): Promise<{ port: number; release: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, release: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** A minimal TLS server presenting `identity`'s certificate, for client tests that need a misbehaving server. */
export function tlsServer(identity: LinkIdentity, onSecure: (socket: tls.TLSSocket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const sockets = new Set<tls.TLSSocket>();
    const server = tls.createServer({ ...identity.tls(), minVersion: "TLSv1.3", requestCert: true, rejectUnauthorized: false }, (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("error", () => undefined);
      onSecure(s);
    });
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

/**
 * A TLS server under `identity` that strings every request along: after the request arrives it writes a status line,
 * then one header byte every `everyMs`, for as long as the connection lasts (a socket inactivity timeout never fires).
 * `open()` counts the connections still open.
 */
export async function dribblingServer(identity: LinkIdentity, everyMs = 400): Promise<{ port: number; close: () => Promise<void>; open: () => number }> {
  const timers = new Set<ReturnType<typeof setInterval>>();
  let open = 0;
  const server = await tlsServer(identity, (socket) => {
    open++;
    let started = false;
    socket.on("data", () => {
      if (started) return;
      started = true;
      socket.write("HTTP/1.1 200 OK\r\nx-slow: ");
      const timer = setInterval(() => socket.write("a"), everyMs);
      timers.add(timer);
      socket.once("close", () => {
        clearInterval(timer);
        timers.delete(timer);
        open--;
      });
    });
  });
  return {
    port: server.port,
    open: () => open,
    close: async () => {
      for (const t of timers) clearInterval(t);
      await server.close();
    },
  };
}
