# 남은 기능 감사 — 2026-10-09

기존 명세/결정과 실제 소스·실행 증거 대조. 각 기능의 첫 미완료 단계 기준이며 구현 완료·제품 인수 완료를 뜻하지 않는다. 기술 계약과 선행 서비스는 구현자가 계속할 수 있는 작업이며 사용자/외부 환경 차단으로 취급하지 않는다.

현재 소스 기준: 구현 114, 부분 36, 미착수 22 / 총 172. 남은 58개. 전체 통합 인수: 미완료.

남은58의 첫 다음 단계: 독립 소스3·서비스 선행1·제품 정책28·UI17·실제 VM9. 22차 기능 source 완료는 TK-30 한 개이고 TK-41은 미착수에서 부분으로 전환했다. 관리 계정 삭제/retry·prepared 알림 binding·bootstrap wrapper 소스 기여 및 분류 변경을 전체 기능 완료와 구별한다.

| 분류 | 남은 수 |
|---|---:|
| 구현 가능 | 3 |
| 기술 계약 확정 선행 | 0 |
| 서비스 구현 선행 | 1 |
| UI 기준 선행 | 17 |
| 제품 정책 결정 필요 | 28 |
| 외부 VM 인수 | 9 |
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
| GW-51 | j-groupware | 고객 목록·계약 상태 | 제품 정책 결정 필요 | partial | 업무 계약 상태·초기값·전이/권한·구독 영향을 확정한 뒤 콘솔 PG/변경 API를 구현한다. |
| GW-63 | j-groupware | 부트스트랩 | 구현 가능 | partial | OS package/전용 PG/CA trust/full bootstrap kit의 소스·준비 입력을 계속 구현한다. 실제 호스트 설치·계정·trust/timer 활성화는 별도 승인/VM 인수다. |
| GW-64 | j-groupware | 서비스 설치 | 구현 가능 | partial | Web privileged helper/SFTP·FTPS·gateway와 나머지 native 설치 입력/실패 경계를 연결한다. Mail E8·운영 알림 owner·H7 관문은 별도이며 임의 CLI 활성화하지 않는다. |
| GW-65 | j-groupware | 서비스 해지 | 서비스 구현 선행 | partial | GW-64 native 설치 조합을 완성한 뒤 Web/알림 포함 전체 해지 조합·PID1/고객 VM 인수를 실행한다. source fixture를 전체 기능 완료로 계산하지 않는다. |
| GW-66 | j-groupware | 프로비저닝 에이전트 | 구현 가능 | partial | 기존 one-shot agent와 full kit/남은 제품 installer 연결을 계속 구현한다. operating agent config/timer/고객 VM 활성화는 별도다. |
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
| TK-21 | j-talk | 배정·재배정 | 제품 정책 결정 필요 | partial | 최소 후보 조회 권한·대상 자격/가용성·BFF가 검증한 대상의 Talk 전달 계약을 확정한 뒤 임의 담당자 배정/재배정을 구현한다. |
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

22차 독립9 중 TK-30 source 완료, TK-41 member/settings 계약·GW-65 계정 제거/retry·GW-40 명시적 prepared binding·bootstrap wrapper 연결을 구현했다. 9개 전체 기능 완료로 계산하지 않는다. 첫 다음 단계 3개는 독립 소스, 4개는 정책, 1개는 서비스 선행으로 이동했으며 기존 UI/VM 관문은 유지한다.

독립 소스의 첫 다음 단계 3개: GW-63, GW-64, GW-66.

다음 유한 묶음 권고: GW-63, GW-64, GW-66.

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
- GW-51: 업무 계약 상태 enum·초기 상태·허용 전이·변경 권한 및 서비스 구독 영향. 고객 등록/authState와 구분한다.
- TK-21: talk:write 담당자의 최소 같은-tenant 배정 후보 조회 권한·대상 자격/가용성 및 BFF 검증 대상의 Talk 전달 계약. 기존 member:manage/org:manage 권한을 임의 추가하지 않는다.

## E8 메일 envelope와 수신 전 누락

전체 SMTP envelope를 신뢰된 capture adapter에 보존하고 Mailpit message ID와 연결. Mailpit fork 없이 정확한 모든 수신자에 기반한 알림이 가능하지만 ingress 구성 하나가 추가된다. 현 Mailpit v1.31.4의 첫 RCPT/Received와 To/Cc/Bcc 표시 header로 전체 envelope를 복원했다고 주장하지 않는다.

대안: Mailpit에 전체 envelope/ID 저장 기능을 추가한 fork; ingress 구성은 줄지만 버전 유지보수 부담이 생긴다.

FS-U07의 현 최소 범위를 유지: webhook 수신 전 누락 허용, 수신·PG 적재 후 outbox 재시도 보장. 별도 복구 기능을 추가하지 않지만 수신 전 알림 누락을 허용한다.

대안: 수신 전 무손실 요구 시 durable ingress/reconciliation을 명시적으로 범위 확대한다. 추가 저장소·복구·중복 관리가 필요하다.

## 실제 검증 범위

[22차 실제 증거](cloud-independent-nine-verification-2026-10-09.md): Node22.18/24.19 전체 BFF191/15files·check80·agent26·fresh unpack19·owned root storage/native6 각각exit0/skip0. Talk check2·실제 PG integration14/2files·registry1 각각exit0. focused Talk/G22 6과 worker7은 전체191에 포함하며 중복 합산하지 않는다. 실제 원래 담당자·서로 다른 occurrence/SSE·receiver/ACK 장애·compiled sender 강제 종료/실제20초 lease 복구와 owned 컨테이너 계정 실제 제거/보존 bytes/실패 재시도를 검증했다. 실제 OS package/PG 설치·systemd PID1 전체 native 흐름·CA trust/agent config/timer/VM·정식 UI/브라우저와 H7/T2/E8는 미실행이다. 초기 실패 로그는 보존하고 16차 receiver startup 원인은 미확정이다.

작업 브랜치의 마지막 소스 커밋:

- web_source_commit: `2a1753fa4dffa048deadfa261014c8cb24e316b2`
- agent_source_commit: `a1f9d0be005ed2c0bc7af9d5e6b59c0a610d2d36`
- talk_source_commit: `ff6d4eb706ff366e0c3babb4c8726cfed1793581`
- console_source_commit: `998a48abe1e66f2aefd88d28fa6adda07627107c`
- talk_bff_source_commit: `95b4967a30012dfa7fbdcf20974e54c70d1606ff`
- bundle_source_commit: `a1f9d0be005ed2c0bc7af9d5e6b59c0a610d2d36`
- bootstrap_source_commit: `a1f9d0be005ed2c0bc7af9d5e6b59c0a610d2d36`
- teardown_source_commit: `a1f9d0be005ed2c0bc7af9d5e6b59c0a610d2d36`
- notification_worker_source_commit: `a1f9d0be005ed2c0bc7af9d5e6b59c0a610d2d36`
- customer_auth_source_commit: `6cbfdc8b4ec6b104f9cf6cc0e96eb73d7229db35`
- customer_auth_test_source_commit: `b15b53bb32942eee832413729940af02c1950edf`
- tls_credentials_source_commit: `64b1d89702e4641f34ed6b24ee7b6254c270b81d`
- tls_credentials_test_source_commit: `66e41b2070ed2aa7c0efcb5e684891b3926db0b6`
- native_storage_source_commit: `a1f9d0be005ed2c0bc7af9d5e6b59c0a610d2d36`
- mail_capture_contracts_source_commit: `92809bc96ca75e1ccfd552f7247d989f6e8f28a2`
- web_bff_source_commit: `6b33637c096414c6031067ba168616aeb0e35b83`

재생성: `python3 scripts/render-feature-audit.py`. JSON·진행표·baseline·분류·ready 집계가 서로 맞아야 생성한다.
