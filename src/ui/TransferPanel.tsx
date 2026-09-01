import { useRef, useState } from "react";
import type { GSendClient, Snapshot } from "../core/client";
import { formatBytes } from "../core/sink";
import type { TransferView } from "../core/transfer";
import { useI18n, type Translator } from "../i18n";

interface Props {
  client: GSendClient;
  state: Snapshot;
}

export default function TransferPanel({ client, state }: Props) {
  const i18n = useI18n();
  const { t, tm } = i18n;
  const fileInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(false);

  const transfers = [...state.outgoing, ...state.incoming].sort(
    (a, b) => b.startedAt - a.startedAt,
  );

  const upBytes = state.outgoing.reduce((sum, row) => sum + row.transferred, 0);
  const downBytes = state.incoming.reduce((sum, row) => sum + row.transferred, 0);
  const itemCount = transfers.length + state.texts.length;

  const pick = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    client.sendFiles([...list]);
    if (fileInput.current) fileInput.current.value = "";
  };

  const submitText = (event: React.FormEvent) => {
    event.preventDefault();
    client.sendText(draft);
    setDraft("");
  };

  return (
    <section
      className="panel"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        pick(event.dataTransfer.files);
      }}
    >
      <div className="panel__main">
        <div className="session-head">
          <h3>{t("transfer.session")}</h3>
          <span className="session-head__meta">
            {t("transfer.sessionMeta", {
              count: itemCount,
              up: formatBytes(upBytes),
              down: formatBytes(downBytes),
            })}
          </span>
        </div>

        {state.notice && (
          <p className="alert alert--soft" style={{ marginBottom: 14 }} onClick={() => client.dismissNotice()}>
            {tm(state.notice)}
          </p>
        )}

        <ul className="transfers">
          {transfers.map((transfer) => (
            <TransferRow key={transfer.id} transfer={transfer} client={client} i18n={i18n} />
          ))}
        </ul>

        {state.texts.length > 0 && (
          <ul className="messages">
            {state.texts
              .slice()
              .reverse()
              .map((message) => (
                <li key={message.id} className={message.mine ? "message message--mine" : "message"}>
                  <span className="message__glyph" aria-hidden="true">
                    {message.mine ? "↑" : "↓"}
                  </span>
                  <span className="message__body">{message.body}</span>
                  <button
                    type="button"
                    className="btn btn--secondary btn--tiny"
                    onClick={() => void navigator.clipboard.writeText(message.body).catch(() => {})}
                  >
                    {t("transfer.copy")}
                  </button>
                </li>
              ))}
          </ul>
        )}
      </div>

      <div className="screen__rule" aria-hidden="true" />

      <aside className="panel__aside">
        <div className={dragging ? "dropzone dropzone--active" : "dropzone"}>
          <span className="dropzone__glyph" aria-hidden="true">
            ↓
          </span>
          <p className="dropzone__hint">{t("transfer.dropHere")}</p>
          <button type="button" className="btn btn--primary" onClick={() => fileInput.current?.click()}>
            {t("transfer.chooseFiles")}
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => pick(event.target.files)}
          />
        </div>

        <form className="composer" onSubmit={submitText}>
          <input
            className="composer__input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t("transfer.textPlaceholder")}
            aria-label={t("transfer.textLabel")}
          />
          <button type="submit" className="btn btn--secondary" disabled={!draft.trim()}>
            {t("transfer.send")}
          </button>
        </form>

        <div className="term term--muted">
          {`peer    ${state.relayEngaged ? "relay · turn" : "direct"}\nlimit   1 GB / file\ncode    ${state.code ?? "----"} · burned`}
        </div>

        <hr className="hr" style={{ margin: "2px 0" }} />
        <p className="aside-note">{t("transfer.persistNote")}</p>
      </aside>
    </section>
  );
}

/* ── CLI progress rows ─────────────────────────────────────────────────── */

const BAR_CELLS = 20;

interface RateState {
  at: number;
  bytes: number;
  rate: number;
}

/**
 * Rate and ETA are derived in the view from progress deltas, smoothed with an
 * EMA so the number reads steadily instead of flickering with every chunk.
 */
function useRate(transfer: TransferView): { rate: number; etaSeconds: number | null } {
  const ref = useRef<RateState>({ at: 0, bytes: transfer.transferred, rate: 0 });
  const s = ref.current;
  const now = performance.now();

  if (transfer.status !== "active") {
    s.at = 0;
    s.rate = 0;
    s.bytes = transfer.transferred;
    return { rate: 0, etaSeconds: null };
  }

  if (s.at === 0) {
    s.at = now;
    s.bytes = transfer.transferred;
    return { rate: 0, etaSeconds: null };
  }

  const dt = (now - s.at) / 1000;
  if (dt >= 0.4) {
    const instant = Math.max(0, transfer.transferred - s.bytes) / dt;
    s.rate = s.rate === 0 ? instant : s.rate * 0.7 + instant * 0.3;
    s.at = now;
    s.bytes = transfer.transferred;
  }

  const remaining = transfer.size - transfer.transferred;
  const etaSeconds = s.rate > 1 ? remaining / s.rate : null;
  return { rate: s.rate, etaSeconds };
}

function formatEta(seconds: number): string {
  const clamped = Math.max(0, Math.round(seconds));
  const m = Math.floor(clamped / 60);
  const sec = clamped % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function TransferRow({
  transfer,
  client,
  i18n,
}: {
  transfer: TransferView;
  client: GSendClient;
  i18n: Translator;
}) {
  const { t } = i18n;
  const { rate, etaSeconds } = useRate(transfer);

  const pct = transfer.size > 0 ? Math.min(100, (transfer.transferred / transfer.size) * 100) : 0;
  const filled = Math.round((pct / 100) * BAR_CELLS);
  const active = transfer.status === "active" || transfer.status === "pending";
  const stopped = transfer.status === "cancelled" || transfer.status === "error";
  const done = transfer.status === "done";

  const fillClass = done
    ? "bar__fill bar__fill--done"
    : stopped
      ? "bar__fill bar__fill--dim"
      : "bar__fill";
  const restChar = stopped ? "╳" : "░";
  const restClass = stopped ? "bar__rest bar__rest--dead" : "bar__rest";

  const problem = transfer.problem
    ? t(`cancel.${transfer.problem.code}`, { limit: transfer.problem.limit ?? 0 })
    : null;

  const metaParts: string[] = [];
  if (transfer.status === "active" && rate > 1) {
    metaParts.push(`${formatBytes(rate)}/s`);
    if (etaSeconds !== null) metaParts.push(`eta ${formatEta(etaSeconds)}`);
  }
  metaParts.push(`${formatBytes(transfer.transferred)} / ${formatBytes(transfer.size)}`);
  if (done) metaParts.push(transfer.direction === "send" ? t("row.sent") : t("row.received"));
  if (stopped) metaParts.push(problem ?? t("row.cancelled"));
  if (transfer.status === "paused") metaParts.push(t("row.paused"));
  if (transfer.status === "pending") metaParts.push(t("row.pending"));

  return (
    <li className={stopped ? "transfer transfer--dim" : "transfer"}>
      <div className="transfer__head">
        <span
          className={
            active && transfer.direction === "send"
              ? "transfer__arrow transfer__arrow--live"
              : "transfer__arrow"
          }
          aria-hidden="true"
        >
          {transfer.direction === "send" ? "↑" : "↓"}
        </span>
        <span className="transfer__name" title={transfer.name}>
          {transfer.name}
        </span>
        {done && transfer.downloadUrl && (
          <a className="btn btn--primary btn--tiny" href={transfer.downloadUrl} download={transfer.name}>
            {t("transfer.save")}
          </a>
        )}
        {active && (
          <button
            type="button"
            className="btn btn--secondary btn--tiny"
            onClick={() => client.cancelTransfer(transfer.id)}
          >
            {t("transfer.cancel")}
          </button>
        )}
      </div>

      <div
        className="transfer__bar"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span className="bar" aria-hidden="true">
          <span className={fillClass}>{"█".repeat(filled)}</span>
          <span className={restClass}>{restChar.repeat(BAR_CELLS - filled)}</span>
        </span>
        <span className="transfer__pct">{Math.floor(pct)}%</span>
      </div>

      <div className="transfer__meta">{metaParts.join(" · ")}</div>
    </li>
  );
}
