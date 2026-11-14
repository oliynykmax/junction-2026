// The PR as the agent split it: one row per logical change, with its tags,
// line counts and one-sentence summary, the findings in its files, and its
// diff inline.

import { useMemo, useState } from "preact/hooks";
import { FileDiffs } from "./diff";
import { FindingNote } from "./findings";
import {
  type Change,
  type ChangedFile,
  changeSentence,
  type Finding,
  type Focus,
  type LineUrl,
  plural,
  QUIET,
  sortFindings,
} from "./shared";

/** Assigns each finding to the first change whose files include its path. */
export function findingsByChange(
  changes: readonly Change[],
  findings: readonly Finding[],
) {
  const owned = new Map<string, Finding[]>(changes.map((c) => [c.id, []]));
  const other: Finding[] = [];
  for (const f of findings) {
    const change = changes.find((c) => c.files.includes(f.path));
    if (change) owned.get(change.id)?.push(f);
    else other.push(f);
  }
  return { owned, other };
}

export function Changes({
  changes,
  files,
  owned,
  running,
  lineUrl,
}: {
  changes: readonly Change[];
  files: readonly ChangedFile[];
  owned: Map<string, Finding[]>;
  running: boolean;
  lineUrl: LineUrl;
}) {
  const [tag, setTag] = useState<string | null>(null);
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of changes)
      for (const t of c.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts];
  }, [changes]);
  const shown = tag ? changes.filter((c) => c.tags.includes(tag)) : changes;

  return (
    <section class="section" aria-labelledby="changes-h">
      <div class="section-head">
        <h2 id="changes-h">Changes</h2>
        <p class="counts">
          <span>{plural(changes.length, "change")}</span>
          {files.length > 0 && <span>{plural(files.length, "file")}</span>}
        </p>
      </div>
      {changes.length === 0 ? (
        <p class="empty">
          {running
            ? "The agent describes the changes after it has read the patches."
            : "The agent did not describe the changes in this review."}
        </p>
      ) : (
        <>
          {tags.length > 1 && (
            <div class="filter" role="group" aria-label="Filter changes by tag">
              <button
                type="button"
                aria-pressed={tag === null}
                onClick={() => setTag(null)}
              >
                All <span>{changes.length}</span>
              </button>
              {tags.map(([t, n]) => (
                <button
                  type="button"
                  key={t}
                  aria-pressed={tag === t}
                  onClick={() => setTag(tag === t ? null : t)}
                >
                  {t} <span>{n}</span>
                </button>
              ))}
            </div>
          )}
          <ol class="rows">
            {shown.map((c) => (
              <ChangeRow
                key={c.id}
                change={c}
                files={files.filter((f) => c.files.includes(f.path))}
                findings={owned.get(c.id) ?? []}
                lineUrl={lineUrl}
              />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function ChangeRow({
  change,
  files,
  findings: unsorted,
  lineUrl,
}: {
  change: Change;
  files: readonly ChangedFile[];
  findings: readonly Finding[];
  lineUrl: LineUrl;
}) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<Focus>(null);
  const findings = useMemo(() => sortFindings(unsorted), [unsorted]);
  const added = files.reduce((n, f) => n + f.additions, 0);
  const removed = files.reduce((n, f) => n + f.deletions, 0);
  const quiet = findings.every((f) => QUIET.has(f.severity));
  const diffId = `diff-${change.id}`;
  const sentence = changeSentence(change);

  const locate = (f: Finding) => {
    if (!f.line) return;
    const next =
      focus?.findingId === f.id
        ? null
        : { path: f.path, line: f.line, findingId: f.id };
    setFocus(next);
    if (next) setOpen(true);
  };

  return (
    <li class={`grid row change${quiet ? " quiet" : ""}`}>
      <div class="row-head">
        <h3>{change.title}</h3>
        <p class="tags">
          {change.tags.map((t) => (
            <span class="tag" key={t}>
              {t}
            </span>
          ))}
        </p>
        <p class="stats">
          {added > 0 && <span>+{added} added</span>}
          {removed > 0 && <span>−{removed} removed</span>}
          {files.length > 0 && <span>{plural(files.length, "file")}</span>}
        </p>
        {files.length > 0 && (
          <button
            type="button"
            class="toggle"
            aria-expanded={open}
            aria-controls={diffId}
            onClick={() => {
              setOpen(!open);
              if (open) setFocus(null);
            }}
          >
            {open ? "Hide diff" : "Show diff"}
          </button>
        )}
      </div>
      {(sentence || findings.length > 0) && (
        <div class="row-body">
          {sentence && <p class="change-summary">{sentence}</p>}
          {findings.length > 0 && (
            <ul class="notes-findings" aria-label="Findings in this change">
              {findings.map((f) => (
                <FindingNote
                  key={f.id}
                  f={f}
                  focused={focus?.findingId === f.id}
                  onLocate={
                    f.line && files.some((x) => x.path === f.path && x.patch)
                      ? () => locate(f)
                      : null
                  }
                />
              ))}
            </ul>
          )}
        </div>
      )}
      {open && (
        <div class="row-diff" id={diffId}>
          <FileDiffs
            files={files}
            findings={findings}
            focus={focus}
            onFocus={setFocus}
            lineUrl={lineUrl}
          />
        </div>
      )}
    </li>
  );
}
