import { useEffect, useRef, useState } from "react";
import type { GSendClient, Snapshot } from "../core/client";
import { directPickerSupported, formatBytes, maxFileBytes } from "../core/sink";
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
  const [joinDismissed, setJoinDismissed] = useState(false);
  const compact = useMediaQuery("(max-width: 860px)");

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

        {/*
          What replaced the approval screen: the sender is told the instant a device is
          through, with the kill switch in the same breath rather than a step earlier.
        */}
        {state.role === "host" && state.channelsOpen && !joinDismissed && (
          <p className="alert" style={{ marginBottom: 14 }}>
            {t("transfer.peerJoined")}
            <button
              type="button"
              className="btn btn--danger btn--tiny"
              style={{ marginLeft: 10 }}
              onClick={() => client.leave()}
            >
              {t("transfer.stop")}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--tiny"
              style={{ marginLeft: 6 }}
              onClick={() => setJoinDismissed(true)}
            >
              {t("transfer.dismiss")}
            </button>
          </p>
        )}

        {state.notice && (
          <p className="alert alert--soft" style={{ marginBottom: 14 }} onClick={() => client.dismissNotice()}>
            {tm(state.notice)}
          </p>
        )}

        <ul className="transfers">
          {transfers.map((transfer) => (
            <TransferRow
              key={transfer.id}
              transfer={transfer}
              client={client}
              i18n={i18n}
              cells={compact ? 20 : 10}
            />
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
          <button type="button" className="btn btn--primary btn--block" onClick={() => fileInput.current?.click()}>
            {t("transfer.chooseFiles")}
          </button>
          <input ref={fileInput} type="file" multiple hidden onChange={(event) => pick(event.target.files)} />
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

        {!state.savingTo && directPickerSupported() && (
          <button
            type="button"
            className="btn btn--secondary btn--block"
            onClick={() => void client.chooseFolder()}
          >
            {t("transfer.chooseFolder")}
          </button>
        )}

        <div className="term term--muted">{statusBlock(state, t("transfer.limitDisk"))}</div>

        <hr className="hr" style={{ margin: "2px 0" }} />
        <p className="aside-note">
          {state.savingTo
            ? t("transfer.saveFolder", { folder: state.savingTo })
            : t("transfer.saveBrowser")}
        </p>
      </aside>
    </section>
  );
}

/**
 * The mono blocks are deliberately untranslated — they are the design's CLI voice —
 * except for the one word that has to say whether the ceiling is a number or the disk.
 */
function statusBlock(state: Snapshot, diskWord: string): string {
  const peer = state.relayEngaged ? "relay · turn" : "direct";
  const where = state.savingTo ?? "browser";
  const ceiling = state.savingTo ? diskWord : `${formatBytes(maxFileBytes())} / file`;
  return [
    `peer    ${peer}`,
    `saving  ${where}`,
    `limit   ${ceiling}`,
    `code    ${state.code ?? "----"} · burned`,
  ].join("\n");
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/* ── CLI progress rows ─────────────────────────────────────────────────── */

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

/** "267/418 MB" — one unit, so the column stays narrow. */
function formatPair(done: number, total: number): string {
  const totalText = formatBytes(total);
  const unit = totalText.split(" ")[1] ?? "";
  const div = unit === "GB" ? 1e9 : unit === "MB" ? 1e6 : unit === "KB" || unit === "kB" ? 1e3 : 1;
  const a = done / div;
  const b = total / div;
  const fmt = (n: number) => (n >= 100 || div === 1 ? Math.round(n).toString() : n.toFixed(1));
  return `${fmt(a)}/${fmt(b)} ${unit}`.trim();
}

function TransferRow({
  transfer,
  client,
  i18n,
  cells,
}: {
  transfer: TransferView;
  client: GSendClient;
  i18n: Translator;
  cells: number;
}) {
  const { t } = i18n;
  const { rate, etaSeconds } = useRate(transfer);

  const pct = transfer.size > 0 ? Math.min(100, (transfer.transferred / transfer.size) * 100) : 0;
  const filled = Math.round((pct / 100) * cells);
  const active = transfer.status === "active" || transfer.status === "pending";
  const stopped = transfer.status === "cancelled" || transfer.status === "error";
  const done = transfer.status === "done";

  const fillClass = done ? "bar__fill bar__fill--done" : stopped ? "bar__fill bar__fill--dim" : "bar__fill";
  const restChar = stopped ? "╳" : "░";
  const restClass = stopped ? "bar__rest bar__rest--dead" : "bar__rest";

  const problem = transfer.problem
    ? t(`cancel.${transfer.problem.code}`, { limit: transfer.problem.limit ?? 0 })
    : null;

  // Three stat cells. Anything empty collapses on phones and leaves its column blank on desktop.
  const live = transfer.status === "active" && rate > 1;
  const rateText = live ? `${formatBytes(rate)}/s` : "";
  const etaText = live && etaSeconds !== null ? `eta ${formatEta(etaSeconds)}` : "";
  const statusText = done
    ? transfer.direction === "send"
      ? t("row.sent")
      : t("row.received")
    : stopped
      ? (problem ?? t("row.cancelled"))
      : transfer.status === "paused"
        ? t("row.paused")
        : transfer.status === "pending"
          ? t("row.pending")
          : "";
  const bytesText = active && !statusText ? formatPair(transfer.transferred, transfer.size) : statusText;

  return (
    <li className={stopped ? "transfer transfer--dim" : "transfer"}>
      <span
        className={active && transfer.direction === "send" ? "transfer__arrow transfer__arrow--live" : "transfer__arrow"}
        aria-hidden="true"
      >
        {transfer.direction === "send" ? "↑" : "↓"}
      </span>
      <span className="transfer__name" title={transfer.name}>
        {transfer.name}
      </span>

      <span
        className="transfer__bar"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span className="bar" aria-hidden="true">
          <span className={fillClass}>{"█".repeat(filled)}</span>
          <span className={restClass}>{restChar.repeat(cells - filled)}</span>
        </span>
      </span>
      <span className="transfer__pct">{Math.floor(pct)}%</span>

      <span className="transfer__stats">
        <span className="transfer__stat transfer__stat--rate">{rateText}</span>
        <span className="transfer__stat transfer__stat--eta">{etaText}</span>
        <span className="transfer__stat transfer__stat--bytes" title={bytesText}>
          {bytesText}
        </span>
      </span>

      <span className="transfer__action">
        {done && transfer.savedAs && (
          <span className="transfer__saved" title={transfer.savedAs}>
            {t("row.savedTo", { name: transfer.savedAs })}
          </span>
        )}
        {done && transfer.downloadUrl && (
          <a className="btn btn--primary btn--tiny" href={transfer.downloadUrl} download={transfer.name}>
            {t("transfer.save")}
          </a>
        )}
        {active && (
          <button type="button" className="btn btn--secondary btn--tiny" onClick={() => client.cancelTransfer(transfer.id)}>
            {t("transfer.cancel")}
          </button>
        )}
      </span>
    </li>
  );
}
