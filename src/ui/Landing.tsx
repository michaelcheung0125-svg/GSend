import { useEffect, useRef, useState } from "react";
import type { GSendClient, Snapshot } from "../core/client";
import {
  chooseSaveDirectory,
  directPickerSupported,
  formatBytes,
  maxFileBytes,
  prepareStorage,
} from "../core/sink";
import { useI18n } from "../i18n";

interface Props {
  client: GSendClient;
  state: Snapshot;
  prefill: string;
}

const CODE_LENGTH = 4;

export default function Landing({ client, state, prefill }: Props) {
  const { t, tm } = useI18n();
  const [code, setCode] = useState(prefill);
  const [focused, setFocused] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const [limit, setLimit] = useState(() => maxFileBytes());
  const fileInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (prefill) setCode(prefill);
  }, [prefill]);

  // The ceiling depends on whether this browser will actually give us disk.
  useEffect(() => {
    let cancelled = false;
    void prepareStorage().then(() => {
      if (!cancelled) setLimit(maxFileBytes());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const staged = files.length > 0 || draft.trim().length > 0;

  const start = () => client.host(files, draft.trim() || null);

  // The design pairs the start button with an "↵ enter" hint; honour it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      const active = document.activeElement as HTMLElement | null;
      if (active === codeInput.current) return;
      const tag = active?.tagName;
      if (tag === "BUTTON" || tag === "INPUT" || tag === "A" || tag === "TEXTAREA") return;
      start();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const add = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setFiles((current) => [...current, ...list]);
    if (fileInput.current) fileInput.current.value = "";
  };

  /**
   * The folder picker needs transient user activation, and activation does not survive
   * the round trip to the other device — so the destination is chosen here, on the same
   * click that joins, and every file this session brings in goes straight into it.
   */
  const join = async (event: React.FormEvent) => {
    event.preventDefault();
    if (code.length !== CODE_LENGTH) return;

    const ceiling = formatBytes(maxFileBytes());
    const folder = directPickerSupported() ? await chooseSaveDirectory() : null;
    client.join(code);
    if (!folder) client.noticeStorageFallback(ceiling);
  };

  const stagedBytes = files.reduce((sum, file) => sum + file.size, 0);
  // Two sentences rather than one interpolation: "up to your free disk per file" is not
  // a sentence, and the two cases are genuinely different claims.
  const limitLine = directPickerSupported()
    ? t("landing.limitDisk")
    : t("landing.limitSize", { size: formatBytes(limit) });

  return (
    <section className="screen">
      <div>
        <div className="kicker">{t("landing.kicker")}</div>
        <h1 className="display">{t("landing.title")}</h1>
        <p className="lede">
          {t("landing.subtitle")} {limitLine}
        </p>

        {state.error && (
          <p className="alert" style={{ marginBottom: 20, maxWidth: "46ch" }}>
            {tm(state.error)}
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
            add(event.dataTransfer.files);
          }}
        >
          <span className="dropzone__glyph" aria-hidden="true">
            ↑
          </span>
          <p className="dropzone__hint">{t("landing.dropHere")}</p>
          <button
            type="button"
            className="btn btn--secondary btn--block"
            onClick={() => fileInput.current?.click()}
          >
            {t("landing.chooseFiles")}
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => add(event.target.files)}
          />
        </div>

        <div className="composer" style={{ marginTop: 14 }}>
          <input
            className="composer__input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t("landing.textPlaceholder")}
            aria-label={t("landing.textLabel")}
          />
        </div>

        {files.length > 0 && (
          <p className="alert alert--soft" style={{ marginTop: 14 }}>
            {t("landing.staged", { count: files.length, size: formatBytes(stagedBytes) })}
            <button
              type="button"
              className="btn btn--ghost btn--tiny"
              style={{ marginLeft: 10 }}
              onClick={() => setFiles([])}
            >
              {t("landing.clear")}
            </button>
          </p>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 18, marginTop: 22 }}>
          <button type="button" className="btn btn--primary btn--lg" onClick={start}>
            {t("landing.getCode")}
          </button>
          <span className="enter-hint">↵ enter</span>
        </div>

        {!staged && (
          <p className="sub" style={{ marginTop: 16, maxWidth: "48ch" }}>
            {t("landing.receiveOnly")}
          </p>
        )}
      </div>

      <div className="screen__rule" aria-hidden="true" />

      <div>
        <h4 className="side-title">{t("landing.orJoin")}</h4>
        <p className="sub" style={{ marginBottom: 20 }}>
          {t("landing.joinSub")}
        </p>

        <form className="code-form" onSubmit={(event) => void join(event)}>
          <div className="code-entry">
            {Array.from({ length: CODE_LENGTH }, (_, index) => {
              const digit = code[index];
              const active = focused && index === Math.min(code.length, CODE_LENGTH - 1);
              const cls = [
                "code-entry__cell",
                digit === undefined && "code-entry__cell--empty",
                active && "code-entry__cell--active",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <span key={index} className={cls}>
                  {digit ?? (active ? <span className="code-entry__caret">▏</span> : "0")}
                </span>
              );
            })}
            {/*
              The real input sits invisibly over the cells: taps focus it, the numeric
              keyboard opens, autofill still works, and the cells render its value.
            */}
            <input
              ref={codeInput}
              className="code-input"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 4))}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label={t("landing.codeLabel")}
            />
          </div>
          <button
            type="submit"
            className="btn btn--secondary btn--block"
            disabled={code.length !== CODE_LENGTH}
          >
            {t("landing.join")}
          </button>
        </form>

        {directPickerSupported() && (
          <p className="sub" style={{ marginTop: 16 }}>
            {t("landing.joinFolderHint")}
          </p>
        )}

        <hr className="hr" />
        <div className="footnote">
          <span>{t("landing.qrHint")}</span>
        </div>
      </div>
    </section>
  );
}
