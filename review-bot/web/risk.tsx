// The risk band: the tier the deterministic rules set, how deeply the owner
// reads at that tier, the files to read in full, and the test-change lane.
// It routes attention; it never blocks, so it uses no red.

import { DEPTH, type Risk, type TestChange } from "../src/signals";
import { plural, type LineUrl } from "./shared";

export function RiskBand({
  risk,
  lineUrl,
}: {
  risk: Risk | undefined;
  lineUrl: LineUrl;
}) {
  if (!risk) return null;
  const weak = risk.tests.filter((t) => t.weakened.length);
  const unread = risk.tests.filter((t) => t.patchMissing);
  return (
    <section class="grid band" aria-labelledby="risk-h">
      <div class="band-label">
        <h2 id="risk-h">Review depth</h2>
        <p>
          <span class={`tier tier-${risk.tier}`}>{risk.tier} risk</span>
        </p>
        <p class="band-note">Set by fixed rules on the diff, not by the AI.</p>
      </div>
      <div class="band-body">
        <p class="depth">{DEPTH[risk.tier]}</p>
        {risk.mustRead.length > 0 && (
          <div>
            <p class="sub-h">Read in full</p>
            <ul class="paths">
              {risk.mustRead.map((p) => (
                <li key={p}>
                  <a href={lineUrl(p, null)}>{p}</a>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <p class="sub-h">Why</p>
          <ul class="reasons">
            {risk.reasons.map((r) => (
              <li key={r.rule}>
                <span class={`tier tier-${r.tier}`}>{r.tier}</span> {r.text}
                {r.paths.length > 0 && r.tier !== risk.tier && (
                  <span class="meta">{plural(r.paths.length, "file")}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p class="sub-h">Test changes</p>
          {risk.tests.length === 0 ? (
            <p class="muted">No test file changed.</p>
          ) : weak.length === 0 ? (
            <p class="muted">
              {plural(risk.tests.length, "test file")} changed; none lost tests
              or assertions, gained a skip or was deleted.
              {unread.length > 0 &&
                ` ${plural(unread.length, "file")} had no diff to inspect.`}
            </p>
          ) : (
            <ul class="reasons">
              {weak.map((t) => (
                <li key={t.path}>
                  <a href={lineUrl(t.path, null)}>{t.path}</a>{" "}
                  {t.weakened.join(" ")} <TestCounts t={t} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function TestCounts({ t }: { t: TestChange }) {
  if (t.status === "removed") return null;
  return (
    <span class="meta">
      tests +{t.testsAdded} −{t.testsRemoved} · asserts +{t.assertionsAdded} −
      {t.assertionsRemoved}
    </span>
  );
}
