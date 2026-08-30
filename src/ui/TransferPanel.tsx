import { useRef, useState } from "react";
import type { GSendClient, Snapshot } from "../core/client";
import { formatBytes } from "../core/sink";
import type { TransferView } from "../core/transfer";

interface Props {
  client: GSendClient;
  state: Snapshot;
}

export default function TransferPanel({ client, state }: Props) {
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
      <ConnectionBar state={state} />

      {state.notice && (
        <p className="alert alert--soft" onClick={() => client.dismissNotice()}>
          {state.notice}
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
        <p className="dropzone__hint">Drop files here</p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => fileInput.current?.click()}
        >
          Choose files
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
          placeholder="Send text or a link"
          aria-label="Text to send"
        />
        <button type="submit" className="btn" disabled={!draft.trim()}>
          Send
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
                  Copy
                </button>
              </li>
            ))}
        </ul>
      )}

      {transfers.length > 0 && (
        <ul className="transfers">
          {transfers.map((transfer) => (
            <TransferRow key={transfer.id} transfer={transfer} client={client} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ConnectionBar({ state }: { state: Snapshot }) {
  const online = state.connection === "connected" && state.channelsOpen;
  const label = online
    ? "Connected"
    : state.peerAbsentSince !== null
      ? "The other device dropped off — waiting for it to come back"
      : state.connection === "reconnecting"
        ? "Reconnecting…"
        : state.connection === "failed"
          ? "Connection lost"
          : "Connecting…";

  return (
    <div className={online ? "status status--ok" : "status status--warn"}>
      <span className="status__dot" aria-hidden="true" />
      {label}
    </div>
  );
}

function TransferRow({ transfer, client }: { transfer: TransferView; client: GSendClient }) {
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
        <span className="muted">{describe(transfer, percent)}</span>
        {transfer.status === "done" && transfer.downloadUrl && (
          <a className="btn btn--tiny" href={transfer.downloadUrl} download={transfer.name}>
            Save
          </a>
        )}
        {active && (
          <button
            type="button"
            className="btn btn--tiny"
            onClick={() => client.cancelTransfer(transfer.id)}
          >
            Cancel
          </button>
        )}
      </div>
    </li>
  );
}

function describe(transfer: TransferView, percent: number): string {
  switch (transfer.status) {
    case "done":
      return transfer.direction === "send" ? "Sent" : "Received";
    case "cancelled":
      return transfer.error ?? "Cancelled";
    case "error":
      return transfer.error ?? "Failed";
    case "paused":
      return "Paused — waiting to reconnect";
    case "pending":
      return "Waiting for the other device";
    default:
      return `${Math.floor(percent)}% · ${formatBytes(transfer.transferred)}`;
  }
}
