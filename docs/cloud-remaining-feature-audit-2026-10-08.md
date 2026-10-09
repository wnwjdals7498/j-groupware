# 남은 기능 감사 — 2026-10-09

기존 명세/결정과 실제 소스·실행 증거 대조. 각 기능의 첫 미완료 단계 기준이며 구현 완료·제품 인수 완료를 뜻하지 않는다. 기술 계약과 선행 서비스는 구현자가 계속할 수 있는 작업이며 사용자/외부 환경 차단으로 취급하지 않는다.

현재 소스 기준: 구현 116, 부분 34, 미착수 22 / 총 172. 남은 56개. 전체 통합 인수: 미완료.

남은56의 첫 다음 단계: 독립 소스0·서비스 선행0·제품 정책26·UI17·실제 VM13. 24차에서 승인된 GW-51/TK-21 backend 소스 구현을 완료해 집계116/34/22로 갱신했다. 정식 UI/VM·T2 공개 visitor producer와 전체 통합 인수는 별도이며 whole_suite_verified=false다.

| 분류 | 남은 수 |
|---|---:|
| 구현 가능 | 0 |
| 기술 계약 확정 선행 | 0 |
| 서비스 구현 선행 | 0 |
| UI 기준 선행 | 17 |
| 제품 정책 결정 필요 | 26 |
| 외부 VM 인수 | 13 |
| 현재 최소 범위 제외 | 0 |

| ID | 서비스 | 기능 | 분류 | 현재 소스 | 다음 단계 |
|---|---|---|---|---|---|
| AU-02 | j-auth | 고객 realm 템플릿 | UI 기준 선행 | partial | 확정될 UI 기준으로 theme를 적용하고 실제 OIDC 브라우저 흐름을 검증한다. |
| AU-05 | j-auth | OIDC 로그인 | UI 기준 선행 | partial | UI 기준 도착 후 로그인 화면과 실제 브라우저 제한 시험을 연결한다. |
| AU-09 | j-auth | 로그인 화면 테마 | UI 기준 선행 | not_started | 기존 질의의 답을 적용해 Keycloak theme를 구현한다. |
| AU-51 | j-auth | VM 검증·측정 | 외부 VM 인수 | not_started | 격리 VM이 지정되면 설치·HTTPS·자원 측정·방화벽 인수를 실행한다. |
| GW-12 | j-groupware | 메뉴 숨김 | UI 기준 선행 | partial | UI 기준에 맞춰 필터된 메뉴만 표시하고 탐색을 시험한다. |
| GW-13 | j-groupware | 회원 목록·추가·삭제 | UI 기준 선행 | partial | 기존 회원 BFF 계약으로 화면과 브라우저 시나리오를 구현한다. |
| GW-14 | j-groupware | 권한 부여·회수 화면 | UI 기준 선행 | partial | UI 기준에 맞춰 기존 권한 계약을 화면에 연결한다. |
| GW-20 | j-groupware | 게시판 | UI 기준 선행 | partial | 기존 게시판 API의 정식 화면을 구현한다. |
| GW-21 | j-groupware | 조직도 편집 | UI 기준 선행 | partial | 기존 조직도 API로 편집 화면과 충돌 안내를 구현한다. |
| GW-30 | j-groupware | 메신저 화면 | UI 기준 선행 | partial | 설치된 공개 client 패키지로 정식 메신저 화면을 연결한다. |
| GW-31 | j-groupware | 메일 화면 | UI 기준 선행 | partial | 기존 read 계약으로 화면·sandbox·Playwright를 구현한다. |
| GW-32 | j-groupware | 손님 관리 화면 | UI 기준 선행 | partial | 기존 UI 질의 응답 후 손님/키 화면과 Playwright 인수를 구현한다. |
| GW-33 | j-groupware | API 키 화면 | UI 기준 선행 | partial | 기존 UI 질의 응답 후 손님/키 화면과 Playwright 인수를 구현한다. |
| GW-34 | j-groupware | 결재 화면 | UI 기준 선행 | partial | 기존 결재 계약으로 상신·승인·반려 화면을 구현한다. |
| GW-35 | j-groupware | 상담 화면 | 제품 정책 결정 필요 | partial | T2 답변 뒤 실제 visitor/WSS 상담 전달을 연결하고 정식 UI 기준 아래 상담 화면을 구현한다. guest:read 조건의 UUID 이름 조합과 무권한 무조회는 검증 완료다. |
| GW-36 | j-groupware | 상담 설정 | UI 기준 선행 | partial | 정식 UI 기준 아래 상담 설정 화면을 연결하고 확정된 visitor 서명 계약을 예제로 제공한다. |
| GW-37 | j-groupware | 웹 관리 화면 | 제품 정책 결정 필요 | partial | 조회·사이트/계정·콘텐츠·preview BFF API는 구현했다. H7 뒤 배포/출처 연결을 완성하고 기존 UI 기준 응답 뒤 정식 화면을 구현한다. |
| GW-38 | j-groupware | 배포 후 허용 출처 등록 | 제품 정책 결정 필요 | not_started | 각 backend 완성 후 성공/후속 origin 실패를 분리한 BFF 연결을 구현한다. |
| GW-40 | j-groupware | 알림 수신 API | 제품 정책 결정 필요 | partial | 운영 owner/갱신·key 회전·배치/전달 책임 확정 뒤 고정 CLI/실제 고객 설치와 연결한다. 새 영구 자격·grant·timer를 임의 도입하지 않는다. |
| GW-44 | j-groupware | 알림 화면 | UI 기준 선행 | partial | 정식 UI와 기존 알림 계약을 연결한다. |
| GW-63 | j-groupware | 부트스트랩 | 외부 VM 인수 | partial | 신뢰한 실제 offline package와 dependency closure·기존 private 입력을 준비해 승인된 고객 VM에서 첫 bootstrap/CA trust/PG Compose/전체 인수를 실행한다. |
| GW-64 | j-groupware | 서비스 설치 | 외부 VM 인수 | partial | 승인된 고객 VM의 기존 준비 입력으로 전체 native 설치·중지/재시도·gateway/방화벽 traffic 인수를 실행한다. 운영 owner·E8/H7 계약은 별도다. |
| GW-65 | j-groupware | 서비스 해지 | 외부 VM 인수 | partial | 고객 VM에서 native 제품 전체 해지·실패/retry·PG/files/backup 보존과 gateway/account/env 순서 인수를 실행한다. 자동 purge는 하지 않는다. |
| GW-66 | j-groupware | 프로비저닝 에이전트 | 외부 VM 인수 | partial | 고객 VM에서 기존 준비 입력의 agent control/unit·실제 installer 호출·timer 실행과 실패/retry를 인수한다. 알림 refresh owner/회전/topology는 임의 지정하지 않는다. |
| GW-71 | j-groupware | UI 기준 | UI 기준 선행 | not_started | 추가 질의를 반복하지 않고 기존 응답을 기다린다. |
| GW-73 | j-groupware | VM 검증·측정 | 외부 VM 인수 | not_started | 설치자 연결 후 지정 VM에서 통합 인수한다. |
| MS-07 | j-messenger | UI 토큰 적용 | UI 기준 선행 | not_started | 확정된 groupware UI token을 통합 client 화면에 적용한다. |
| MS-09 | j-messenger | 고객 서버 검증 | 외부 VM 인수 | not_started | 고객 VM에서 installer·연결·측정을 실행한다. |
| ML-03 | j-mail | 외부 발신 차단 | 외부 VM 인수 | partial | 지정 VM의 실제 방화벽으로 외부 발신 차단을 확인한다. |
| ML-20 | j-mail | 새 메일 알림 | 제품 정책 결정 필요 | not_started | 아래 E8 선택 후 기존 알림 계약에 맞춰 수신·outbox·재시도를 구현한다. |
| ML-30 | j-mail | 저장소 골격·DB | 제품 정책 결정 필요 | partial | E8 결정 후 outbox를 구현하고 installer 연결·VM 인수를 분리한다. |
| ML-32 | j-mail | 고객 서버 검증 | 외부 VM 인수 | not_started | E8 결정과 설치 연결 후 지정 VM에서 검증한다. |
| CA-32 | j-customer-auth-db | 고객 서버 검증 | 외부 VM 인수 | not_started | BFF/gateway/bundle 연결 뒤 지정 VM에서 화면→사이트 서버 로그인→외부 조회와 백업을 실행한다. |
| AP-32 | j-approval | 고객 서버 검증 | 외부 VM 인수 | not_started | 지정 VM에서 systemd·HTTPS·결재 화면 흐름을 확인한다. |
| TK-02 | j-talk | FAB·대화창 | 제품 정책 결정 필요 | partial | visitor producer와 실제 텍스트 대화 UI를 연결하고 브라우저에서 격리를 검증한다. |
| TK-03 | j-talk | 표시 조건 | 제품 정책 결정 필요 | partial | 실제 동작/허용/가입 capability를 연결하고 표시·비표시 각각을 브라우저에서 검증한다. |
| TK-04 | j-talk | 방문자 토큰 보관 | 제품 정책 결정 필요 | not_started | T2에서 방문자 세션 정책을 결정한 뒤 저장·교체한다. |
| TK-05 | j-talk | 손님 구분자 전달 | 제품 정책 결정 필요 | not_started | T2에서 재연결 충돌·소유권을 확정한 뒤 widget 전달을 연결한다. |
| TK-06 | j-talk | 실시간 수신·재연결 | 제품 정책 결정 필요 | not_started | T2 세션 정책과 WSS 계약 후 outbox·cursor 복구를 연결한다. |
| TK-07 | j-talk | 제한 안내 | 제품 정책 결정 필요 | not_started | T2/T4 제한 응답과 widget 안내를 연결한다. |
| TK-08 | j-talk | 삽입 예제 페이지 | 제품 정책 결정 필요 | not_started | 실제 widget·허용 Origin으로 예제 페이지를 실행한다. |
| TK-10 | j-talk | 방문자 토큰 발급 | 제품 정책 결정 필요 | not_started | 방문자 세션 정책을 확정하고 발급·거절을 구현한다. |
| TK-11 | j-talk | 손님 구분자 검증·연결 | 제품 정책 결정 필요 | not_started | 방 소유권·재연결 정책을 확정한 뒤 연결을 구현한다. |
| TK-12 | j-talk | 문의 메시지 보내기·받기 | 제품 정책 결정 필요 | not_started | T2 정책과 T4 인증 후 메시지 저장·방 생성·outbox를 구현한다. |
| TK-13 | j-talk | 출처 검사 | 제품 정책 결정 필요 | partial | 방문자 WSS 인증 정책 확정 후 같은 Origin owner로 actual upgrade/denial을 연결한다. |
| TK-14 | j-talk | 남용 제한 | 제품 정책 결정 필요 | partial | visitor issuer 뒤 visitor/IP rate limit을 구현하고 실제 429 경계를 검증한다. |
| TK-22 | j-talk | 답장 | 제품 정책 결정 필요 | partial | outbox poller와 정책이 확정된 guest WSS/signed cursor 복구를 연결한다. |
| TK-23 | j-talk | 종료 | 제품 정책 결정 필요 | partial | visitor 소유권 정책 뒤 종료 후 새 방 생성과 전체 lifecycle을 검증한다. |
| TK-24 | j-talk | 실시간 전달 | 제품 정책 결정 필요 | partial | visitor 인증 운반 정책 뒤 typed outbox/WSS/signed cursor sync를 구현한다. |
| TK-27 | j-talk | 인증·tenant 격리 | 제품 정책 결정 필요 | partial | TTL/rotation/revocation/rebinding 정책을 확정한 뒤 visitor 인증·방 소유권·제한을 구현한다. |
| TK-41 | j-talk | contracts | 제품 정책 결정 필요 | partial | T2 token 수명/회전/회수·WSS 인증·재연결/방 소유권 정책 확정 뒤 visitor/WSS/cursor 계약을 추가 버전으로 게시한다. |
| TK-42 | j-talk | 고객 서버 검증 | 외부 VM 인수 | not_started | 상담 구현 후 지정 VM에서 설치·해지·외부 widget 흐름을 검증한다. |
| WB-12 | j-web | 배포 | 제품 정책 결정 필요 | not_started | 수동 파일 보존·교체 범위를 결정한 뒤 원자 배포와 rollback을 구현한다. |
| WB-13 | j-web | 위젯 스니펫 삽입 | 제품 정책 결정 필요 | partial | preview의 고정 익명 widget 한 줄은 구현했다. H7 확정 뒤 실제 생성·배포 페이지 모두에 연결해 검증한다. |
| WB-31 | j-web | contracts | 제품 정책 결정 필요 | partial | site/content/DNS/account/error/readonly contracts0.1.0은 최초 immutable 게시·exact 소비했다. H7 뒤 deployment request/state DTO를 고정한다. |
| WB-33 | j-web | 고객 서버 검증 | 외부 VM 인수 | not_started | 웹 구현 후 지정 VM에서 HTTPS·SFTP·FTPS·해지를 검증한다. |

## 독립 구현과 기능 완료의 경계

24차 사용자 승인에 따라 GW-51 업무 계약과 TK-21 최소 활성 후보·신뢰 전달·배정/재배정 소스를 마쳤다. 남은 첫 단계는 T2/E8/H7/운영 알림 정책과 기존 UI 기준·실제 고객 VM 인수이며 component 성공을 전체 인수로 계산하지 않는다.

독립 소스의 첫 다음 단계 0개: .

다음 유한 묶음 권고: .

## 운영 알림 연결에 필요한 계약

- 기존 GET /auth/tenants/<tenant>/services는 실제 operator Bearer와 console serviceKey를 요구한다. supplier 파일은 mode600, access exp<=15분·만료5초전 거절이며 j-auth가 signature/issuer/audience/role/key를 검증한다.
- refresh 자격 소유 operator/클라이언트와 발급·갱신·회수 권한, console key 회전·비밀 보관/교체 책임이 필요하다. 일반 회원 세션/새 영구 token으로 대신하지 않는다.
- 현재 worker는 127.0.0.1의 고객 jgw_groupware DB/private receiver에 연결한다. control-plane credential owner를 어느 호스트에 두고 고객 projection/lease를 어떻게 전달할지 실제 배치 계약이 필요하다. 원격 PG·새 grant·운영 timer를 임의 도입하지 않는다.

## 제품 정책과 실제 인수에 필요한 결정

- T2: 방문자 token 수명·회전·회수와 browser WSS 인증 전달, guestId 재연결/방 소유권 충돌 정책
- H7: 수동 SFTP/FTPS 파일과 template 재배포의 보존·교체 경계
- 기존 UI 기준 질의의 응답(반복 질의하지 않음)
- 실제 외부 인수 실행 시 격리 VM 대상과 권한
- 운영 notification refresh 자격 소유자·key 회전·control-plane/customer 로컬 PG/private receiver 배치 계약

## E8 메일 envelope와 수신 전 누락

전체 SMTP envelope를 신뢰된 capture adapter에 보존하고 Mailpit message ID와 연결. Mailpit fork 없이 정확한 모든 수신자에 기반한 알림이 가능하지만 ingress 구성 하나가 추가된다. 현 Mailpit v1.31.4의 첫 RCPT/Received와 To/Cc/Bcc 표시 header로 전체 envelope를 복원했다고 주장하지 않는다.

대안: Mailpit에 전체 envelope/ID 저장 기능을 추가한 fork; ingress 구성은 줄지만 버전 유지보수 부담이 생긴다.

FS-U07의 현 최소 범위를 유지: webhook 수신 전 누락 허용, 수신·PG 적재 후 outbox 재시도 보장. 별도 복구 기능을 추가하지 않지만 수신 전 알림 누락을 허용한다.

대안: 수신 전 무손실 요구 시 durable ingress/reconciliation을 명시적으로 범위 확대한다. 추가 저장소·복구·중복 관리가 필요하다.

## 실제 검증 범위

24차 Auth 전체74, Talk PG/HTTPS15·unit4·immutable registry1, GWA check81·전체 BFF194/15files(콘솔20·상담6·알림6 포함), 환경 생성 및 fresh bundle 테스트를 Node22.18/24.19에서 실제 실행해 각각 exit0·skip0를 확인했다. 초기 실패·Node26 diagnostic은 별도 보존·제외했으며 수정 후 성공 실행의 exit 파일을 근거로 삼는다. 실제 OS/PID1·UI/브라우저·고객 VM 인수는 실행하지 않았다. j-groupware/docs/cloud-contract-assignment-verification-2026-10-09.md

작업 브랜치의 마지막 소스 커밋:

- web_source_commit: `746c6b21c7b9534dd08de5e76d32e349b62e9531`
- agent_source_commit: `894ddc1a2c81adbca9c9a6c1463506f5751f6ad0`
- talk_source_commit: `41c6775c7cafc91090e9e1a93c56479367ab7ec9`
- console_source_commit: `c3284e7bff6c87f34610cc37875d558004c0bd1b`
- talk_bff_source_commit: `c3284e7bff6c87f34610cc37875d558004c0bd1b`
- bundle_source_commit: `894ddc1a2c81adbca9c9a6c1463506f5751f6ad0`
- bootstrap_source_commit: `894ddc1a2c81adbca9c9a6c1463506f5751f6ad0`
- teardown_source_commit: `894ddc1a2c81adbca9c9a6c1463506f5751f6ad0`
- notification_worker_source_commit: `a1f9d0be005ed2c0bc7af9d5e6b59c0a610d2d36`
- customer_auth_source_commit: `6cbfdc8b4ec6b104f9cf6cc0e96eb73d7229db35`
- customer_auth_test_source_commit: `b15b53bb32942eee832413729940af02c1950edf`
- tls_credentials_source_commit: `64b1d89702e4641f34ed6b24ee7b6254c270b81d`
- tls_credentials_test_source_commit: `66e41b2070ed2aa7c0efcb5e684891b3926db0b6`
- native_storage_source_commit: `894ddc1a2c81adbca9c9a6c1463506f5751f6ad0`
- mail_capture_contracts_source_commit: `92809bc96ca75e1ccfd552f7247d989f6e8f28a2`
- web_bff_source_commit: `6b33637c096414c6031067ba168616aeb0e35b83`

재생성: `python3 scripts/render-feature-audit.py`. JSON·진행표·baseline·분류·ready 집계가 서로 맞아야 생성한다.
