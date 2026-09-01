import { useEffect, useRef, useState } from "react";
import type { GSendClient, Snapshot } from "../core/client";
import { formatBytes, maxFileBytes, prepareStorage } from "../core/sink";
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
  const [limit, setLimit] = useState(() => maxFileBytes());
  const inputRef = useRef<HTMLInputElement>(null);

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

  // The design pairs the start button with an "↵ enter" hint; honour it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      if (document.activeElement === inputRef.current) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "BUTTON" || tag === "INPUT" || tag === "A") return;
      client.host();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [client]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    client.join(code);
  };

  return (
    <section className="screen">
      <div>
        <div className="kicker">{t("landing.kicker")}</div>
        <h1 className="display">{t("landing.title")}</h1>
        <p className="lede">{t("landing.subtitle", { size: formatBytes(limit) })}</p>

        {state.error && <p className="alert" style={{ marginBottom: 20, maxWidth: "46ch" }}>{tm(state.error)}</p>}

        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <button type="button" className="btn btn--primary btn--lg" onClick={() => client.host()}>
            {t("landing.start")}
          </button>
          <span className="enter-hint">↵ enter</span>
        </div>
      </div>

      <div className="screen__rule" aria-hidden="true" />

      <div>
        <h4 className="side-title">{t("landing.orJoin")}</h4>
        <p className="sub" style={{ marginBottom: 20 }}>
          {t("landing.joinSub")}
        </p>

        <form className="code-form" onSubmit={submit}>
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
              ref={inputRef}
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
          <button type="submit" className="btn btn--secondary btn--block" disabled={code.length !== 4}>
            {t("landing.join")}
          </button>
        </form>

        <hr className="hr" />
        <div className="footnote">
          <span>{t("landing.qrHint")}</span>
        </div>
      </div>
    </section>
  );
}
