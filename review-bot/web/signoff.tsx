// The owner's sign-off: the one place on the page where a named human, signed
// in with GitHub, takes responsibility for this exact commit. They say what
// they checked, what was not checked, the risk they accept, and decide every
// blocking finding with a reason. Once signed, the record is shown instead.

import { useEffect, useState } from "preact/hooks";
import { blocks } from "../src/findings";
import type { ReviewView } from "../src/review";
import type { SignOff } from "../src/signoff";
import { location, plural } from "./shared";

type Me = { configured: boolean; login: string | null };
type Decision = { decision: "accept" | "dismiss" | null; reason: string };

function useMe(enabled: boolean) {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    if (!enabled) return;
    fetch("/api/me", { cache: "no-store" })
      .then((r) => r.json() as Promise<Me>)
      .then(setMe, () => setMe({ configured: false, login: null }));
  }, [enabled]);
  return me;
}

/** This review page, scrolled to the sign-off, for returning after sign-in. */
const here = () =>
  `${window.location.pathname}${window.location.search}#sign-off`;

export function SignOffSection({
  view,
  api,
  signed,
  onSigned,
}: {
  view: ReviewView;
  api: string | null;
  signed: SignOff | null;
  onSigned: (s: SignOff) => void;
}) {
  const done = view.status === "done";
  const me = useMe(Boolean(api) && done && !signed);

  let body;
  if (signed) body = <Signed s={signed} api={api} onSigned={onSigned} />;
  else if (!api)
    body = (
      <p class="empty">
        This is a public review, with no named owner on this page. Sign-off is
        available on reviews of repositories where Bumble Bot is installed.
      </p>
    );
  else if (!done)
    body = (
      <p class="empty">
        {view.status === "failed"
          ? "The review did not finish, so there is no evidence to sign against. Review the change yourself."
          : "You can sign off when the review finishes."}
      </p>
    );
  else if (!me) body = <p class="empty">Checking who you are…</p>;
  else if (!me.configured)
    body = <p class="empty">GitHub sign-in is not configured here.</p>;
  else if (!me.login)
    body = (
      <div class="signin">
        <p>
          Signing off needs your GitHub identity and write access to the
          repository.
        </p>
        <a
          class="button"
          href={`/auth/login?return=${encodeURIComponent(here())}`}
        >
          Sign in with GitHub
        </a>
      </div>
    );
  else
    body = (
      <SignOffForm view={view} api={api} login={me.login} onSigned={onSigned} />
    );

  return (
    <section class="section signoff" id="sign-off" aria-labelledby="so-h">
      <div class="section-head">
        <h2 id="so-h">Owner sign-off</h2>
        {view.review.target && (
          <p class="counts">
            <span>commit {view.review.target.headSha.slice(0, 7)}</span>
          </p>
        )}
      </div>
      {body}
    </section>
  );
}

function SignOffForm({
  view,
  api,
  login,
  onSigned,
}: {
  view: ReviewView;
  api: string;
  login: string;
  onSigned: (s: SignOff) => void;
}) {
  const blocking = view.review.findings.filter(blocks);
  const aiNotChecked = view.review.verdict?.notChecked ?? [];
  const sha = view.review.target?.headSha.slice(0, 7) ?? "";
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [checked, setChecked] = useState("");
  const [notChecked, setNotChecked] = useState("");
  const [risk, setRisk] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decided = (id: string) => {
    const d = decisions[id];
    return Boolean(d?.decision && d.reason.trim());
  };
  const ready =
    checked.trim() &&
    risk.trim() &&
    confirm &&
    blocking.every((f) => decided(f.id));
  const set = (id: string, patch: Partial<Decision>) =>
    setDecisions((all) => ({
      ...all,
      [id]: { ...(all[id] ?? { decision: null, reason: "" }), ...patch },
    }));

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(api, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          checked,
          notChecked,
          risk,
          confirm,
          dispositions: blocking.map((f) => ({
            findingId: f.id,
            ...decisions[f.id],
          })),
        }),
      });
      const body = (await res.json()) as SignOff & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      onSigned(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="so-form" onSubmit={submit}>
      <p class="so-lede">
        Signed in as <strong>@{login}</strong> ·{" "}
        <a href={`/auth/logout?return=${encodeURIComponent(here())}`}>
          sign out
        </a>
        . You are signing for commit <code>{sha}</code> only. A later push needs
        a new sign-off.
      </p>

      {blocking.length > 0 && (
        <fieldset class="so-field">
          <legend>
            {plural(blocking.length, "blocking finding")}: accept or dismiss
            each, with a reason
          </legend>
          <ol class="so-findings">
            {blocking.map((f) => {
              const d = decisions[f.id];
              return (
                <li key={f.id}>
                  <p class="so-finding-title">
                    <span class="alert">{f.severity}</span> {f.title}{" "}
                    <code class="muted">{location(f)}</code>
                  </p>
                  <div class="so-choice" role="radiogroup">
                    <label>
                      <input
                        type="radio"
                        name={`d-${f.id}`}
                        checked={d?.decision === "accept"}
                        onChange={() => set(f.id, { decision: "accept" })}
                      />{" "}
                      Real, and I accept the risk
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`d-${f.id}`}
                        checked={d?.decision === "dismiss"}
                        onChange={() => set(f.id, { decision: "dismiss" })}
                      />{" "}
                      Not a real problem
                    </label>
                  </div>
                  <textarea
                    aria-label={`Reason for ${f.title}`}
                    placeholder="Why? Name what you looked at."
                    rows={2}
                    maxLength={4000}
                    value={d?.reason ?? ""}
                    onInput={(e) =>
                      set(f.id, { reason: e.currentTarget.value })
                    }
                  />
                </li>
              );
            })}
          </ol>
        </fieldset>
      )}

      <label class="so-field">
        <span class="so-label">What I checked myself</span>
        <textarea
          required
          rows={3}
          maxLength={4000}
          placeholder="For example: read the change story against the requirement, read the code around each blocking finding, ran the tests locally."
          value={checked}
          onInput={(e) => setChecked(e.currentTarget.value)}
        />
      </label>

      <div class="so-field">
        <span class="so-label">Not checked</span>
        {aiNotChecked.length > 0 && (
          <ul class="so-ai">
            {aiNotChecked.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
        <textarea
          aria-label="What else I did not check, and why"
          rows={2}
          maxLength={4000}
          placeholder="What else you did not check, and why. The AI's list above is included."
          value={notChecked}
          onInput={(e) => setNotChecked(e.currentTarget.value)}
        />
      </div>

      <label class="so-field">
        <span class="so-label">Residual risk I accept</span>
        <textarea
          required
          rows={2}
          maxLength={4000}
          placeholder="What could still go wrong, and why it is acceptable."
          value={risk}
          onInput={(e) => setRisk(e.currentTarget.value)}
        />
      </label>

      <label class="so-confirm">
        <input
          type="checkbox"
          checked={confirm}
          onChange={(e) => setConfirm(e.currentTarget.checked)}
        />{" "}
        I, @{login}, own this change at <code>{sha}</code>. The AI review is
        evidence I read, not the approval.
      </label>

      {error && (
        <p class="alert" role="alert">
          {error}
        </p>
      )}
      <button class="button" type="submit" disabled={!ready || busy}>
        {busy ? "Signing…" : `Sign off as @${login}`}
      </button>
    </form>
  );
}

function Signed({
  s,
  api,
  onSigned,
}: {
  s: SignOff;
  api: string | null;
  onSigned: (s: SignOff) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-sends only the GitHub writes that failed; the record itself is fixed.
  const retry = async () => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(api, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = (await res.json()) as SignOff & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      onSigned(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const failed = s.echo
    ? [
        !s.echo.comment.ok && `PR comment: ${s.echo.comment.error}`,
        !s.echo.status.ok && `commit status: ${s.echo.status.error}`,
      ].filter(Boolean)
    : // Stored, but stopped before the GitHub writes finished.
      ["the PR comment and commit status were not written"];
  return (
    <div class="so-record">
      <p class="so-who">
        Signed off by{" "}
        <a href={`https://github.com/${s.signer.login}`}>
          <strong>@{s.signer.login}</strong>
        </a>{" "}
        ({s.permission} access) on{" "}
        <time dateTime={new Date(s.at).toISOString()}>
          {new Date(s.at).toLocaleString()}
        </time>{" "}
        for commit <code>{s.headSha.slice(0, 7)}</code>.
      </p>
      <dl class="so-dl">
        <div>
          <dt>Checked by the owner</dt>
          <dd>{s.checked}</dd>
        </div>
        <div>
          <dt>Checked by the AI</dt>
          <dd>
            This review: {plural(s.findings.total, "finding")},{" "}
            {s.findings.blocking} blocking.
          </dd>
        </div>
        {s.dispositions.length > 0 && (
          <div>
            <dt>Blocking findings</dt>
            <dd>
              <ul class="so-ai">
                {s.dispositions.map((d) => (
                  <li key={d.findingId}>
                    <strong>
                      {d.decision === "accept" ? "Risk accepted" : "Dismissed"}
                    </strong>
                    : {d.title}. <em>{d.reason}</em>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        <div>
          <dt>Not checked</dt>
          <dd>
            {s.aiNotChecked.length > 0 && (
              <ul class="so-ai">
                {s.aiNotChecked.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
            {s.notChecked ||
              (s.aiNotChecked.length === 0 ? "Nothing listed." : null)}
          </dd>
        </div>
        <div>
          <dt>Residual risk accepted</dt>
          <dd>{s.risk}</dd>
        </div>
      </dl>
      {failed.length > 0 && (
        <p class="alert">
          Saved here, but not echoed to GitHub: {failed.join("; ")}.{" "}
          {api && (
            <button
              type="button"
              class="toggle"
              disabled={busy}
              onClick={retry}
            >
              {busy ? "Retrying…" : "Retry"}
            </button>
          )}
        </p>
      )}
      {error && (
        <p class="alert" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
