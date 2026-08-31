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
    <section className="panel">
      <ConnectionBar state={state} i18n={i18n} />

      {state.notice && (
        <p className="alert alert--soft" onClick={() => client.dismissNotice()}>
          {tm(state.notice)}
        </p>
      )}

      <div
        className={dragging ? "dropzone dropzone--active" : "dropzone"}
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
        <p className="dropzone__hint">{t("transfer.dropHere")}</p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => fileInput.current?.click()}
        >
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
        <button type="submit" className="btn" disabled={!draft.trim()}>
          {t("transfer.send")}
        </button>
      </form>

      {state.texts.length > 0 && (
        <ul className="messages">
          {state.texts
            .slice()
            .reverse()
            .map((message) => (
              <li key={message.id} className={message.mine ? "message message--mine" : "message"}>
                <span className="message__body">{message.body}</span>
                <button
                  type="button"
                  className="btn btn--tiny"
                  onClick={() => void navigator.clipboard.writeText(message.body).catch(() => {})}
                >
                  {t("transfer.copy")}
                </button>
              </li>
            ))}
        </ul>
      )}

      {transfers.length > 0 && (
        <ul className="transfers">
          {transfers.map((transfer) => (
            <TransferRow key={transfer.id} transfer={transfer} client={client} i18n={i18n} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ConnectionBar({ state, i18n }: { state: Snapshot; i18n: Translator }) {
  const online = state.connection === "connected" && state.channelsOpen;
  const label = online
    ? i18n.t("status.connected")
    : state.peerAbsentSince !== null && !state.channelsOpen
      ? i18n.t("status.peerAway")
      : state.connection === "reconnecting"
        ? i18n.t("status.reconnecting")
        : state.connection === "failed"
          ? i18n.t("status.lost")
          : i18n.t("status.connecting");

  return (
    <div className={online ? "status status--ok" : "status status--warn"}>
      <span className="status__dot" aria-hidden="true" />
      {label}
    </div>
  );
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
  const percent = transfer.size > 0 ? Math.min(100, (transfer.transferred / transfer.size) * 100) : 0;
  const active = transfer.status === "active" || transfer.status === "pending";

  return (
    <li className="transfer">
      <div className="transfer__head">
        <span className="transfer__arrow" aria-hidden="true">
          {transfer.direction === "send" ? "↑" : "↓"}
        </span>
        <span className="transfer__name" title={transfer.name}>
          {transfer.name}
        </span>
        <span className="transfer__size">{formatBytes(transfer.size)}</span>
      </div>

      <div className="progress" role="progressbar" aria-valuenow={Math.round(percent)}>
        <div
          className={`progress__bar progress__bar--${transfer.status}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="transfer__foot">
        <span className="muted">{describe(transfer, percent, i18n)}</span>
        {transfer.status === "done" && transfer.downloadUrl && (
          <a className="btn btn--tiny" href={transfer.downloadUrl} download={transfer.name}>
            {i18n.t("transfer.save")}
          </a>
        )}
        {active && (
          <button
            type="button"
            className="btn btn--tiny"
            onClick={() => client.cancelTransfer(transfer.id)}
          >
            {i18n.t("transfer.cancel")}
          </button>
        )}
      </div>
    </li>
  );
}

function describe(transfer: TransferView, percent: number, { t }: Translator): string {
  // A stopped transfer carries a code rather than a sentence, because the device that
  // stopped it may be running a different language from the one reading this.
  const problem = transfer.problem
    ? t(`cancel.${transfer.problem.code}`, { limit: transfer.problem.limit ?? 0 })
    : null;

  switch (transfer.status) {
    case "done":
      return transfer.direction === "send" ? t("row.sent") : t("row.received");
    case "cancelled":
      return problem ?? t("row.cancelled");
    case "error":
      return problem ?? t("row.failed");
    case "paused":
      return t("row.paused");
    case "pending":
      return t("row.pending");
    default:
      return t("row.progress", {
        percent: Math.floor(percent),
        transferred: formatBytes(transfer.transferred),
      });
  }
}
