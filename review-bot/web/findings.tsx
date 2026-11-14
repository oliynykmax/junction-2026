// Findings: the full row used where findings stand on their own, the compact
// note used inside a change, and the finding body and suggested-fix renderers.

import { Fragment } from "preact";
import { VerdictBadge } from "./formal";
import { useMemo, useState } from "preact/hooks";
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
  severityCounts,
  sortFindings,
} from "./shared";

export function Findings({
  findings: unsorted,
  heading,
  empty,
  lineUrl,
}: {
  findings: readonly Finding[];
  heading: string;
  empty: string | null;
  lineUrl: LineUrl;
}) {
  const [cls, setCls] = useState<string | null>(null);
  const findings = useMemo(() => sortFindings(unsorted), [unsorted]);
  const classes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of findings)
      if (f.class) counts.set(f.class, (counts.get(f.class) ?? 0) + 1);
    return [...counts];
  }, [findings]);
  if (findings.length === 0 && empty === null) return null;
  const shown = cls ? findings.filter((f) => f.class === cls) : findings;

  return (
    <section class="section" aria-labelledby="findings-h">
      <div class="section-head">
        <h2 id="findings-h">{heading}</h2>
        <SeverityCounts findings={findings} />
      </div>
      {findings.length === 0 ? (
        <p class="empty">{empty}</p>
      ) : (
        <>
          {classes.length > 1 && (
            <div
              class="filter"
              role="group"
              aria-label="Filter findings by class"
            >
              <button
                type="button"
                aria-pressed={cls === null}
                onClick={() => setCls(null)}
              >
                All <span>{findings.length}</span>
              </button>
              {classes.map(([c, n]) => (
                <button
                  type="button"
                  key={c}
                  aria-pressed={cls === c}
                  onClick={() => setCls(cls === c ? null : c)}
                >
                  {c.replace("-", " ")} <span>{n}</span>
                </button>
              ))}
            </div>
          )}
          <ol class="rows">
            {shown.map((f) => (
              <FindingRow key={f.id} f={f} href={lineUrl(f.path, f.line)} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

export function SeverityCounts({ findings }: { findings: readonly Finding[] }) {
  const counts = severityCounts(findings);
  if (counts.length === 0) return null;
  return (
    <p class="counts">
      {counts.map(({ severity, count, blocking }) => (
        <span key={severity} class={blocking ? "alert" : ""}>
          {count} {severity}
          {blocking > 0 && blocking < count && ` (${blocking} blocking)`}
        </span>
      ))}
    </p>
  );
}

function Severity({ f }: { f: Finding }) {
  const blocking = isBlocking(f);
  return (
    <p
      class={`sev${blocking ? " alert" : QUIET.has(f.severity) ? "" : " notable"}`}
    >
      <span class="explained" title={SEVERITY_MEANING[f.severity]}>
        {f.severity} severity
      </span>
      {!QUIET.has(f.severity) && (
        <span class="explained held" title={BLOCKING_RULE}>
          {" · "}
          {blocking
            ? "blocks"
            : heldBack(f)
              ? "not confirmed, doesn't block"
              : "doesn't block"}
        </span>
      )}
    </p>
  );
}

function Tags({ f }: { f: Finding }) {
  return (
    <p class="tags">
      {f.confidence && (
        <span class="tag" title={CONFIDENCE_MEANING[f.confidence]}>
          <span class="tag-key">confidence</span> {f.confidence}
        </span>
      )}
      {f.class && (
        <span class="tag" title="The kind of problem.">
          <span class="tag-key">class</span> {f.class.replace("-", " ")}
        </span>
      )}
      {f.source && f.source !== "agent" && (
        <span class="tag" title="A scanner flagged this; the AI confirmed it.">
          <span class="tag-key">from</span> {f.source}
        </span>
      )}
    </p>
  );
}

function FindingRow({ f, href }: { f: Finding; href: string }) {
  const [open, setOpen] = useState(false);
  return (
    <li class={`grid row${QUIET.has(f.severity) ? " quiet" : ""}`}>
      <div class="row-head">
        <Severity f={f} />
        <h3>{f.title}</h3>
        <Tags f={f} />
        {f.verdict && <VerdictBadge verdict={f.verdict} />}
        <a class="loc" href={href}>
          {location(f)}
        </a>
        {f.suggestedPatch && (
          <button
            type="button"
            class="toggle"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? "Hide suggested fix" : "Show suggested fix"}
          </button>
        )}
      </div>
      <div class="row-body">
        <FindingDetails f={f} />
        {open && f.suggestedPatch && <Fix patch={f.suggestedPatch} />}
      </div>
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
