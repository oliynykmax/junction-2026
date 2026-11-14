// Unified diffs of changed files, with finding lines marked. When the owner
// selects a finding, every other line dims and the cited line scrolls into view.

import { Fragment } from "preact";
import { useEffect, useRef } from "preact/hooks";
import {
  ATTENTION,
  type ChangedFile,
  type Finding,
  type Focus,
  type LineUrl,
  plural,
} from "./shared";

type DiffLine =
  | { kind: "hunk"; text: string }
  | {
      kind: "add" | "del" | "ctx";
      text: string;
      old: number | null;
      new: number | null;
    };

/** Parses a GitHub file patch (hunks only, no file headers) into lines. */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      out.push({ kind: "hunk", text: raw });
    } else if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw.slice(1), old: null, new: newNo++ });
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", text: raw.slice(1), old: oldNo++, new: null });
    } else if (raw.startsWith("\\")) {
      out.push({ kind: "hunk", text: raw });
    } else {
      out.push({
        kind: "ctx",
        text: raw.slice(1),
        old: oldNo++,
        new: newNo++,
      });
    }
  }
  return out;
}

export function FileDiffs({
  files,
  findings,
  focus,
  onFocus,
  lineUrl,
}: {
  files: readonly ChangedFile[];
  findings: readonly Finding[];
  focus: Focus;
  onFocus: (f: Focus) => void;
  lineUrl: LineUrl;
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
}: {
  file: ChangedFile;
  findings: readonly Finding[];
  focus: Focus;
  dimmed: boolean;
  onFocus: (f: Focus) => void;
  lineUrl: LineUrl;
}) {
  const focusRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus?.findingId]);

  const lines = file.patch ? parsePatch(file.patch) : [];
  const byLine = new Map<number, Finding[]>();
  for (const f of findings)
    if (f.line) byLine.set(f.line, [...(byLine.get(f.line) ?? []), f]);
  const unplaced = findings.filter(
    (f) => !f.line || !lines.some((l) => l.kind !== "hunk" && l.new === f.line),
  );

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
      {!file.patch ? (
        <p class="no-patch">
          No textual diff: the file is binary or too large to show.{" "}
          <a href={lineUrl(file.path, null)}>Open it on GitHub</a>.
        </p>
      ) : (
        <div class="diff-scroll">
          <table class={`diff${focus ? " has-focus" : ""}`}>
            <tbody>
              {lines.map((l, i) => {
                if (l.kind === "hunk")
                  return (
                    <tr key={i} class="d-hunk">
                      <td colSpan={3}>{l.text}</td>
                    </tr>
                  );
                const marks = l.new ? (byLine.get(l.new) ?? []) : [];
                const isFocus = focus !== null && l.new === focus.line;
                const severe = marks.some((f) => ATTENTION.has(f.severity));
                return (
                  <Fragment key={i}>
                    <tr
                      ref={isFocus ? focusRef : undefined}
                      class={`d-${l.kind}${marks.length ? (severe ? " marked severe" : " marked") : ""}${isFocus ? " focus" : ""}`}
                    >
                      <td class="ln">{l.old ?? ""}</td>
                      <td class="ln">{l.new ?? ""}</td>
                      <td class="code">
                        <span class="sign" aria-hidden="true">
                          {l.kind === "add"
                            ? "+"
                            : l.kind === "del"
                              ? "−"
                              : " "}
                        </span>
                        {l.text}
                      </td>
                    </tr>
                    {marks.map((f) => (
                      <tr
                        key={`${i}-${f.id}`}
                        class={`d-note${ATTENTION.has(f.severity) ? " severe" : ""}${isFocus ? " focus" : ""}`}
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
              })}
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
