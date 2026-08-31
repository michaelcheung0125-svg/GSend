import { useEffect, useState, useSyncExternalStore } from "react";
import { GSendClient } from "./core/client";
import { prepareStorage } from "./core/sink";
import { useI18n } from "./i18n";
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
  const { t, tm, toggle } = useI18n();
  const [prefill, setPrefill] = useState("");

  useEffect(() => {
    if (autoJoinHandled) return;
    autoJoinHandled = true;

    // Settle the storage probe here rather than on the landing screen, which never
    // renders when someone arrives by QR code or link.
    void prepareStorage();

    // A fresh code in the URL is an explicit request to join, so it outranks whatever
    // session this tab was in before.
    const code = readCodeFromUrl();
    if (code) {
      setPrefill(code);
      history.replaceState(null, "", location.pathname);
      client.join(code);
      return;
    }

    client.restore();
  }, []);

  const unlocked = state.approval === "granted";
  const pairing = state.phase === "joining" || state.phase === "pairing";

  return (
    <div className="app">
      <header className="app__header">
        <button
          type="button"
          className="brand"
          onClick={() => client.reset()}
          aria-label={t("app.back")}
        >
          <span className="brand__mark" aria-hidden="true" />
          GSend
        </button>
        <div className="row">
          <button
            type="button"
            className="btn btn--ghost btn--tiny"
            onClick={toggle}
            title={t("app.language")}
          >
            {t("app.languageShort")}
          </button>
          {state.phase !== "idle" && (
            <button type="button" className="btn btn--ghost" onClick={() => client.leave()}>
              {t("app.endSession")}
            </button>
          )}
        </div>
      </header>

      <main className="app__main">
        {state.phase === "idle" && <Landing client={client} state={state} prefill={prefill} />}
        {(state.phase === "creating" || state.phase === "hosting") && (
          <HostPanel client={client} state={state} />
        )}
        {pairing && !unlocked && <PairingPanel client={client} state={state} />}
        {/*
          Once the session is unlocked the panel stays up even while the connection is
          degraded. A received file lives in this list until it is saved, so hiding it
          on a dropped connection loses the file.
        */}
        {(state.phase === "active" || (pairing && unlocked)) && (
          <TransferPanel client={client} state={state} />
        )}
        {state.phase === "ended" && (
          <section className="card card--centered">
            <h1 className="card__title">{t("ended.title")}</h1>
            <p className="muted">{tm(state.error) ?? t("ended.default")}</p>
            <button type="button" className="btn btn--primary" onClick={() => client.reset()}>
              {t("ended.startOver")}
            </button>
          </section>
        )}
      </main>

      <footer className="app__footer">
        <span>{t("app.footer")}</span>
        <a className="app__footer-link" href="/privacy">
          {t("app.privacy")}
        </a>
      </footer>
    </div>
  );
}
