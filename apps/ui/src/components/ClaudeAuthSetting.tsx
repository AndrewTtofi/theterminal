import { useState } from "react";

type Mode = "api_key" | "subscription";

type Props = {
  mode: Mode;
  subscriptionAck: string;
  onChange: (mode: Mode, acknowledgement?: string) => Promise<unknown> | void;
};

export function ClaudeAuthSetting({ mode, subscriptionAck, onChange }: Props) {
  const [choosing, setChoosing] = useState<Mode>(mode);
  const [accepted, setAccepted] = useState(false);

  const pick = (m: Mode) => {
    setChoosing(m);
    setAccepted(false);
    if (m === "api_key" && mode !== "api_key") void onChange("api_key");
  };

  return (
    <fieldset className="claude-auth">
      <legend>Claude sign-in</legend>
      <label>
        <input type="radio" name="claude-auth" checked={choosing === "api_key"} onChange={() => pick("api_key")} />
        API key (recommended)
      </label>
      <label>
        <input
          type="radio"
          name="claude-auth"
          checked={choosing === "subscription"}
          onChange={() => pick("subscription")}
        />
        My own Claude subscription
      </label>
      {choosing === "subscription" && mode !== "subscription" && (
        <div className="warning" role="alert">
          <p>{subscriptionAck}</p>
          <label>
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
            I understand and accept this risk
          </label>
          <button type="button" disabled={!accepted} onClick={() => void onChange("subscription", subscriptionAck)}>
            Confirm
          </button>
        </div>
      )}
    </fieldset>
  );
}
