import { useEffect, useState } from "react";
import type { GSendClient, Snapshot } from "../core/client";
import { MAX_FILE_BYTES, formatBytes } from "../core/sink";

interface Props {
  client: GSendClient;
  state: Snapshot;
  prefill: string;
}

export default function Landing({ client, state, prefill }: Props) {
  const [code, setCode] = useState(prefill);

  useEffect(() => {
    if (prefill) setCode(prefill);
  }, [prefill]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    client.join(code);
  };

  return (
    <section className="card card--centered">
      <h1 className="card__title">Move files between your devices</h1>
      <p className="muted">
        One code, one direct connection. Up to {formatBytes(MAX_FILE_BYTES)} per file.
      </p>

      {state.error && <p className="alert">{state.error}</p>}

      <button type="button" className="btn btn--primary btn--lg" onClick={() => client.host()}>
        Start a session
      </button>

      <div className="divider">
        <span>or join one</span>
      </div>

      <form className="code-form" onSubmit={submit}>
        <input
          className="code-input"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 4))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="0000"
          aria-label="4-digit code"
        />
        <button type="submit" className="btn btn--lg" disabled={code.length !== 4}>
          Join
        </button>
      </form>
    </section>
  );
}
