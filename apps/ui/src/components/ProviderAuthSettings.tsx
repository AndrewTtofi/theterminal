import { useState } from "react";
import { PROVIDERS, PROVIDER_MODES } from "@theterminal/shared";
import type { AuthMode, Provider } from "@theterminal/shared";

export const PROVIDER_NAMES: Record<Provider, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };

export const OWN_LABEL: Record<string, string> = {
  subscription: "My own Claude subscription",
  chatgpt: "My own ChatGPT plan",
  google: "My own Google account",
};

/**
 * Shown instead of the own-plan choice when the server has it turned off (the provider does not allow other apps to
 * use that sign-in). Codex's ChatGPT sign-in is never turned off.
 */
export const OWN_MODE_OFF: Partial<Record<Provider, string>> = {
  claude: "Signing in with your own Claude plan is turned off until Anthropic allows it. Use an API key.",
  gemini: "Signing in with your own Google account is turned off: Google doesn't allow other apps to use Gemini CLI's Google sign-in. Use an API key.",
};
const ownModeOff = (p: Provider) => OWN_MODE_OFF[p] ?? "Signing in with your own plan is turned off on this server. Use an API key.";

type Props = {
  modes: Record<Provider, AuthMode>;
  acks: Record<Provider, string>;
  /** Whether each provider's own-plan mode can be chosen, as the server says; a missing entry counts as available. */
  ownModeAvailable?: Partial<Record<Provider, boolean>>;
  /** Resolve true when the server accepted the change; false (or reject) keeps the radios on the server's mode. */
  onChange: (provider: Provider, mode: AuthMode, acknowledgement?: string) => Promise<boolean | void> | void;
};

/** One provider's sign-in mode: API key, or the Owner's own plan behind an explicit acknowledgement. */
export function ProviderModeSection({
  provider,
  mode,
  ack,
  ownModeAvailable = true,
  onChange,
}: {
  provider: Provider;
  mode: AuthMode;
  ack: string;
  /** False when the server has this provider's own-plan mode turned off: the choice is hidden, with one line instead. */
  ownModeAvailable?: boolean;
  onChange: Props["onChange"];
}) {
  const [choosing, setChoosing] = useState<AuthMode>(mode);
  const [accepted, setAccepted] = useState(false);
  const ownMode: AuthMode = PROVIDER_MODES[provider][1];

  const submit = (m: AuthMode, acknowledgement?: string) => {
    void Promise.resolve(acknowledgement ? onChange(provider, m, acknowledgement) : onChange(provider, m))
      .then((ok) => {
        if (ok === false) setChoosing(mode);
      })
      .catch(() => setChoosing(mode))
      .finally(() => setAccepted(false));
  };

  const pick = (m: AuthMode) => {
    setChoosing(m);
    setAccepted(false);
    if (m === "api_key" && mode !== "api_key") submit("api_key");
  };

  const name = `${provider}-auth`;
  return (
    <fieldset className="provider-auth">
      <legend>{PROVIDER_NAMES[provider]} sign-in</legend>
      <label>
        <input type="radio" name={name} checked={choosing === "api_key"} onChange={() => pick("api_key")} />
        API key (recommended)
      </label>
      {ownModeAvailable ? (
        <label>
          <input type="radio" name={name} checked={choosing === ownMode} onChange={() => pick(ownMode)} />
          {OWN_LABEL[ownMode]}
        </label>
      ) : (
        <p className="note">{ownModeOff(provider)}</p>
      )}
      {ownModeAvailable && choosing === ownMode && mode !== ownMode && (
        <div className="warning" role="alert">
          <p>{ack}</p>
          <label>
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
            I understand and accept this risk
          </label>
          <button type="button" disabled={!accepted} onClick={() => submit(ownMode, ack)}>
            Confirm
          </button>
        </div>
      )}
    </fieldset>
  );
}

export function ProviderAuthSettings({ modes, acks, ownModeAvailable, onChange }: Props) {
  return (
    <div className="provider-auth-settings">
      {PROVIDERS.map((p) => (
        <ProviderModeSection
          key={`${p}:${modes[p]}`}
          provider={p}
          mode={modes[p]}
          ack={acks[p]}
          ownModeAvailable={ownModeAvailable?.[p] !== false}
          onChange={onChange}
        />
      ))}
    </div>
  );
}
