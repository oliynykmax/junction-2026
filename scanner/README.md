# Review scanner (Modal)

This is a Modal web endpoint that runs deterministic checks for the review bot. `POST /scan` takes a repo, a commit, a short-lived GitHub installation token, and the tools to run with their paths. It downloads that commit's tarball, runs each tool with JSON output, and returns the diagnostics in one shape: `{ tool, rule, severity, path, line, message, url }`.

| Tool | Version | Runs on |
|---|---|---|
| zizmor | 1.32.0 (offline audits) | `.github/workflows/*.yml`, `action.yml` |
| ty | 0.0.104 | `*.py`, `*.pyi` |
| oxlint | 1.93.0 | `*.js`, `*.ts`, `*.jsx`, `*.tsx` (and `c`/`m` variants) |

The review Worker decides which tools apply (`review-bot/src/scanners.ts`). This endpoint runs only what it is asked to.

Requests must carry `authorization: Bearer <SCANNER_TOKEN>`. The token is stored in the Modal secret `j26-review-scanner` and the Worker secret `SCANNER_TOKEN`.

## Deploy

```sh
uv sync
uv run modal deploy app.py   # Modal profile j26-earned-trust
```

Endpoint: https://j26-earned-trust--j26-review-scanner-web.us-east.modal.run. A cold start takes about 6.5 s, including the MessagePack-CSharp tarball. A warm call takes about 1.8 s.
