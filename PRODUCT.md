# Earned Trust

register: brand

A hackathon concept landing page for engineers deciding whether to accept agent-written pull requests. The page turns a public GitHub PR URL into a read-only evidence report. A named human owns the decision; the AI supplies advice, source references, and explicit gaps.

The visual direction is white and orange, confident and trustworthy. Use readable typography, clear focus states, reduced-motion support, and a responsive layout. Avoid fabricated metrics, findings, endorsements, and approval claims. The reference implementation is a demo, not a finished product.

Frontend lives in `landing/`; the Cloudflare Worker and existing reports live in `review-bot/`. Manual starts must never write comments or approvals to GitHub.
