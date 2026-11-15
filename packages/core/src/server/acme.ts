import { X509Certificate, createHash, createPrivateKey, createPublicKey, generateKeyPair, randomBytes } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { domainSchema } from "@theterminal/shared";
import type { SecretStore } from "../secrets/store.js";
import { selfSignedTlsCertificate, type CertMaterial } from "./certs.js";

/**
 * Certificates from an ACME CA (Let's Encrypt) for the remote listener, when the Owner sets a domain. HTTP-01 only.
 *
 * Keys: the ACME account key lives in secret `remote/acme/account` (created once, never in the ledger or a file) and
 * the certificate key in secret `remote/acme/key`. Only the certificate chain, which is public, is written to
 * `<dataDir>/remote/acme-cert.pem`.
 *
 * The challenge: `challengeResponse(token)` answers only a token of an order that is open right now; remote.ts serves
 * it on a plain HTTP listener on port 80 (the only port Let's Encrypt validates HTTP-01 on) and answers 404 to
 * everything else.
 *
 * Port 80 is a privileged port. It binds without privilege inside Docker (unprivileged ports start at 0 since Docker
 * 20.10), but `theterminal start --remote --remote-tls acme` as a normal user on Linux cannot bind it, and enabling
 * then fails with `acme_failed` (type `unknown`) and remote access stays off. Grant the binary the capability, run in
 * Docker, or use self-signed or provided certificates. `acmePort` is a test knob, not a workaround: Let's Encrypt
 * connects to port 80 only.
 *
 * Headless servers: remote access there is switched by the `--remote` flag. After a restart `startIfEnabled` listens
 * again with the stored certificate (a new order only when none is stored or it is due) and reopens port 80 for
 * renewals; once the Owner turns remote off in the UI, the only way back in is a restart with `--remote`.
 *
 * ACME traffic goes through acme-client's axios, which honours `HTTPS_PROXY`/`NO_PROXY` from the server's environment.
 */

export const ACME_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";
export const ACME_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";
/** A certificate with less than this left is renewed. */
export const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
/** Secret-store account of the ACME account key (PKCS#8 PEM). */
export const ACME_ACCOUNT_SECRET = "remote/acme/account";
/** Secret-store account of the ACME certificate's key (PKCS#8 PEM). */
export const ACME_KEY_SECRET = "remote/acme/key";
/** The certificate chain's file name under `<dataDir>/remote/`. */
export const ACME_CERT_FILE = "acme-cert.pem";
/** An order (account, challenge, finalize, download) that takes longer than this fails. */
export const ACME_ORDER_TIMEOUT_MS = 3 * 60 * 1000;

const TYPE_PATTERN = /^urn:ietf:params:acme:error:[a-zA-Z]+$/;
const MAX_TYPE_LENGTH = 200;
/** RFC 8555 tokens are base64url; Let's Encrypt's are 43 characters. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_KEY_AUTH = 512;
const MAX_PENDING = 16;
const MAX_CERT_BYTES = 64 * 1024;

/**
 * An ACME failure. The message is fixed; `.type` is the ACME error type (a URN from the ACME server, not user input)
 * when it is well-formed and at most 200 characters, else "unknown". It reaches the UI; the server's detail text never
 * does.
 */
export class AcmeError extends Error {
  readonly type: string;
  constructor(type: string) {
    super("certificate could not be obtained");
    this.name = "AcmeError";
    this.type = typeof type === "string" && type.length <= MAX_TYPE_LENGTH && TYPE_PATTERN.test(type) ? type : "unknown";
  }
}

export type AcmeOrderRequest = {
  directoryUrl: string;
  /** PKCS#8 PEM. */
  accountKeyPem: string;
  domain: string;
  now: () => Date;
  /** The CA asked for `token`: serve `keyAuthorization` at /.well-known/acme-challenge/<token> until `remove`. */
  challenge: {
    create(token: string, keyAuthorization: string): Promise<void>;
    remove(token: string): Promise<void>;
  };
  /** Fetches what the plain listener serves for `token` (the fake CA's "validation"; the real CA connects itself). */
  probe(token: string): Promise<string | null>;
};

/** What the manager needs from an ACME client: one order for one domain, the issued chain and its key back. */
export type AcmeClientLike = {
  kind: "real" | "fake";
  order(req: AcmeOrderRequest): Promise<{ certPem: string; keyPem: string }>;
};

const generate = promisify(generateKeyPair);

async function ecKeyPem(): Promise<string> {
  const { privateKey } = await generate("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }) as string;
}

function thumbprint(accountKeyPem: string): string {
  const spki = createPublicKey(createPrivateKey(accountKeyPem)).export({ type: "spki", format: "der" });
  return createHash("sha256").update(spki).digest("base64url");
}

/**
 * Test and demo CA, selected only under THETERMINAL_FAKE_AGENT=1 + THETERMINAL_FAKE_ACME=1: it asks for a challenge,
 * "validates" it through `probe` (the plain listener), then issues a self-signed 90-day certificate for the domain.
 */
export const fakeAcme: AcmeClientLike = {
  kind: "fake",
  async order(req) {
    const token = randomBytes(32).toString("base64url");
    const keyAuthorization = `${token}.${thumbprint(req.accountKeyPem)}`;
    await req.challenge.create(token, keyAuthorization);
    try {
      const served = await req.probe(token);
      if (served === null) throw new AcmeError("urn:ietf:params:acme:error:connection");
      if (served !== keyAuthorization) throw new AcmeError("urn:ietf:params:acme:error:unauthorized");
    } finally {
      await req.challenge.remove(token);
    }
    const m = await selfSignedTlsCertificate({ hostnames: [req.domain], addresses: [], now: req.now, days: 90 });
    return { certPem: m.certPem, keyPem: m.keyPem };
  },
};

type AcmeModule = typeof import("acme-client");

/** The ACME error type in a response body: a problem document, an order/authz error, or a failed challenge. */
function typeIn(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as { type?: unknown; error?: { type?: unknown }; challenges?: unknown };
  if (typeof d.type === "string" && d.type.startsWith("urn:ietf:params:acme:error:")) return d.type;
  if (typeof d.error?.type === "string") return d.error.type;
  if (Array.isArray(d.challenges)) {
    for (const c of d.challenges as Array<{ error?: { type?: unknown } } | null>) {
      if (typeof c?.error?.type === "string") return c.error.type;
    }
  }
  return null;
}

/**
 * Let's Encrypt through acme-client 5.4.0 (`auto`, HTTP-01 only). acme-client drops the problem type from its errors,
 * so an interceptor on its axios instance keeps the last one seen; orders are serialised by the caller.
 */
export const realAcme: AcmeClientLike = {
  kind: "real",
  async order(req) {
    const mod = (await import("acme-client")) as AcmeModule & { default?: AcmeModule };
    const acme = mod.default ?? mod;
    let lastType: string | null = null;
    const id = acme.axios.interceptors.response.use(
      (resp) => {
        lastType = typeIn(resp?.data) ?? lastType;
        return resp;
      },
      (err: unknown) => {
        lastType = typeIn((err as { response?: { data?: unknown } })?.response?.data) ?? lastType;
        throw err;
      },
    );
    try {
      const client = new acme.Client({ directoryUrl: req.directoryUrl, accountKey: req.accountKeyPem });
      const keyPem = await ecKeyPem();
      const [, csr] = await acme.crypto.createCsr({ commonName: req.domain, altNames: [req.domain] }, keyPem);
      const certPem = await client.auto({
        csr,
        // The Owner chose Let's Encrypt for their domain; its subscriber agreement is accepted on their behalf.
        termsOfServiceAgreed: true,
        challengePriority: ["http-01"],
        challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
          if (challenge.type !== "http-01") throw new Error("only http-01");
          await req.challenge.create(challenge.token, keyAuthorization);
        },
        challengeRemoveFn: async (_authz, challenge) => {
          await req.challenge.remove(challenge.token);
        },
      });
      return { certPem, keyPem };
    } catch (err) {
      if (err instanceof AcmeError) throw err;
      throw new AcmeError(lastType ?? "unknown");
    } finally {
      acme.axios.interceptors.response.eject(id);
    }
  },
};

/** The fake CA only when both test flags are exactly "1"; anything else is Let's Encrypt. */
export function selectAcmeClient(env: NodeJS.ProcessEnv = process.env): AcmeClientLike {
  return env.THETERMINAL_FAKE_AGENT === "1" && env.THETERMINAL_FAKE_ACME === "1" ? fakeAcme : realAcme;
}

export type AcmeDeps = {
  secrets: SecretStore;
  dataDir: string;
  directoryUrl?: string;
  /** Tests inject fakeAcme or a stub; the default follows `selectAcmeClient()`. */
  client?: AcmeClientLike;
  now?: () => Date;
};

export type ObtainOptions = { probe?: (token: string) => Promise<string | null> };

export class AcmeManager {
  private readonly client: AcmeClientLike;
  private readonly directoryUrl: string;
  private readonly now: () => Date;
  private readonly pending = new Map<string, string>();

  constructor(private readonly deps: AcmeDeps) {
    this.client = deps.client ?? selectAcmeClient();
    this.directoryUrl = deps.directoryUrl ?? ACME_DIRECTORY;
    this.now = deps.now ?? (() => new Date());
  }

  /** The key authorization for `token` while its order is open, else null. Exact match only. */
  challengeResponse(token: string): string | null {
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
    return this.pending.get(token) ?? null;
  }

  /**
   * One order for `domain`: account key (created once), HTTP-01 challenge, finalize. The key goes to the secret store
   * and the chain to `<dataDir>/remote/acme-cert.pem`. Any failure is an AcmeError.
   */
  async obtain(domain: string, opts: ObtainOptions = {}): Promise<CertMaterial> {
    if (!domainSchema.safeParse(domain).success) throw new AcmeError("unknown");
    const d = domain.toLowerCase();
    const created: string[] = [];
    try {
      const accountKeyPem = await this.accountKey();
      const issued = await withTimeout(
        this.client.order({
          directoryUrl: this.directoryUrl,
          accountKeyPem,
          domain: d,
          now: this.now,
          challenge: {
            create: async (token, keyAuthorization) => {
              if (!TOKEN_PATTERN.test(token) || typeof keyAuthorization !== "string" || keyAuthorization.length > MAX_KEY_AUTH) {
                throw new AcmeError("unknown");
              }
              if (this.pending.size >= MAX_PENDING) throw new AcmeError("unknown");
              this.pending.set(token, keyAuthorization);
              created.push(token);
            },
            remove: async (token) => {
              this.pending.delete(token);
            },
          },
          probe: opts.probe ?? (async (token) => this.challengeResponse(token)),
        }),
        ACME_ORDER_TIMEOUT_MS,
      );
      const m = this.validate(issued.certPem, issued.keyPem, d, 0);
      if (m === null) throw new AcmeError("unknown");
      await this.deps.secrets.set(ACME_KEY_SECRET, m.keyPem);
      this.writeCert(m.certPem);
      return m;
    } catch (err) {
      throw err instanceof AcmeError ? err : new AcmeError("unknown");
    } finally {
      for (const t of created) this.pending.delete(t);
    }
  }

  /** The stored certificate when it matches its key, is valid now and covers `domain`; else null. */
  async load(domain: string): Promise<CertMaterial | null> {
    const certPem = readBoundedText(join(this.deps.dataDir, "remote", ACME_CERT_FILE));
    if (certPem === null) return null;
    let keyPem: string | null;
    try {
      keyPem = await this.deps.secrets.get(ACME_KEY_SECRET);
    } catch {
      return null;
    }
    return keyPem === null ? null : this.validate(certPem, keyPem, domain.toLowerCase(), 0);
  }

  /** Null while more than RENEW_BEFORE_MS remains on `current`; otherwise a new certificate (or an AcmeError). */
  async renewIfDue(domain: string, current: CertMaterial, opts: ObtainOptions = {}): Promise<CertMaterial | null> {
    if (!this.isDue(current)) return null;
    return this.obtain(domain, opts);
  }

  isDue(current: CertMaterial): boolean {
    const left = new Date(current.expiresAt).getTime() - this.now().getTime();
    return !(left > RENEW_BEFORE_MS);
  }

  private async accountKey(): Promise<string> {
    const stored = await this.deps.secrets.get(ACME_ACCOUNT_SECRET);
    if (stored !== null) {
      try {
        createPrivateKey(stored);
        return stored;
      } catch {
        throw new AcmeError("unknown");
      }
    }
    const pem = await ecKeyPem();
    await this.deps.secrets.set(ACME_ACCOUNT_SECRET, pem);
    return pem;
  }

  private validate(certPem: string, keyPem: string, domain: string, marginMs: number): CertMaterial | null {
    try {
      if (typeof certPem !== "string" || Buffer.byteLength(certPem) > MAX_CERT_BYTES) return null;
      const x = new X509Certificate(certPem);
      if (!x.checkPrivateKey(createPrivateKey(keyPem))) return null;
      if (x.checkHost(domain, { subject: "never", wildcards: false }) === undefined) return null;
      const now = this.now().getTime();
      const to = new Date(x.validTo).getTime();
      if (!(new Date(x.validFrom).getTime() <= now && now < to - marginMs)) return null;
      const sans = (x.subjectAltName ?? "").split(", ").filter((s) => s.length > 0);
      return {
        certPem,
        keyPem: createPrivateKey(keyPem).export({ type: "pkcs8", format: "pem" }) as string,
        fingerprint: x.fingerprint256,
        expiresAt: new Date(to).toISOString(),
        subjectAltNames: sans,
      };
    } catch {
      return null;
    }
  }

  private writeCert(certPem: string): void {
    const dir = join(this.deps.dataDir, "remote");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, ACME_CERT_FILE);
    const tmp = join(dir, `${ACME_CERT_FILE}.${process.pid}.tmp`);
    try {
      writeFileSync(tmp, certPem, { mode: 0o644 });
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AcmeError("unknown")), ms);
    timer.unref();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** The file's text when it exists, is a regular file and is at most 64 KiB, else null. */
function readBoundedText(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_CERT_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, buf, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
