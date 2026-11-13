# Project brief: Telegram propaganda & coordination detector
*Junction 2026: Hostinger "Decode the Noise" challenge*

## What we're building
A public web app, deployed live on our Hostinger VPS, that analyzes public Telegram channels. It answers three questions, one per screen:

1. **Is this post manipulative, and how?** (content)
2. **Are these posts coordinated?** (behavior)
3. **How accurate is our tool?** (honesty)

This covers two of Hostinger's suggested directions, "Name the technique" and "Spot the swarm". It also leans into what the judges said matters most: honest detection logic with measured precision and false-positive rates.

## Why Telegram, not X or Bluesky
- **X:** the API is expensive and scraping it is legally risky. A browser extension also fails the "public URL" requirement.
- **Bluesky:** easy to access, but its average feed is too calm for a dramatic demo.
- **Telegram:** a central platform for both sides' messaging in the Russia–Ukraine war. Public channels are easy to read, and good expert-labeled datasets exist, so we can report real accuracy numbers. The topic also lands well with a Helsinki jury.

## The three screens

### 1. Feed X-ray (the hook)
- A feed of posts from the monitored channels: original text, English translation, views, timestamp.
- Turning the "X-ray" switch on highlights manipulative phrases by technique (fear appeal, loaded language, whataboutism and so on) and adds a risk chip to each post.
- Clicking a highlighted phrase shows a plain-language explanation of why it was flagged.
- **Data:** post text, sent to an LLM that returns technique labels and the character positions of the flagged phrases.

### 2. Swarm Radar (the visual payoff)
- A network graph: each dot is a channel, each line is a forward or copied text.
- Coordinated groups light up as clusters, for example many channels posting near-identical text within minutes.
- A timeline scrubber replays how a narrative spread.
- Clicking a cluster opens a case file:
  - the shared text, with differences highlighted
  - a posting-time histogram
  - channel ages and subscriber counts
- **Data:** forward headers, timestamps and text similarity (MinHash).

### 3. Receipts (what wins the jury)
- Precision, recall and false-positive rate for each technique, measured on expert-labeled posts we held out from development.
- A threshold slider that shows the false-alarm vs. missed-detection tradeoff live.
- A gallery of our real mistakes, with explanations.

## Data

### Getting Telegram data
- **`t.me/s/<channel>` web preview:** no login needed, about 20 posts per page (go further back with `?before=<msg_id>`), includes text, date, views and "forwarded from" info. We use this for the live poller on the VPS.
- **Telethon** (Python), GramJS (Node) or TDLib (official C++ library): full API access. Needs an api_id and api_hash from my.telegram.org plus a phone number, so use a spare number. Slow down when Telegram returns a FloodWait error.
- **Not available:** follower graphs and which channels a user has joined. Coordination therefore has to come from forwards, matching text and timing.

### Labeled datasets
- **UNLP 2025 Shared Task:** our ground truth for detecting techniques.
  - 9,557 Telegram posts in Ukrainian and Russian, annotated by media experts for 10 manipulation techniques (straw man, appeal to fear, FUD, bandwagon, whataboutism, loaded language, glittering generalities, cherry picking, and others).
  - Also marks the exact manipulative phrases, which powers the X-ray highlights.
  - On GitHub (`unlp-workshop/unlp-2025-shared-task`) and Kaggle. Licence: CC BY-NC-SA.
  - Its Kaggle leaderboard lets us compare our scores with published systems.
- **Bawa et al., ICWSM 2025:** our data for the coordination network.
  - 404 pro-Kremlin channels (4.1M posts) and 114 anti-Kremlin channels (1.1M posts), JSON on Figshare.
  - Includes forwarding sources, which gives us the network graph.
  - ⚠️ It labels each channel's political stance, not whether each post is propaganda. Don't use it as ground truth for accuracy.
- **Kireev et al. (EPFL):** 17.3M messages, including about 6,250 labeled propaganda accounts in comment sections.
  - No public download found; would have to request from the authors, so probably out of scope for the weekend.
  - Their cheap, useful signal: propaganda accounts reuse long messages (over 30 characters).
- **Large unlabeled corpora** (TeleScope, TeraGram, Pushshift Telegram): background traffic and seed lists of channels.

## Tech plan
- **Backend:** Python (FastAPI) with Telethon and the scraper, in Docker on the Hostinger VPS (KVM 2: 2 vCPU, 8 GB RAM). Storage: SQLite or Postgres.
- **Technique classifier:** an LLM through Hostinger AI Router, prompted with a few examples, returning JSON labels and phrase positions. Evaluate it on a held-out UNLP split. Don't try fine-tuning on the 2-core CPU.
- **Coordination detection:** MinHash/LSH near-duplicate detection, plus timing windows and forward chains, turned into a graph and clustered.
- **Frontend:** a dark "forensic console" look, with a force-directed graph (D3 or Sigma.js), an animated X-ray toggle, and Receipts charts.
- **Modes:**
  - **Replay:** datasets with known answers. This is the demo backbone.
  - **Live:** about 20–50 public channels polled every few minutes.
  - **Paste box:** analyze any text, including from X.

## Demo flow (~3 min)
1. A feed that looks normal.
2. Flip X-ray: phrases light up and the explanations appear.
3. Jump to Swarm Radar and replay a coordinated campaign.
4. Open the case file to show the evidence.
5. End on Receipts: slider, metrics and our false positives. Line to land: "we show where we're wrong."

## Open decisions for the team
- Which channels to watch live (pick from the Bawa and TGStat lists).
- Which LLM to use through the router (cost vs. quality on Ukrainian and Russian).
- Who owns which part: scraping and pipeline, classifier and evaluation, graph, frontend, deployment.

## Sources
- [UNLP 2025 Shared Task paper](https://preview.aclanthology.org/setup/2025.unlp-1.12) · [GitHub data](https://github.com/unlp-workshop/unlp-2025-shared-task)
- [Bawa et al. dataset (Figshare)](https://figshare.com/articles/dataset/Pro-Kremlin_and_Anti-Kremlin_Telegram_Dataset_during_Russia-Ukraine_Conflict_/28785449)
- [Kireev et al., Telegram propaganda accounts (arXiv)](https://arxiv.org/pdf/2406.08084)
- [TeleScope dataset (arXiv)](https://arxiv.org/pdf/2504.19536)
- [Telegram web-preview scraping](https://dev.to/sami_8858131362756585e4f4/how-to-scrape-telegram-channels-in-2026-without-api-keys-or-phone-numbers-195)
