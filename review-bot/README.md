# Review bot (GitHub App)

Cloudflare Worker `j26-review-bot`, live at https://review.oliinyk.dev. GitHub App: https://github.com/apps/j26-earned-trust-review, installed only on our copy of the sample repo, `oliynykmax/junction26-messagepack-csharp`.

When a pull request is opened, reopened, marked ready or pushed to, the bot posts one comment linking to `https://review.oliinyk.dev/r/<owner>/<repo>/<pr>?sha=<head>`. Later pushes edit that comment. `/r/...` is a placeholder until the review view exists. Set `REVIEW_BASE_URL` in `wrangler.jsonc` to send the link elsewhere.

## Develop

```sh
bun install
bun fmt        # format
bun lint
bun check      # type check
```

CI (`.github/workflows/review-bot.yml`) runs `bun fmt --check`, `bun lint` and `bun check` on Bun canary for every PR and push that touches `review-bot/`. A push to `main` then deploys with `wrangler deploy`, using the repo secret `CLOUDFLARE_API_TOKEN`.

## Secrets

`APP_ID`, `WEBHOOK_SECRET` and `PRIVATE_KEY` (PKCS#8 PEM) are Worker secrets, set with `bunx wrangler secret put <NAME>`. Deploys keep them. Max holds local copies outside git.
