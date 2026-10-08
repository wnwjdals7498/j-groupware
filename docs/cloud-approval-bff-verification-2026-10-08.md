# 클라우드 결재 BFF 실제 연결 — 2026-10-08

선행 j-groupware `89c6890475dbd69c974803b0f4932f9faa262af2`와 j-approval `5079b02b3c53944d7a3da3422e1573998f5bb593`를 같은 작업 브랜치에서 연결했다. UI 기준 답변 전에도 독립 backend는 진행하며 운영 데이터/자격/배포는 변경하지 않는다.

## 고정 중계 계약

`@j-approval/contracts@0.1.0`을 실제 loopback 레지스트리에서 정확한 버전으로 설치했다. `JGW_SERVICE_APPROVAL_URL`은 고정 loopback origin/포트이며 3001·외부 host·임의 경로를 허용하지 않는다.

`/api/approval/documents`의 POST 상신/GET 목록, `/:id` 상세, `/:id/history` 이력, `/:id/decisions` POST 승인·반려를 중계한다. 모든 route는 `approval:use` 쿠키 세션이며 변경 요청은 정확한 Origin과 기존 CSRF를 검사한다. body/query의 추가 tenant/actor/path/audience 필드는 거절한다. 상신 전에 G15의 같은 tenant 등록·enabled 후보/작성자 제외/중복 검사를 수행한다.

G23의 실제 token exchange/cache를 통해 단일 audience `j-approval` bearer만 하위 서버에 보낸다. 브라우저 bearer/cookie/Origin과 임의 헤더는 보내지 않는다. 하위 JSON은 최대 1 MiB로 제한하고 문서/목록/이력의 계약 필드만 반환한다. 하위 오류 본문·헤더·message를 복사하지 않으며 400/401/403/404/409/503의 안전한 BFF 오류로 변환한다. 변경 요청을 자동 재시도하지 않는다.

## 실제 실행

- `npm ci --ignore-scripts --offline`: 변경 lockfile 설치 성공.
- `npm run check`: build/typecheck·단위 48/48·lint/format 통과.
- 전체 `npm run test:integration`: 73/73, 실패·skip 0. 기존 63개와 결재 BFF 실제 10개다.

실제 j-auth가 만든 두 임시 고객 realm과 회원, 실제 Code/PKCE와 Keycloak 단일 audience token, 별도 PG `jgw_groupware`/`jgw_approval`, compiled j-approval HTTPS 서버 두 개를 사용했다. 실제 상신→N단계 승인/반려→목록/이력, 작성자/현재 지정자/외부 회원, 후보·CSRF·임의 identity 거절, 조직도 배치 변경 후 snapshot 보존, 두 tenant 격리, token exchange 장애·같은 revision 동시 결정 1회와 logout 후 cache 폐기를 확인했다. BFF는 하위 서비스 DB를 직접 조회하지 않는다. DB 직접 읽기는 격리 시험 관찰/정리에만 있다.

초기 전체 회귀에서 이전 실패 시험의 고아 j-auth 프로세스가 포트 54231을 점유하고 이전 임시 realm 자격을 cache한 문제가 발견됐다. cwd·실행 파일·격리 env를 확인해 해당 테스트 프로세스만 정상 종료했다. 시험 harness는 이미 사용 중인 포트면 시작을 거절하고, 이미 signal 종료된 자식도 다시 기다리지 않는다. 전체 재실행 73개 성공과 포트 해제를 확인했으며 실패 실행/시작 실패로 미실행된 시험을 통과로 계산하지 않았다.

원본은 체크아웃 밖 `/workspace/.suite-runtime/j-groupware/approval-check.log`, `approval-integration-results.json`, `approval-integration.log`, `approval-ci.log`다. GW-34는 BFF만 부분 구현이며 화면/Playwright·고객 VM·알림 배달·실제 메신저 업무 인수는 미실행이다. `whole_suite_verified=false`를 유지한다.
