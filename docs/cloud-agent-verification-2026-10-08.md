# 클라우드 에이전트 독립 구현·검증 (2026-10-08)

선행 gateway GW-60/61/62는 `f1fc98b4f38cb6f5f704cff5afe6e38b7e9e0344`로 커밋·승인된 작업 브랜치 푸시 후 원격 SHA 일치를 확인했다. [gateway 증거](cloud-gateway-verification-2026-10-08.md)의 Nginx 시험 Node22/24 각각13개·전체 BFF114개·단위65개는 통과했지만 운영/VM 인수는 미실행이다. 이어 GW-66의 독립 내부 조정 엔진을 구현했다.

## 구현과 실제 관찰

`deploy/agent/reconciler.mjs`는 tenant·카탈로그 검사, desired/설치 사실 비교, 직렬 install/remove, 매 변경 뒤 inventory 재관찰, 동일 상태 무변경, 실패 뒤 새 사실로 재시도, 안전한 상태/보고 실패 구분을 담당한다. 파일 잠금은 서로 다른 Node 프로세스 사이에서도 작동하며 mutation과 보고 종료까지 유지한다. readonly source만 시간 제한으로 분리하고, 변경 promise는 종료 전에 잠금을 풀지 않는다.

`provision-command.mjs`는 지정 executable에 shell 없이 고정 argv만 넘기고 프로세스 그룹 종료를 관리한다. 실제 G18 설치기는 아직 없으므로 모든 명령 시험은 격리 폴더의 파일만 변경하는 fixture다. 실제 설치·운영 키·원격 송신을 하지 않는다. 비활성 timer 예시는 60초로 작성했고 OS 등록은 하지 않았다.

| 실행 | 결과 |
| --- | --- |
| `JGW_AGENT_TEST_RUNTIME=isolated-cloud npm run test:agent` | Node24.19.0 실제 fixture14/14, fail/cancel/skip0, exit0 |
| 같은 marker, Node22.18.0 `node --test tests/agent/reconciler.test.mjs` | 실제 fixture14/14, fail/cancel/skip0, exit0 |
| `npm run check` | build·typecheck·단위65/65·gateway/agent 포함 lint·format 통과, exit0 |
| `JGW_TEST_ENV=/workspace/.suite-runtime/j-groupware/messenger-pg.env npm run test:integration` | 실제 Keycloak/j-auth·전용PG·BFF114/114, fail/skip0, exit0 |

14개에는 실제 설치/해지 argv와 최종 파일 상태, 재실행 no-op, 실제 installer nonzero 뒤 부분 상태/재시도, exit0이지만 변화 없음, 변경 뒤 관찰 장애 시 unknown 상태와 중복 없는 재시도, 잘못된 tenant/catalog, 응답 없는 source의 timeout/늦은 reject, 취소 뒤 settle 전 lock 유지, 보고 실패 뒤 재설치 없는 재보고, **서로 다른 두 agent 프로세스의 busy**, **TERM을 무시하는 실제 descendant의 KILL과 늦은 파일 쓰기 중단**, 실제 command timeout/안전한 재시도, 보고 수명 잠금, stale lock·symlink binary·purge 거부가 포함된다.

fixture 설치·보고는 실제 파일을 바꾸지만 실제 콘솔/서비스 등록/API 인증으로 간주하지 않는다. source·inventory·report의 서비스 의미는 내부 어댑터 fixture이고 wire 계약은 제공하지 않았다. 모든 임시 폴더/fixture child를 종료·제거했으며 기존 auth/PG/registry 실행 환경은 유지했다.

결과 파일은 `/workspace/.suite-runtime/j-groupware/agent-tests.log`, `agent-node22.log`, `agent-check.log`, `agent-bff.log`, `agent-bff-results.json`이다. 기존 Nginx gateway 코드/시험은 이 묶음에서 바뀌지 않았다. 원격 CI 실행 여부와 이 로컬 실행 결과를 구별한다.

## 아직 필요한 계약·본체

| 항목 | 남은 범위 |
| --- | --- |
| GW-54 / G17 / G21 콘솔 | fixed GET/POST 경로는 결정됐지만 정확한 desired/status DTO, 보고 상태·세대 처리, agent 키 교체/회수 계약을 확정하고 인증 API를 구현해야 함 |
| GW-63/64/65 / G18 | bootstrap, 실제 DB/role/env/unit·알림 key projection·서비스 고유 설치/해지와 완전 설치 probe 본체 미구현 |
| GW-66 | console 인증 어댑터, 위 실제 probe/설치기 연결, 실행 entrypoint·systemd service, timer 등록·실제 고객 VM 인수 미완료 |
| UI | canonical `docs/ui-guidelines.md` 없음, 정식 화면/Playwright는 기존 대기 상태 |

그래서 GW-66은 **partial**이고 GW-T17/SU-T09를 통과로 표시하지 않는다. 전체 제품군 verified도 false다. 생산 자격 발급·운영 등록/배포·지속 권한 확대·외부 이메일/SMS/제3자 송신은 보류했다. 회사 노트북 설치, PR·main 병합은 실행하지 않았다.

## 후속 G18 구현

[연결 구현·검증](cloud-connected-implementation-2026-10-08.md)에서 bootstrap 비밀 파일·archive 준비, 실제 서비스 DB/role·dump/restore/NOLOGIN, 단계별 설치/해지 복구 및 native unit 렌더러를 추가했다. `test:agent`는 기존14+새4로 Node22/24 각각18개, 실제 DB는 각각3개 통과했다. 제품별 wiring과 실제 VM 활성화는 여전히 미완료다. 위 표의14/65/114는 당시 실행 결과이며 후속18/74/133과 구분한다.
