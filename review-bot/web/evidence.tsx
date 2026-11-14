export function EvidencePanel({ html }: { html: string | undefined }) {
  return (
    <section class="section" aria-labelledby="evidence-h">
      <div class="section-head">
        <h2 id="evidence-h">CI and team standard evidence</h2>
      </div>
      <div
        class="evidence-report"
        dangerouslySetInnerHTML={{
          __html: html ?? "<p>No evidence snapshot for this review.</p>",
        }}
      />
    </section>
  );
}
