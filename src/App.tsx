import { useEffect, useState, useSyncExternalStore } from "react";
import { GSendClient, type Snapshot } from "./core/client";
import { collectShare } from "./core/share";
import { formatBytes, prepareStorage } from "./core/sink";
import { useI18n, type Translator } from "./i18n";
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
  const i18n = useI18n();
  const { t, toggle } = i18n;
  const [prefill, setPrefill] = useState("");

  useEffect(() => {
    if (autoJoinHandled) return;
    autoJoinHandled = true;

    // Settle the storage probe here rather than on the landing screen, which never
    // renders when someone arrives by QR code or link.
    void prepareStorage();

    // Arriving from the system share sheet outranks everything: the person picked this
    // app in order to send something specific.
    if (new URLSearchParams(location.search).has("shared")) {
      history.replaceState(null, "", location.pathname);
      void collectShare().then((payload) => {
        if (payload) client.stageShared(payload.files, payload.text);
      });
      return;
    }

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
  const inSession = state.phase !== "idle" && state.phase !== "ended";

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
        {state.phase === "idle" && <span className="header-host">gsend.cc</span>}
        {inSession && state.channelsOpen && <StatusChip state={state} i18n={i18n} />}
        <button
          type="button"
          className="btn btn--ghost"
          onClick={toggle}
          title={t("app.language")}
        >
          {t("app.languageShort")}
        </button>
        {state.phase !== "idle" && (
          <button type="button" className="btn btn--secondary" onClick={() => client.leave()}>
            {t("app.endSession")}
          </button>
        )}
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
        {state.phase === "ended" && <EndedScreen state={state} i18n={i18n} />}
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

/** "已連線 · direct" in the header, per the design's CLI-flavoured status line. */
function StatusChip({ state, i18n }: { state: Snapshot; i18n: Translator }) {
  const online = state.connection === "connected" && state.channelsOpen;
  const label = online
    ? `${i18n.t("status.connected")} · ${state.relayEngaged ? "turn" : "direct"}`
    : state.peerAbsentSince !== null && !state.channelsOpen
      ? i18n.t("status.peerAway")
      : state.connection === "reconnecting"
        ? i18n.t("status.reconnecting")
        : state.connection === "failed"
          ? i18n.t("status.lost")
          : i18n.t("status.connecting");

  return (
    <span className={online ? "status" : "status status--warn"}>
      <span className="status__dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function EndedScreen({ state, i18n }: { state: Snapshot; i18n: Translator }) {
  const { t, tm } = i18n;

  const sent = state.outgoing.filter((row) => row.status === "done");
  const received = state.incoming.filter((row) => row.status === "done");
  const sentBytes = sent.reduce((sum, row) => sum + row.size, 0);
  const receivedBytes = received.reduce((sum, row) => sum + row.size, 0);
  const hasSummary = sent.length > 0 || received.length > 0;

  return (
    <section className="ended">
      <div className="kicker kicker--muted">{t("ended.kicker")}</div>
      <h2 className="display display--md">{t("ended.title")}</h2>
      <p className="ended__lede">{tm(state.error) ?? t("ended.default")}</p>
      {hasSummary && (
        <div className="term term--muted">
          {`sent      ${sent.length} · ${formatBytes(sentBytes)}\nreceived  ${received.length} · ${formatBytes(receivedBytes)}`}
        </div>
      )}
      <button type="button" className="btn btn--primary btn--lg" onClick={() => client.reset()}>
        {t("ended.startOver")}
      </button>
    </section>
  );
}
