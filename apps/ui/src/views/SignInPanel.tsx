import { useEffect, useRef, useState } from "react";
import type { Provider } from "@theterminal/shared";
import { api, ApiError, errorMessage } from "../api";
import type { SignInStatus } from "../api";
import { PROVIDER_NAMES } from "../components/ProviderAuthSettings";

/** Whose sign-in page the Owner lands on. */
const COMPANY: Record<Provider, string> = { claude: "Anthropic", codex: "OpenAI", gemini: "Google" };
const CLI_NAME: Record<Provider, string> = { claude: "Claude Code", codex: "Codex CLI", gemini: "Gemini CLI" };

/**
 * The command to run by hand. Gemini CLI signs in only in its own terminal UI. Claude Code's login completes in the
 * browser it opens; without one, it wants a code pasted into a terminal, which The Terminal never relays.
 */
const TERMINAL: Partial<Record<Provider, { command: string; before: string; after: string }>> = {
  claude: { command: "claude auth login", before: "If no browser window opened, run ", after: " in a terminal, then check again." },
  gemini: {
    command: "gemini",
    before: "Gemini CLI signs in only in a terminal. Run ",
    after: " there, choose Sign in with Google, then check again.",
  },
};

const isLink = (line: string) => {
  if (!/^https:\/\/\S+$/.test(line)) return false;
  try {
    return new URL(line).protocol === "https:";
  } catch {
    return false;
  }
};

function statusText(provider: Provider, s: SignInStatus): string {
  if (s === "signed_in") return "Signed in";
  if (s === "signed_out") return "Not signed in yet";
  if (s === "not_installed") return `${CLI_NAME[provider]} is not installed`;
  return `The Terminal can't check ${PROVIDER_NAMES[provider]}'s sign-in from here.`;
}

type Phase = "starting" | "running" | "succeeded" | "failed" | "idle";

/**
 * Signs the Owner in to their own subscription with the provider's official login command, run by the server.
 * Shows only what the server lets through (the provider's sign-in link or device code), then the outcome.
 */
export function SignInPanel({ provider, onClose, pollMs = 1000 }: { provider: Provider; onClose: () => void; pollMs?: number }) {
  const name = PROVIDER_NAMES[provider];
  const terminal = TERMINAL[provider];
  const terminalOnly = provider === "gemini";
  const [phase, setPhase] = useState<Phase>(terminalOnly ? "idle" : "starting");
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<SignInStatus | null>(null);
  const [checking, setChecking] = useState(false);
  // Survives React's development remount, so one panel starts one sign-in, and a real unmount cancels it.
  const session = useRef<{ started: boolean; id: string | null; running: boolean; closed: boolean; pendingClose?: ReturnType<typeof setTimeout> }>({
    started: false, id: null, running: false, closed: false,
  });

  useEffect(() => {
    const s = session.current;
    if (s.pendingClose !== undefined) clearTimeout(s.pendingClose);
    s.pendingClose = undefined;
    if (!s.started && !terminalOnly) {
      s.started = true;
      void (async () => {
        try {
          const { id } = await api.startSignIn(provider);
          s.id = id;
          s.running = true;
          if (s.closed) return void api.cancelSignIn(id).catch(() => undefined);
          setPhase("running");
          while (!s.closed) {
            const view = await api.getSignIn(id);
            if (s.closed) return;
            setLines(view.lines);
            if (view.state !== "running") {
              s.running = false;
              setPhase(view.state);
              return;
            }
            await new Promise((r) => setTimeout(r, pollMs));
          }
        } catch (e) {
          s.running = false;
          if (s.closed) return;
          setPhase("idle");
          if (e instanceof ApiError && e.code === "signin_running") setError(`A sign-in to ${name} is already running.`);
          else if (e instanceof ApiError && e.code === "not_installed") setError(`${CLI_NAME[provider]} is not installed`);
          else setError(errorMessage(e));
        }
      })();
    }
    return () => {
      s.pendingClose = setTimeout(() => close(s), 0);
    };
    // Runs once per panel: the provider of a panel never changes.
  }, []);

  function close(s: typeof session.current) {
    s.closed = true;
    if (s.running && s.id !== null) {
      s.running = false;
      void api.cancelSignIn(s.id).catch(() => undefined);
    }
  }

  const cancel = () => {
    close(session.current);
    onClose();
  };

  const checkAgain = async () => {
    setChecking(true);
    try {
      const all = await api.getSignInStatus();
      setCheck(all[provider]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const signedIn = phase === "succeeded" || check === "signed_in";
  const waiting = (phase === "starting" || phase === "running") && !signedIn;

  return (
    <section className="signin-panel" aria-label={`Sign in to ${name}`}>
      <p className="field-help">
        You sign in on {COMPANY[provider]}'s own page. The Terminal never sees your password or login tokens.
      </p>
      {terminal && (
        <p className="signin-terminal">
          {terminal.before}
          <code>{terminal.command}</code>
          {terminal.after}
        </p>
      )}
      {lines.length > 0 && (
        <ul className="signin-lines">
          {lines.map((line) => (
            <li key={line}>
              {isLink(line) ? (
                <a href={line} target="_blank" rel="noopener noreferrer">
                  {line}
                </a>
              ) : (
                <code>{line}</code>
              )}
            </li>
          ))}
        </ul>
      )}
      {waiting && (
        <p role="status" aria-label="Waiting for you to sign in" className="signin-waiting">
          <span className="spinner" aria-hidden="true" /> Waiting for you to sign in…
        </p>
      )}
      {signedIn && <p className="signin-result ok">Signed in</p>}
      {!signedIn && phase === "failed" && <p className="signin-result failed">Sign-in failed</p>}
      {!signedIn && check !== null && <p className="signin-check">{statusText(provider, check)}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="connection-actions">
        {terminal && !signedIn && (
          <button type="button" disabled={checking} onClick={() => void checkAgain()}>
            Check again
          </button>
        )}
        <button type="button" onClick={cancel}>
          {waiting ? "Cancel" : "Close"}
        </button>
      </div>
    </section>
  );
}
