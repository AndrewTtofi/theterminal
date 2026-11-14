import { useState } from "react";
import { PROVIDERS, PROVIDER_MODES } from "@theterminal/shared";
import type { AuthMode, Provider } from "@theterminal/shared";

export const PROVIDER_NAMES: Record<Provider, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };

export const OWN_LABEL: Record<string, string> = {
  subscription: "My own Claude subscription",
  chatgpt: "My own ChatGPT plan",
  google: "My own Google account",
};

type Props = {
  modes: Record<Provider, AuthMode>;
  acks: Record<Provider, string>;
  /** Resolve true when the server accepted the change; false (or reject) keeps the radios on the server's mode. */
  onChange: (provider: Provider, mode: AuthMode, acknowledgement?: string) => Promise<boolean | void> | void;
};

/** One provider's sign-in mode: API key, or the Owner's own plan behind an explicit acknowledgement. */
export function ProviderModeSection({
  provider,
  mode,
  ack,
  onChange,
}: {
  provider: Provider;
  mode: AuthMode;
  ack: string;
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
      <label>
        <input type="radio" name={name} checked={choosing === ownMode} onChange={() => pick(ownMode)} />
        {OWN_LABEL[ownMode]}
      </label>
      {choosing === ownMode && mode !== ownMode && (
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

export function ProviderAuthSettings({ modes, acks, onChange }: Props) {
  return (
    <div className="provider-auth-settings">
      {PROVIDERS.map((p) => (
        <ProviderModeSection key={`${p}:${modes[p]}`} provider={p} mode={modes[p]} ack={acks[p]} onChange={onChange} />
      ))}
    </div>
  );
}
