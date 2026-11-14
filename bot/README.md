# Review bot (GitHub App)

Cloudflare Worker `j26-review-bot` at https://review.oliinyk.dev. GitHub App: https://github.com/apps/j26-earned-trust-review (installed only on `oliynykmax/junction26-messagepack-csharp`).

On `pull_request` opened/reopened/synchronize/ready_for_review it posts one comment linking to `https://review.oliinyk.dev/r/<owner>/<repo>/<pr>?sha=<head>`, and edits that comment on later pushes. `/r/...` is a placeholder until the review view exists; point `REVIEW_BASE_URL` elsewhere to move it.

Secrets (`APP_ID`, `WEBHOOK_SECRET`, `PRIVATE_KEY` as PKCS#8) are set with `wrangler secret put`. Local copies are in `~/.config/j26-review-bot/` (not in git).

Deploy: `bunx wrangler deploy`.
