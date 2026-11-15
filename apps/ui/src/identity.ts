import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { Me } from "@theterminal/shared";
import { api } from "./api";
import type { KeyProof, WebAuthnOptions } from "./api";

/**
 * How this browser proves who its person is: a passkey (WebAuthn, through `@simplewebauthn/browser`), or, where
 * passkeys cannot work (an IP address, or a browser without them), an Ed25519 key made here with WebCrypto. The key's
 * private half is created non-extractable and kept in IndexedDB as a CryptoKey: no script, this one included, can
 * read its bytes, and it never leaves this browser. Only its public half is sent.
 */

const DB_NAME = "tt-identity";
const STORE = "keys";
const KEY_ID = "browser";

type StoredKey = { privateKey: CryptoKey; publicKey: string };

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** IPv4 dotted quads and IPv6 literals (bracketed or not): passkeys need a name, never an address. */
export function isIpLiteral(hostname: string): boolean {
  const h = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
}

/** True when this browser has WebAuthn and the page's host is a name passkeys can be bound to. */
export async function passkeysAvailable(): Promise<boolean> {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !isIpLiteral(location.hostname);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      let value: T;
      req.onsuccess = () => {
        value = req.result;
      };
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error ?? new Error("indexedDB transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("indexedDB transaction aborted"));
    });
  } finally {
    db.close();
  }
}

async function readKey(): Promise<StoredKey | undefined> {
  const v = (await withStore<unknown>("readonly", (s) => s.get(KEY_ID))) as Partial<StoredKey> | undefined;
  return v && v.privateKey && typeof v.publicKey === "string" ? (v as StoredKey) : undefined;
}

/** True when this browser already holds a key in IndexedDB "tt-identity". */
export async function hasBrowserKey(): Promise<boolean> {
  try {
    return (await readKey()) !== undefined;
  } catch {
    return false;
  }
}

export type BrowserKey = { publicKey: string; sign(message: Uint8Array): Promise<string> };

/** This browser's key: the one in IndexedDB when there is one, else a new non-extractable Ed25519 key, stored once. */
export async function ensureBrowserKey(): Promise<BrowserKey> {
  let stored = await readKey();
  if (stored === undefined) {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign"])) as CryptoKeyPair;
    const publicKey = b64url(await crypto.subtle.exportKey("spki", pair.publicKey));
    stored = { privateKey: pair.privateKey, publicKey };
    const value = stored;
    await withStore("readwrite", (s) => s.put(value, KEY_ID));
  }
  const { privateKey, publicKey } = stored;
  return {
    publicKey,
    sign: async (message) => b64url(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, message as Uint8Array<ArrayBuffer>)),
  };
}

/** What a key signs: `theterminal-auth\n<challenge>\n<host>`, so a signature is bound to one challenge and this host. */
export function keyMessage(challenge: string, host: string): Uint8Array {
  return new TextEncoder().encode(`theterminal-auth\n${challenge}\n${host}`);
}

async function prove(challenge: string): Promise<KeyProof> {
  const key = await ensureBrowserKey();
  return { publicKey: key.publicKey, challenge, signature: await key.sign(keyMessage(challenge, location.host)) };
}

type CreationJSON = Parameters<typeof startRegistration>[0]["optionsJSON"];
type RequestJSON = Parameters<typeof startAuthentication>[0]["optionsJSON"];
const register = (options: WebAuthnOptions) => startRegistration({ optionsJSON: options as unknown as CreationJSON });
const authenticate = (options: WebAuthnOptions) => startAuthentication({ optionsJSON: options as unknown as RequestJSON });

/** Joins with a new passkey: the server's options, the browser's passkey prompt, then the server's check. */
export async function joinWithPasskey(code: string, name: string): Promise<Me> {
  const response = await register(await api.joinPasskeyOptions(code, name));
  return api.joinWithPasskey(code, name, response);
}

/** Joins with this browser's key (made now when there is none). */
export async function joinWithKey(code: string, name: string): Promise<Me> {
  const { challenge } = await api.joinKeyChallenge(code);
  return api.joinWithKey(code, name, await prove(challenge));
}

export async function signInWithPasskey(): Promise<Me> {
  return api.signInWithPasskey(await authenticate(await api.signInPasskeyOptions()));
}

/** Signs in with the key already in this browser; never makes one (a new key belongs to nobody). */
export async function signInWithKey(): Promise<Me> {
  if (!(await hasBrowserKey())) throw new Error("no browser key");
  const { challenge } = await api.signInKeyChallenge();
  return api.signInWithKey(await prove(challenge));
}

/** Adds a passkey to the signed-in person. */
export async function addPasskey(): Promise<Me> {
  return api.addMyPasskey(await register(await api.myPasskeyOptions()));
}

/** Adds this browser's key (made now when there is none) to the signed-in person. */
export async function addBrowserKey(): Promise<Me> {
  const { challenge } = await api.myKeyChallenge();
  return api.addMyKey(await prove(challenge));
}
