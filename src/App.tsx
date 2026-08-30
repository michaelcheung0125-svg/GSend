import { useEffect, useState, useSyncExternalStore } from "react";
import { GSendClient } from "./core/client";
import Landing from "./ui/Landing";
import HostPanel from "./ui/HostPanel";
import PairingPanel from "./ui/PairingPanel";
import TransferPanel from "./ui/TransferPanel";

const client = new GSendClient();

/** Module scope so React StrictMode's double mount cannot join twice. */
let autoJoinHandled = false;

function readCodeFromUrl(): string {
  const code = new URLSearchParams(location.search).get("c") ?? "";
  return /^\d{4}$/.test(code) ? code : "";
}

export default function App() {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [prefill, setPrefill] = useState("");

  useEffect(() => {
    if (autoJoinHandled) return;
    autoJoinHandled = true;

    const code = readCodeFromUrl();
    if (!code) return;

    setPrefill(code);
    history.replaceState(null, "", location.pathname);
    client.join(code);
  }, []);

  return (
    <div className="app">
      <header className="app__header">
        <button
          type="button"
          className="brand"
          onClick={() => client.reset()}
          aria-label="Back to start"
        >
          <span className="brand__mark" aria-hidden="true" />
          GSend
        </button>
        {state.phase !== "idle" && (
          <button type="button" className="btn btn--ghost" onClick={() => client.leave()}>
            End session
          </button>
        )}
      </header>

      <main className="app__main">
        {state.phase === "idle" && <Landing client={client} state={state} prefill={prefill} />}
        {(state.phase === "creating" || state.phase === "hosting") && (
          <HostPanel client={client} state={state} />
        )}
        {(state.phase === "joining" || state.phase === "pairing") && (
          <PairingPanel client={client} state={state} />
        )}
        {state.phase === "active" && <TransferPanel client={client} state={state} />}
        {state.phase === "ended" && (
          <section className="card card--centered">
            <h1 className="card__title">Session ended</h1>
            <p className="muted">{state.error ?? "The session is closed."}</p>
            <button type="button" className="btn btn--primary" onClick={() => client.reset()}>
              Start over
            </button>
          </section>
        )}
      </main>

      <footer className="app__footer">
        <span>Direct browser-to-browser transfer. Files never touch a server.</span>
      </footer>
    </div>
  );
}
