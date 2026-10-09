# 업무 계약 상태·상담 배정 검증 — 2026-10-09

24차. 사용자가 승인한 GW-51 준비→유효→종료 수동 업무 계약과 TK-21 같은 테넌트 활성 `talk:write` 담당 후보·수동 배정/재배정을 구현했다. 저장된 클라우드 체크아웃과 외부 PostgreSQL·Keycloak·TLS·레지스트리 환경을 재사용했다. 회사 노트북 설치나 운영 대상 배포는 수행하지 않았다.

## 최종 동작

- 콘솔 고객은 `contractStatus=prepared`, `contractRevision=1`로 시작한다. 조회에는 업무 계약 상태·리비전·변경 시각을 포함한다. `PUT /console/api/customers/:tenant/contract`는 `{status,revision}`을 받아 `prepared → active → ended`만 허용한다. 현재 상태의 같은 리비전 요청은 멱등이며 역행·건너뛰기·오래된 리비전은 409다. 기존 `customer:read/write`와 CSRF 검사를 유지한다. 계약 변경은 서비스 desired/auth/설치 상태를 바꾸거나 구독 해지를 실행하지 않는다.
- `GET /api/talk/assignees?cursor`는 `id,username`만 반환한다. j-auth의 별도 `/auth/talk/assignees` API가 기존 사용자 Bearer·테넌트 서비스 키로 현재 활성·effective `talk:write` 요청자/후보를 확인한다. 회원·조직 관리 권한은 추가하지 않는다. 비활성·역할 회수·타 테넌트 후보를 거절한다.
- 브라우저 배정은 `POST /api/talk/rooms/:id/assign {memberId}`다. BFF가 매번 검증하고, 기존 테넌트 키에서 용도·테넌트를 묶어 파생한 키로 확인서를 서명한다. 10초 기한은 후보 조회를 시작할 때부터 계산하며 지연된 응답으로 새 기한을 만들지 않는다. Talk는 검증된 회원 토큰의 subject/sid와 테넌트·방·대상·기한을 검사하고, nonce 소비·담당 1명 변경·원래 수신자 outbox 사건을 하나의 PG transaction으로 기록한다. 위조·범위/세션 불일치·만료·재사용을 거절하고 종료 방은 409다. BFF의 본인 배정도 현재 자격 검증을 거친다.
- Talk는 j-auth API와 다른 DB를 조회하지 않는다. 신규 영구 자격을 발급하지 않는다. 설치 소스가 봉인된 기존 bootstrap에서 파생 binding을 준비하며 구독·비밀 교체·운영 설치는 기존 명시 실행 경계를 유지한다. 역할 검증과 분산 commit 사이의 10초 경계는 문서화했다. 서비스 키 교체 때 BFF/Talk binding을 함께 갱신해야 한다. 기존 Talk 내부 본인 배정 API의 자기 토큰 동작은 유지한다.

## 실제 실행 결과

Node 22.18.0·24.19.0에서 아래 각 명령을 각각 실행했다. 최종 exit는 모두 0, skip은 모두 0이다.

| 대상 | 실제 결과(각 Node 버전) |
|---|---|
| j-auth `check` | node:test 18 + Vitest 30, build/typecheck/lint/format 통과 |
| j-auth 전체 `test:integration` | 74개 / 10 files 통과 |
| j-talk `check` | 4개, build/typecheck/lint/format 통과 |
| j-talk 전체 `test:integration` | 15개 / 2 files 통과 |
| j-talk `test:registry` | 실제 immutable `@j-talk/contracts@0.1.2` fresh consumer·pack bytes/SHA-512·lock integrity 1개 통과 |
| j-groupware `check` | 81개, build/typecheck/lint/format 통과 |
| j-groupware 전체 `test:integration` | 194개 / 15 files 통과(콘솔 20·상담 6·상담 알림 6 포함) |
| j-groupware `test:agent:products` | 5개: private env·파생 binding·드리프트 거절·실제 서버 TLS/PG readiness |
| j-groupware `test:agent:bundles` | 4개: fresh archives·pinned lock·실제 cold Talk 기동·TLS/PG readiness |

계약 동시 변경·리비전 충돌·연결 1개에서 10건 직렬 처리, 실제 후보 권한/비활성 변경과 BFF 세션 폐기, 다른 테넌트·CSRF·브라우저 확인서 주입, 실제 임의 배정/재배정·원래 수신자 사건 구별, 확인서 범위·만료·동시 replay, 실제 outbox 실패에서 담당/nonce transaction rollback을 검증했다. 후보 응답 지연에 따른 확인서 만료는 시간 경계를 제어한 단위 테스트이며 네트워크 지연을 실제로 10초 기다린 시험으로 계산하지 않는다.

실행 로그·실제 종료 코드 파일 목록은 클라우드의 `/workspace/.suite-runtime/j-groupware/task24-final-tests.json`에 보존한다. 성공 후 생성한 테스트 임시 디렉터리만 정리했고 기존 캐시·이전 실패 증거·다른 작업은 삭제하지 않았다.

## 실패와 수정 기록

- 초기 전체 BFF: 메일 기동 실패로 8개가 skip되었고, 폐기된 세션을 확인하는 테스트 도우미가 `/api/me` 401을 먼저 받아 배정 테스트가 실패했다. 메일은 별도 실제 진단과 재실행에서 정상 기동했으며, 세션 검사는 요청 자체의 401을 검증하도록 고쳤다. 이 최초 실패는 통과로 계산하지 않았다.
- DB 연결 1개 테스트에서 `pg` 설정을 펼치면서 비열거 password 속성이 빠져 SASL 오류가 발생했다. 외부 테스트 자격을 명시 전달하고 항상 연결을 종료하도록 수정했으며 이후 20개 콘솔 테스트와 전체 회귀가 통과했다. 소스도 잠금 안에서 추가 연결을 요구하지 않도록 조회 연결을 재사용한다.
- 초기 contracts `0.1.1` 게시 후 포맷팅 빌드의 바이트 드리프트를 immutable registry 검사가 발견했다. 기존 게시 버전은 보존하고 최종 포맷의 `0.1.2`를 새 게시해 정확 버전·무결성을 검증했다. Groupware 소비자는 `0.1.2`만 사용한다.
- 한 집중 진단은 npm exec가 Node 26을 선택해 결과를 지원 런타임 검증에서 제외했다. 최종 검증은 Node 22·24 실행 파일과 PATH를 고정한 별도 실행·exit 파일을 근거로 한다.

## 소스·원격 검증

작업 브랜치는 모두 `codex/cloud-auth-foundation-20261008`이다. 사용자 후속 승인에 따라 각 커밋 직후 작업 브랜치에 push했다. 아래 SHA는 `git ls-remote`와 GitHub commit API로 대조했다.

- j-auth: [ac59428ca612bd89b82059830bcca26f79f584d5](https://github.com/wnwjdals7498/j-auth/commit/ac59428ca612bd89b82059830bcca26f79f584d5)
  변경 파일:
  - `j-auth/apps/server/src/app.ts`
  - `j-auth/apps/server/src/keycloak/members.ts`
  - `j-auth/apps/server/src/security/authorize.ts`
  - `j-auth/docs/feature-specifications.md`
  - `j-auth/tests/integration/members.test.ts`
- j-talk: [41c6775c7cafc91090e9e1a93c56479367ab7ec9](https://github.com/wnwjdals7498/j-talk/commit/41c6775c7cafc91090e9e1a93c56479367ab7ec9)
  변경 파일:
  - `j-talk/apps/server/package.json`
  - `j-talk/apps/server/src/app.ts`
  - `j-talk/apps/server/src/assignment.ts`
  - `j-talk/apps/server/src/config.ts`
  - `j-talk/apps/server/src/main.ts`
  - `j-talk/apps/server/src/rooms.ts`
  - `j-talk/deploy/migrations/004-assignment-receipts.sql`
  - `j-talk/docs/decisions.md`
  - `j-talk/docs/feature-specifications.md`
  - `j-talk/package-lock.json`
  - `j-talk/packages/contracts/CHANGELOG.md`
  - `j-talk/packages/contracts/README.md`
  - `j-talk/packages/contracts/package.json`
  - `j-talk/packages/contracts/src/index.ts`
  - `j-talk/tests/integration/rooms.integration.test.ts`
  - `j-talk/tests/integration/runtime.ts`
  - `j-talk/tests/server/assignment.test.ts`
  - `j-talk/tests/server/config.test.ts`
- j-groupware: [c3284e7bff6c87f34610cc37875d558004c0bd1b](https://github.com/wnwjdals7498/j-groupware/commit/c3284e7bff6c87f34610cc37875d558004c0bd1b)
  변경 파일:
  - `j-groupware/apps/console-server/src/app.ts`
  - `j-groupware/apps/console-server/src/customer-routes.ts`
  - `j-groupware/apps/console-server/src/customers.ts`
  - `j-groupware/apps/server/package.json`
  - `j-groupware/apps/server/src/app.ts`
  - `j-groupware/apps/server/src/talk-assignments.ts`
  - `j-groupware/apps/server/src/talk-routes.ts`
  - `j-groupware/deploy/agent/product-environment.d.mts`
  - `j-groupware/deploy/agent/product-environment.mjs`
  - `j-groupware/deploy/agent/provision-agent.mjs`
  - `j-groupware/deploy/agent/provision-service.mjs`
  - `j-groupware/deploy/console-migrations/003-business-contract.sql`
  - `j-groupware/docs/decisions.md`
  - `j-groupware/docs/feature-specifications.md`
  - `j-groupware/package-lock.json`
  - `j-groupware/packages/permissions/src/index.ts`
  - `j-groupware/tests/agent/products.integration.test.mjs`
  - `j-groupware/tests/bff/console.integration.test.ts`
  - `j-groupware/tests/bff/talk-notifications.integration.test.ts`
  - `j-groupware/tests/bff/talk.integration.test.ts`
  - `j-groupware/tests/server/talk-assignments.test.ts`

## 집계와 남은 경계

소스 구현 116 / 부분 34 / 미착수 22 = 172, 남은 56개다. GW-51·TK-21의 backend 소스 구현을 완료로 분류했고 UI·고객 VM·서비스 전체 인수를 완료로 바꾸지 않았다. `whole_suite_verified=false`, `acceptance_complete=false`를 유지한다.

첫 남은 단계는 제품 정책 26·UI 17·실제 VM 13이다. T2 방문자/손님/WSS·소유권, E8 메일 envelope/수신 전 복구, H7 수동 파일과 재배포 보존·교체, 운영 알림 owner/key/topology 정책은 보류 상태다. 기존 UI 기준 응답과 실제 격리 고객 VM·PID1·OS 패키지/CA trust·timer·20GB 데이터 디스크·방화벽·브라우저 인수도 남는다. 공개 방문자 생산은 SQL 방 seed 시험으로 대체하지 않았다. PR 게시·main 병합·배포·운영 OS 계정·영구 자격·timer 활성화는 수행하지 않았다.

진행 근거는 [진행표](implementation-progress.json), [남은 기능 감사](cloud-remaining-feature-audit-2026-10-08.md), [콘솔 결정](decisions.md), [Talk 결정](../../j-talk/docs/decisions.md), [Talk contracts](../../j-talk/packages/contracts/README.md), [Auth 후보 계약](../../j-auth/docs/feature-specifications.md)에서 확인한다.
