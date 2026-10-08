#!/usr/bin/env python3
"""Render the reviewable audit from its JSON and reject stale rollups."""
import collections
import json
from pathlib import Path

repo = Path(__file__).resolve().parent.parent
audit = json.loads((repo / 'docs/cloud-remaining-feature-audit-2026-10-08.json').read_text())
progress = json.loads((repo / 'docs/implementation-progress.json').read_text())
features = {f['id']: f for f in progress['features']}
counts = collections.Counter(f['implementation'] for f in features.values())
assert len(features) == 172 and dict(counts) == progress['summary']
assert all(audit['current_progress'][k] == v for k, v in counts.items())
assert audit['whole_suite_verified'] is False and progress['whole_suite_verified'] is False
remaining, completed = audit['items'], audit['completed_since_baseline']
assert len(remaining) == audit['current_progress']['remaining'] == 172 - counts['implemented']
assert len(remaining) + len(completed) == audit['baseline']['audited']
assert len({r['id'] for r in remaining + completed}) == len(remaining) + len(completed)
assert all(features[r['id']]['implementation'] != 'implemented' for r in remaining)
assert all(features[r['id']]['implementation'] == 'implemented' for r in completed)
assert audit['summary'] == {k: sum(i['classification'] == k for i in remaining) for k in audit['classification_labels']}
initial = audit['ready_batch']['initial_ids']
for status in ['implemented', 'partial', 'not_started']:
    assert audit['ready_batch'][status] == sum(features[i]['implementation'] == status for i in initial)
assert audit['ready_batch']['remaining_ids'] == [i for i in initial if features[i]['implementation'] != 'implemented']
lines = ['# 남은 기능 감사 — 2026-10-08', '', audit['basis'], '',
         f"현재 소스 기준: 구현 {counts['implemented']}, 부분 {counts['partial']}, 미착수 {counts['not_started']} / 총 172. 남은 {len(remaining)}개. 전체 통합 인수: 미완료.", '',
         audit['continueable_work_note'], '', '| 분류 | 남은 수 |', '|---|---:|']
lines += [f"| {audit['classification_labels'][k]} | {v} |" for k, v in audit['summary'].items()]
lines += ['', '| ID | 서비스 | 기능 | 분류 | 현재 소스 | 다음 단계 |', '|---|---|---|---|---|---|']
for item in remaining:
    fields = [str(item.get(k, '')).replace('|', '\\|').replace('\n', ' ')
              for k in ['id', 'service', 'name', 'classification_label', 'implementation', 'next_step']]
    lines.append('| ' + ' | '.join(fields) + ' |')
lines += ['', '## 제품 정책과 실제 인수에 필요한 결정', '']
lines += ['- ' + value for value in audit['minimal_other_decisions']]
lines += ['', '## E8 메일 envelope와 수신 전 누락', '']
for value in audit['E8'].values():
    lines += [value['recommended'] + '. ' + value['tradeoff'], '', '대안: ' + value['alternative'], '']
lines += ['## 실제 검증 범위', '',
          audit['verification_summary'], '',
          '작업 브랜치의 마지막 소스 커밋:', '']
lines += ['- ' + key + ': `' + audit['current_progress'][key] + '`'
          for key in ['web_source_commit', 'agent_source_commit', 'talk_source_commit', 'console_source_commit', 'talk_bff_source_commit', 'bundle_source_commit', 'bootstrap_source_commit', 'teardown_source_commit', 'notification_worker_source_commit']]
lines += ['', '재생성: `python3 scripts/render-feature-audit.py`. JSON·진행표·baseline·분류·ready 집계가 서로 맞아야 생성한다.', '']
(repo / 'docs/cloud-remaining-feature-audit-2026-10-08.md').write_text('\n'.join(lines))
print(json.dumps({'features': len(features), 'remaining': len(remaining), 'summary': dict(counts)}, ensure_ascii=False))
