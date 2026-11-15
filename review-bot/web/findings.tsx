// Findings: the full row used where findings stand on their own, the compact
// note used inside a change, and the finding body and suggested-fix renderers.

import { Fragment } from "preact";
import { useMemo, useState } from "preact/hooks";
import type { VerificationReceipt } from "../src/formal";
import type { ViewedVerdict } from "../src/review";
import type { VerifierState } from "../src/verifier";
import {
  RECEIPT_DISCLOSURE,
  VerdictBadge,
  VerdictNode,
  VerifierChecks,
  verifierLine,
} from "./formal";
import { heldBack } from "../src/findings";
import {
  BLOCKING_RULE,
  CONFIDENCE_MEANING,
  type Finding,
  isBlocking,
  type LineUrl,
  location,
  QUIET,
  SEVERITY_MEANING,
  sortFindings,
} from "./shared";

export function Findings({
  findings: unsorted,
  verifications,
  verifier,
  empty,
  lineUrl,
}: {
  findings: readonly ViewedFinding[];
  verifications: readonly VerificationReceipt[];
  verifier: VerifierState | undefined;
  empty: string | null;
  lineUrl: LineUrl;
}) {
  const findings = useMemo(() => sortFindings(unsorted), [unsorted]);
  const linked = new Set(findings.map((f) => f.verdict?.receiptId));
  const unlinked = verifications.filter((r) => !linked.has(r.id));
  if (
    findings.length === 0 &&
    unlinked.length === 0 &&
    !verifier &&
    empty === null
  )
    return null;
  return (
    <section class="section" aria-labelledby="findings-h">
      <div class="findings-head">
        <h2 id="findings-h">Findings</h2>
        {verifier && <p class="findings-note">{verifierLine(verifier)}</p>}
        {(verifier || verifications.length > 0) && (
          <p class="findings-note">{RECEIPT_DISCLOSURE}</p>
        )}
      </div>
      {findings.length === 0 ? (
        empty && <p class="empty">{empty}</p>
      ) : (
        <ol class="findings">
          {findings.map((f) => (
            <FindingRow key={f.id} f={f} href={lineUrl(f.path, f.line)} />
          ))}
        </ol>
      )}
      <VerifierChecks
        checks={verifier && verifier.status !== "blind" ? verifier.checks : []}
        receipts={unlinked}
      />
    </section>
  );
}

type ViewedFinding = Finding & { verdict?: ViewedVerdict };

/** Severity in words, with whether it blocks the decision. */
function severityText(f: Finding): string {
  if (QUIET.has(f.severity)) return `${f.severity} severity`;
  return `${f.severity} severity · ${
    isBlocking(f)
      ? "blocks"
      : heldBack(f)
        ? "not confirmed, doesn't block"
        : "doesn't block"
  }`;
}

function fixStatus(f: ViewedFinding): string {
  const outcome = f.verdict?.receipt?.fixCheck?.outcome;
  return outcome === "passed"
    ? "Fix tested on scratch copy. "
    : outcome === "failed"
      ? "Proposed fix, scratch check failed. "
      : "Proposed fix, not tested. ";
}

// A finding, then its evidence and the verifier's result, joined by one line.
function FindingRow({ f, href }: { f: ViewedFinding; href: string }) {
  const [open, setOpen] = useState(false);
  const kind = f.class ?? "unclassified";
  return (
    <li class={`finding${isBlocking(f) ? " blocking" : ""}`}>
      <ol class="trail" style={`--kind: var(--kind-${kind})`}>
        <li class="node node-finding">
          <p class="finding-meta">
            <span class="kind">{kind.replace("-", " ")}</span>
            <span
              class="explained finding-sev"
              title={`${SEVERITY_MEANING[f.severity]} ${BLOCKING_RULE}`}
            >
              {severityText(f)}
            </span>
            {f.confidence && (
              <span class="explained" title={CONFIDENCE_MEANING[f.confidence]}>
                {f.confidence}
              </span>
            )}
            {f.source && f.source !== "agent" && (
              <span title="A scanner flagged this; the AI confirmed it.">
                from {f.source}
              </span>
            )}
            <a class="loc" href={href}>
              {location(f)}
            </a>
          </p>
          <h3>{f.title}</h3>
          <Body text={f.body} />
          {f.reason && <p class="body muted">{f.reason}</p>}
          {f.fix && (
            <p class="body">
              <strong>{fixStatus(f)}</strong>
              {f.fix}
            </p>
          )}
          {f.suggestedPatch && (
            <button
              type="button"
              class="toggle"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open ? "Hide suggested patch" : "Show suggested patch"}
            </button>
          )}
          {open && f.suggestedPatch && <Fix patch={f.suggestedPatch} />}
        </li>
        {f.evidence && (
          <li class="node">
            <p class="node-label">Evidence · {f.evidence.kind}</p>
            <p class="body">{f.evidence.detail}</p>
          </li>
        )}
        {f.evidence?.supporting?.map((item) => (
          <li class="node" key={item}>
            <p class="node-label">Supporting evidence</p>
            <p class="body">{item}</p>
          </li>
        ))}
        {f.verdict && <VerdictNode verdict={f.verdict} />}
      </ol>
    </li>
  );
}

/**
 * A finding inside a change: severity, title and location, with the body and
 * fix behind a toggle. Selecting the location shows its line in the diff.
 */
export function FindingNote({
  f,
  focused,
  onLocate,
}: {
  f: Finding;
  focused: boolean;
  onLocate: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const attention = isBlocking(f);
  return (
    <li
      class={`note-finding${attention ? " attention" : ""}${focused ? " focused" : ""}`}
    >
      <p class="note-title">{f.title}</p>
      <div class="note-meta">
        <NoteFacts f={f} />
        {f.verdict && <VerdictBadge verdict={f.verdict} />}
        {onLocate ? (
          <button
            type="button"
            class="loc loc-button"
            aria-pressed={focused}
            title={`${location(f)}: show this line in the diff`}
            onClick={onLocate}
          >
            {shortLocation(f)}
          </button>
        ) : (
          <span class="loc" title={location(f)}>
            {shortLocation(f)}
          </span>
        )}
        <button
          type="button"
          class="toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide details" : "Details"}
        </button>
      </div>
      {f.evidence && (
        <p class="body">
          Evidence ({f.evidence.kind}): {f.evidence.detail}
        </p>
      )}
      {open && (
        <div class="note-body">
          <FindingDetails f={f} />
          {f.suggestedPatch && <Fix patch={f.suggestedPatch} />}
        </div>
      )}
    </li>
  );
}

// The file name and line, with the full path left to the tooltip.
const shortLocation = (f: Finding) =>
  location({ path: f.path.split("/").pop() ?? f.path, line: f.line });

/** Severity, confidence, class and blocking state as one line of plain text. */
function NoteFacts({ f }: { f: Finding }) {
  const blocking = isBlocking(f);
  const facts = [
    <span
      class={`note-sev${blocking ? " alert" : QUIET.has(f.severity) ? "" : " notable"}`}
      title={SEVERITY_MEANING[f.severity]}
    >
      {f.severity}
    </span>,
    f.confidence && (
      <span title={CONFIDENCE_MEANING[f.confidence]}>{f.confidence}</span>
    ),
    f.class && (
      <span title="The kind of problem.">{f.class.replace("-", " ")}</span>
    ),
    f.source && f.source !== "agent" && (
      <span title="A scanner flagged this; the AI confirmed it.">
        from {f.source}
      </span>
    ),
    blocking ? (
      <span class="alert" title={BLOCKING_RULE}>
        blocks
      </span>
    ) : (
      heldBack(f) && <span title={BLOCKING_RULE}>not confirmed, check it</span>
    ),
  ].filter(Boolean);
  return (
    <span class="note-facts">
      {facts.map((fact, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden="true"> · </span>}
          {fact}
        </Fragment>
      ))}
    </span>
  );
}

export function FindingDetails({ f }: { f: Finding }) {
  return (
    <>
      <Body text={f.body} />
      {f.reason && (
        <p class="body">
          <strong>Why it matters. </strong>
          {f.reason}
        </p>
      )}
      {f.evidence && (
        <p class="body">
          <strong>Evidence ({f.evidence.kind}). </strong>
          {f.evidence.detail}
        </p>
      )}
      {f.evidence?.supporting?.map((item) => (
        <p class="body" key={item}>
          {item}
        </p>
      ))}
      {f.fix && (
        <p class="body">
          <strong>
            {f.verdict?.receipt?.fixCheck?.outcome === "passed"
              ? "Fix tested on scratch copy. "
              : f.verdict?.receipt?.fixCheck?.outcome === "failed"
                ? "Proposed fix, scratch check failed. "
                : "Proposed fix, not tested. "}
          </strong>
          {f.fix}
        </p>
      )}
      {f.verdict && (
        <p class="body">
          <strong>Verifier. </strong>
          {f.verdict.note}
        </p>
      )}
    </>
  );
}

function Fix({ patch }: { patch: string }) {
  return (
    <div class="fix">
      <p class="fix-label">Suggested fix</p>
      <Patch text={patch} />
      <button type="button" disabled title="Not wired up yet">
        Open fix PR (coming soon)
      </button>
    </div>
  );
}

// Finding bodies end with "Docs: <url>" lines for the pages they rely on.
export function Body({ text }: { text: string }) {
  const docs: string[] = [];
  const prose = text
    .split("\n")
    .filter((line) => {
      const m = line.match(/^\s*Docs:\s*(https?:\/\/\S+)\s*$/);
      if (m) docs.push(m[1]);
      return !m;
    })
    .join("\n")
    .trim();
  return (
    <>
      <p class="body">
        {prose
          .split(/(`[^`\n]+`)/)
          .map((part, i) =>
            part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
              <code key={i}>{part.slice(1, -1)}</code>
            ) : (
              part
            ),
          )}
      </p>
      {docs.length > 0 && (
        <ul class="doc-links">
          {docs.map((u) => (
            <li key={u}>
              Docs: <a href={u}>{u}</a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Patch({ text }: { text: string }) {
  return (
    <pre class="patch">
      {text.split("\n").map((line, i) => (
        <span
          key={i}
          class={
            line.startsWith("+") && !line.startsWith("+++")
              ? "add"
              : line.startsWith("-") && !line.startsWith("---")
                ? "del"
                : line.startsWith("@@")
                  ? "hunk"
                  : undefined
          }
        >
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}
