// Unified diffs of changed files, with finding lines marked. When the owner
// selects a finding, every other line dims and the cited line scrolls into view.
//
// A file with a reading plan from the agent opens in its reading view: lines
// the agent hid collapse into rows that expand in place, and a toggle shows
// the full diff. The plan is rendered here against the current findings, so a
// plan that would hide a cited line is not used and the full diff shows.

import { Fragment } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  compileReadingPlan,
  keptLine,
  type PatchLine,
  patchLines,
  type ReadingPlan,
  type ReadingRow,
} from "../src/reading";
import {
  type ChangedFile,
  type Finding,
  type Focus,
  isBlocking,
  type LineUrl,
  plural,
} from "./shared";

export type Readings = Readonly<Record<string, ReadingPlan>>;

const isSource = (
  l: PatchLine,
): l is Extract<PatchLine, { kind: "add" | "del" | "ctx" }> =>
  l.kind === "add" || l.kind === "del" || l.kind === "ctx";

export function FileDiffs({
  files,
  findings,
  focus,
  onFocus,
  lineUrl,
  readings,
}: {
  files: readonly ChangedFile[];
  findings: readonly Finding[];
  focus: Focus;
  onFocus: (f: Focus) => void;
  lineUrl: LineUrl;
  /** The agent's reading plans by path. Without them every file shows in full. */
  readings?: Readings;
}) {
  return (
    <div class="diffs">
      {focus && (
        <div class="focus-bar">
          <span>
            Showing <code>{`${focus.path}:${focus.line}`}</code>
          </span>
          <button type="button" class="toggle" onClick={() => onFocus(null)}>
            Show all lines
          </button>
        </div>
      )}
      {files.map((file) => (
        <FileDiff
          key={file.path}
          file={file}
          findings={findings.filter((f) => f.path === file.path)}
          focus={focus?.path === file.path ? focus : null}
          dimmed={focus !== null && focus.path !== file.path}
          onFocus={onFocus}
          lineUrl={lineUrl}
          plan={readings?.[file.path]}
        />
      ))}
    </div>
  );
}

function FileDiff({
  file,
  findings,
  focus,
  dimmed,
  onFocus,
  lineUrl,
  plan,
}: {
  file: ChangedFile;
  findings: readonly Finding[];
  focus: Focus;
  dimmed: boolean;
  onFocus: (f: Focus) => void;
  lineUrl: LineUrl;
  plan: ReadingPlan | undefined;
}) {
  const focusRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus?.findingId]);

  const [full, setFull] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  const lines = useMemo(
    () => (file.patch ? patchLines(file.patch) : []),
    [file.patch],
  );
  const reading = useMemo(
    () =>
      plan && file.patch
        ? compileReadingPlan(file.patch, plan, {
            path: file.path,
            protectedLines: findings.flatMap((f) => (f.line ? [f.line] : [])),
          })
        : null,
    [plan, file.patch, file.path, findings],
  );
  const usable = reading?.ok ? reading : null;
  const shortened = usable !== null && !full;

  const byLine = new Map<number, Finding[]>();
  for (const f of findings)
    if (f.line) byLine.set(f.line, [...(byLine.get(f.line) ?? []), f]);
  const unplaced = findings.filter(
    (f) => !f.line || !lines.some((l) => isSource(l) && l.new === f.line),
  );

  const open = (start: number) =>
    setOpened((prev) => new Set(prev).add(start));

  const lineRow = (l: PatchLine, key: string, elided = false) => {
    if (!isSource(l))
      return (
        <tr key={key} class="d-hunk">
          <td colSpan={3}>{l.text}</td>
        </tr>
      );
    const marks = l.new ? (byLine.get(l.new) ?? []) : [];
    const isFocus = focus !== null && l.new === focus.line;
    const severe = marks.some(isBlocking);
    return (
      <Fragment key={key}>
        <tr
          ref={isFocus ? focusRef : undefined}
          class={`d-${l.kind}${marks.length ? (severe ? " marked severe" : " marked") : ""}${isFocus ? " focus" : ""}${elided ? " elided" : ""}`}
          title={
            elided
              ? "The AI replaced part of this line with ... Show the full diff to read it."
              : undefined
          }
        >
          <td class="ln">{l.old ?? ""}</td>
          <td class="ln">{l.new ?? ""}</td>
          <td class="code">
            <span class="sign" aria-hidden="true">
              {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
            </span>
            {l.text}
          </td>
        </tr>
        {marks.map((f) => (
          <tr
            key={`${key}-${f.id}`}
            class={`d-note${isBlocking(f) ? " severe" : ""}${isFocus ? " focus" : ""}`}
          >
            <td colSpan={2} />
            <td>
              <button
                type="button"
                onClick={() =>
                  onFocus(
                    isFocus
                      ? null
                      : {
                          path: file.path,
                          line: f.line ?? 0,
                          findingId: f.id,
                        },
                  )
                }
              >
                <span class="sev">{f.severity}</span> {f.title}
              </button>
            </td>
          </tr>
        ))}
      </Fragment>
    );
  };

  /** Patch lines start..end (1-based, inclusive), as an expanded hidden run. */
  const expanded = (start: number, end: number) =>
    lines
      .slice(start - 1, end)
      .map((l, k) => lineRow(l, `x${start + k}`));

  const readingRow = (r: ReadingRow) => {
    switch (r.kind) {
      case "hunk":
      case "eof":
        return lineRow(r, `r${r.line}`);
      case "fold":
      case "gap": {
        if (opened.has(r.start_line))
          return expanded(r.start_line, r.end_line);
        const count = lines
          .slice(r.start_line - 1, r.end_line)
          .filter(isSource).length;
        const label =
          r.kind === "fold"
            ? `Show ${plural(count, "folded line")}`
            : r.reason === "using"
              ? `${plural(count, "using directive")} hidden automatically. Show`
              : `${plural(count, "line")} hidden by the AI. Show`;
        return r.kind === "fold" ? (
          <tr key={`r${r.start_line}`} class={`d-${r.sign} d-fold`}>
            <td class="ln" />
            <td class="ln" />
            <td class="code">
              <span class="sign" aria-hidden="true">
                {r.sign === "add" ? "+" : r.sign === "del" ? "−" : " "}
              </span>
              <button
                type="button"
                aria-label={label}
                title={label}
                onClick={() => open(r.start_line)}
              >
                {`${r.indent}...`}
              </button>
            </td>
          </tr>
        ) : (
          <tr key={`r${r.start_line}`} class="d-gap">
            <td colSpan={2} />
            <td>
              <button type="button" onClick={() => open(r.start_line)}>
                {label}
              </button>
            </td>
          </tr>
        );
      }
      default:
        return lineRow(
          { kind: r.kind, text: r.text, old: r.old, new: r.new },
          `r${r.line}`,
          r.elided,
        );
    }
  };

  return (
    <section class={`file${dimmed ? " dimmed" : ""}`}>
      <header class="file-head">
        <a class="file-path" href={lineUrl(file.path, null)}>
          {file.path}
        </a>
        <span class="file-stats">
          {file.status !== "modified" && <span>{file.status}</span>}
          {file.additions > 0 && <span>+{file.additions}</span>}
          {file.deletions > 0 && <span>−{file.deletions}</span>}
        </span>
      </header>
      {usable && (
        <p class="reading-bar">
          <span>
            {full
              ? "Full diff."
              : `Reading view: ${keptLine(usable.stats)}. The AI chose what to hide; lines that findings cite always show.`}
          </span>
          <button
            type="button"
            class="toggle"
            aria-pressed={full}
            onClick={() => setFull((v) => !v)}
          >
            {full ? "Show reading view" : "Show full diff"}
          </button>
        </p>
      )}
      {reading && !reading.ok && (
        <p class="reading-bar">
          <span title={reading.problems.join("\n")}>
            The AI's shortened view of this file no longer fits its findings, so
            the full diff is shown.
          </span>
        </p>
      )}
      {!file.patch ? (
        <p class="no-patch">
          No textual diff: the file is binary or too large to show.{" "}
          <a href={lineUrl(file.path, null)}>Open it on GitHub</a>.
        </p>
      ) : (
        <div class="diff-scroll">
          <table class={`diff${focus ? " has-focus" : ""}`}>
            <tbody>
              {shortened
                ? usable.rows.map(readingRow)
                : lines.map((l, i) => lineRow(l, `l${i}`))}
            </tbody>
          </table>
        </div>
      )}
      {unplaced.length > 0 && (
        <p class="unplaced">
          {plural(unplaced.length, "finding")} in this file cite lines outside
          the diff:{" "}
          {unplaced.map((f, i) => (
            <span key={f.id}>
              {i > 0 && ", "}
              <a href={lineUrl(f.path, f.line)}>
                {f.line ? `line ${f.line}` : "the whole file"}
              </a>
            </span>
          ))}
          .
        </p>
      )}
    </section>
  );
}
