# System Configuration & Deployment Diagrams

Architectural and deployment diagrams for Junction 2026's **Earned Trust in AI Code** project (`bumble-bot-review`), rendered from Mermaid source using [Pele](https://pele.run) (`@simhozebs/pele-cli` / `pele`).

---

## 1. System Architecture & Configuration

Diagram: [`system-config-architecture.png`](system-config-architecture.png) | Source: [`system-config-architecture.mmd`](system-config-architecture.mmd)

Shows the component topology, secrets, environment variables, and connections:
- **GitHub App (`bumble-bot-review`)**: Intercepts PR events (`opened`, `synchronize`, `ready_for_review`) on `oliynykmax/junction26-messagepack-csharp`.
- **Cloudflare Worker (`j26-review-bot`)**: Configured in `review-bot/wrangler.jsonc` at `review.oliinyk.dev`, holding bindings for SQLite Durable Objects (`Review`), QuickJS inline sandbox (`pi-codemode`), and environment variables (`MODEL_ID: claude-sonnet-5-5`, `THINKING_LEVEL: medium`, `REVIEW_BASE_URL`).
- **Modal Cloud (`j26-review-scanner`)**: Containerized static analysis engine at `us-east.modal.run` executing deterministic tools (`zizmor`, `ty`, `oxlint`).
- **External Dependencies**:
  - Pinned Cursor review rubric (`thermo-nuclear-code-quality-review`).
  - Streamable HTTP MCP servers: Context.dev (`web-search`, `web-scrape`) and Microsoft Learn (.NET & C# docs).
  - Strict **Docs Gate**: Enforces that external documentation must be consulted prior to completing a review.

---

## 2. CI/CD & Deployment Pipeline

Diagram: [`deployment-pipeline.png`](deployment-pipeline.png) | Source: [`deployment-pipeline.mmd`](deployment-pipeline.mmd)

Illustrates the automated continuous integration and deployment paths:
- **Worker Pipeline (`.github/workflows/review-bot.yml`)**:
  - Triggered on PR or push to `main` for paths under `review-bot/**`.
  - **Check Job**: Sets up Bun canary (`oven-sh/setup-bun@v2.2.0`), runs `bun install --frozen-lockfile`, `bun fmt --check`, `bun lint`, and `bun check`.
  - **Deploy Job**: Runs on push to `main` (production environment), invoking `bunx wrangler deploy` using `CLOUDFLARE_API_TOKEN`.
- **GitHub Actions Linting (`.github/workflows/jactionlint.yml`)**:
  - Validates all workflow YAML definitions using `jdx/jactionlint`.
- **Scanner Deployment (`scanner/`)**:
  - Managed via `uv sync` and deployed using `uv run modal deploy app.py` under Modal profile `j26-earned-trust` with secret `j26-review-scanner`.

---

## 3. Review Workflow & Decision Lifecycle

Diagram: [`review-lifecycle.png`](review-lifecycle.png) | Source: [`review-lifecycle.mmd`](review-lifecycle.mmd)

Sequence diagram detailing the exact runtime execution from pull request creation to advisory decision:
1. **Webhook Ingestion**: Worker routes the event to a dedicated Durable Object instance based on PR and head commit SHA.
2. **Deterministic Scan**: Calls Modal endpoint `POST /scan` to gather raw diagnostics.
3. **Rubric Fetch**: Retrieves and SHA256-verifies Cursor's pinned review rubric.
4. **Agent Turns & Docs Gate**: Claude Sonnet executes code mode inspection via QuickJS, accesses official docs via MCP, and reconciles scanner diagnostics.
5. **Advisory Decision**: Determines status (`changes_requested` vs `no_blockers_found`) based on finding severity and confidence.
6. **PR Status & Dashboard**: Posts sticky comment, registers commit approval if clean, and serves real-time status to `/r/...`.

---

## Rendering Instructions

To re-render these diagrams using Pele:

```bash
# Render to SVG and high-resolution PNG
bunx @simhozebs/pele-cli docs/diagrams/system-config-architecture.mmd -o docs/diagrams/system-config-architecture.png --scale 2 --padding 24
bunx @simhozebs/pele-cli docs/diagrams/system-config-architecture.mmd -o docs/diagrams/system-config-architecture.svg

bunx @simhozebs/pele-cli docs/diagrams/deployment-pipeline.mmd -o docs/diagrams/deployment-pipeline.png --scale 2 --padding 24
bunx @simhozebs/pele-cli docs/diagrams/deployment-pipeline.mmd -o docs/diagrams/deployment-pipeline.svg

bunx @simhozebs/pele-cli docs/diagrams/review-lifecycle.mmd -o docs/diagrams/review-lifecycle.png --scale 2 --padding 24
bunx @simhozebs/pele-cli docs/diagrams/review-lifecycle.mmd -o docs/diagrams/review-lifecycle.svg

# Flatten PNGs onto a clean white background for dark mode readability
for f in docs/diagrams/*.png; do
  convert "$f" -background "#ffffff" -flatten "$f"
done
```
