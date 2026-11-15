#!/usr/bin/env python3
"""Refresh the public evidence snapshots and sample review ledger."""
import concurrent.futures
import datetime
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'docs/challenge/evidence'
SAMPLES = [
    (2283, 13, '9df83c38409c8bfad0517aebffe48211eda4a5b4'),
    (2234, 14, '9007cee1163c4a274fd60c3cc20c21ae63622786'),
    (2129, 15, '083afd994c1c9a994cb2cd5aa0b6ad805a621457'),
    (2297, 16, 'a0aa5ab2de7f5a669d97e37184a89034c1de82b6'),
]
REPO = 'oliynykmax/junction26-messagepack-csharp'


def capture(sample):
    issue, number, sha = sample
    api = f'https://review.oliinyk.dev/api/r/{REPO}/{number}/{sha}'
    data = json.loads(subprocess.check_output([
        'curl', '--fail', '--silent', '--show-error', '--max-time', '30', api,
    ]))
    review = data.get('review') or {}
    if review.get('target', {}).get('headSha') != sha:
        raise ValueError(f'Wrong or missing reviewed head for #{issue}')
    snapshot = {
        'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'requirement': f'MessagePack-CSharp #{issue}',
        'requirementUrl': f'https://github.com/MessagePack-CSharp/MessagePack-CSharp/issues/{issue}',
        'pr': f'https://github.com/{REPO}/pull/{number}',
        'report': f'https://review.oliinyk.dev/r/{REPO}/{number}?sha={sha}',
        'api': api,
        'headSha': sha,
        'status': data.get('status'),
        'failure': data.get('failure'),
        'costUsd': data.get('costUsd'),
        'signOff': data.get('signOff'),
        'review': {key: review.get(key) for key in [
            'model', 'startedAt', 'scan', 'evidence', 'findings', 'verdict',
            'verifications', 'verifier', 'risk',
        ]},
    }
    DEST.mkdir(parents=True, exist_ok=True)
    (DEST / f'issue-{issue}.json').write_text(json.dumps(snapshot, indent=2) + '\n')
    return snapshot


def main():
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        snapshots = list(pool.map(capture, SAMPLES))
    text = '''# Four supplied sample reviews

These reruns use the four original supplied agent-written commits on our own fork. Opening fresh PRs starts fresh webhook reviews without modifying the supplied code. Requirement IDs refer to the upstream issues, not to generated checker IDs.

This ledger is a timestamped observation. Follow each report for its current state. A running or failed review is not a completed check. Findings, reproduction verdicts, and receipt text are agent-reported. Human confirmation is recorded separately.

Refresh from the repository root with `python3 scripts/capture-challenge-reviews.py`. The script reads the four public APIs and rewrites only this ledger and its JSON snapshots. It does not start reviews, modify PRs, or sign decisions.

| Requirement | Sample PR | Pinned report | Captured state | Candidate findings | Receipt outcomes | Human sign-off |
|---|---|---|---|---|---|---|
'''
    for item in snapshots:
        review = item['review']
        outcomes = {}
        for receipt in review.get('verifications') or []:
            outcome = receipt.get('outcome', 'unknown')
            outcomes[outcome] = outcomes.get(outcome, 0) + 1
        counts = ', '.join(f'{key}: {value}' for key, value in sorted(outcomes.items())) or 'None recorded yet'
        signed = 'Recorded' if item['signOff'] else 'Not recorded'
        issue = item['requirement'].split('#')[-1]
        text += f"| [#{issue}]({item['requirementUrl']}) | [PR]({item['pr']}) | [Review]({item['report']}) | {item['status']} | {len(review.get('findings') or [])} | {counts} | {signed} |\n"
    text += '\n## Commit and evidence register\n\n'
    for item in snapshots:
        issue = item['requirement'].split('#')[-1]
        review = item['review']
        risk = review.get('risk') or {}
        verifier = review.get('verifier') or {}
        text += f"### Requirement #{issue}\n\n"
        text += f"- Original head: `{item['headSha']}`.\n- Captured: {item['capturedAt']}.\n"
        text += f"- Model: `{review.get('model')}`.\n- Risk tier: {risk.get('tier', 'not recorded')}.\n"
        text += f"- Verifier state: {verifier.get('phase', verifier.get('status', 'not recorded'))}.\n"
        text += f"- [Public API]({item['api']}) and [captured evidence](evidence/issue-{issue}.json).\n"
        if item['failure']:
            text += f"- Run failure: `{str(item['failure']).replace(chr(10), ' ')}`.\n"
        findings = review.get('findings') or []
        verdicts = verifier.get('verdicts') or {}
        if findings:
            text += '\nCandidate findings and verifier dispositions:\n\n'
            for finding in findings:
                title = str(finding.get('title', 'Untitled')).replace('\n', ' ')
                disposition = verdicts.get(finding.get('id'), {})
                text += f"- {title}. Severity {finding.get('severity')}; confidence {finding.get('confidence')}; verifier {disposition.get('verdict', 'pending')}.\n"
                if disposition.get('note'):
                    note = str(disposition['note']).replace('\n', ' ')
                    text += f"  Verifier note: {note}\n"
        if verifier.get('summary'):
            text += '\nVerifier summary:\n\n' + str(verifier['summary']) + '\n'
        verdict = review.get('verdict')
        if verdict:
            text += '\nRecorded AI verdict:\n\n```json\n' + json.dumps(verdict, indent=2) + '\n```\n'
        text += '\n'
    text += '''
## Interpretation

No human sign-off means no recorded human acceptance. Candidate counts do not establish precision or recall. Scope gaps, scanner failures, and verifier abstentions stay visible in each report and snapshot. Empty findings while running do not mean the change is clean.

The [#2283 walkthrough](walkthrough-2283.md) separates historical local checks from these new runs. The [measurement plan](measurement.md) states the outcome data still needed before claiming safer or faster review.
'''
    (ROOT / 'docs/challenge/sample-reviews.md').write_text(text)
    for item in snapshots:
        print(item['requirement'], item['status'], item['report'])


if __name__ == '__main__':
    main()
