# 남은 기능 감사 — 2026-10-08

기존 명세/결정과 실제 소스·실행 증거 대조. 각 기능의 첫 미완료 단계 기준이며 구현 완료·제품 인수 완료를 뜻하지 않는다. 기술 계약과 선행 서비스는 구현자가 계속할 수 있는 작업이며 사용자/외부 환경 차단으로 취급하지 않는다.

현재 소스 기준: 구현 91, 부분 27, 미착수 54 / 총 172. 남은 81개. 전체 통합 인수: 미완료.

service·contract는 구현자가 계속할 수 있는 선행 작업이다. 실제 외부 차단으로 취급하지 않으며, ready 0은 전체 구현 완료를 뜻하지 않는다.

| 분류 | 남은 수 |
|---|---:|
| 구현 가능 | 0 |
| 기술 계약 확정 선행 | 18 |
| 서비스 구현 선행 | 29 |
| UI 기준 선행 | 14 |
| 제품 정책 결정 필요 | 11 |
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
| GW-32 | j-groupware | 손님 관리 화면 | 서비스 구현 선행 | not_started | C1/C2/C3 backend 후 기존 BFF 인증 패턴으로 relay·화면을 연결한다. |
| GW-33 | j-groupware | API 키 화면 | 서비스 구현 선행 | not_started | C5 backend·one-time secret 계약 후 BFF와 화면을 연결한다. |
| GW-34 | j-groupware | 결재 화면 | UI 기준 선행 | partial | 기존 결재 계약으로 상신·승인·반려 화면을 구현한다. |
| GW-35 | j-groupware | 상담 화면 | 서비스 구현 선행 | not_started | 독립적인 talk 회원 API부터 구현한 뒤 BFF·화면을 연결한다. |
| GW-36 | j-groupware | 상담 설정 | 서비스 구현 선행 | not_started | 관리 API 계약으로 token 축소 relay를 연결하고 UI 기준 도착 후 화면을 구현한다. |
| GW-37 | j-groupware | 웹 관리 화면 | 서비스 구현 선행 | not_started | web DB·인증·helper·계약부터 구현한 뒤 BFF·화면을 연결한다. |
| GW-38 | j-groupware | 배포 후 허용 출처 등록 | 서비스 구현 선행 | not_started | 각 backend 완성 후 성공/후속 origin 실패를 분리한 BFF 연결을 구현한다. |
| GW-40 | j-groupware | 알림 수신 API | 서비스 구현 선행 | partial | 완성된 installer 인증·key provisioning 경계로 실제 가입 연결을 구현한다. |
| GW-44 | j-groupware | 알림 화면 | UI 기준 선행 | partial | 정식 UI와 기존 알림 계약을 연결한다. |
| GW-51 | j-groupware | 고객 목록·계약 상태 | 기술 계약 확정 선행 | not_started | G17 상태 계약을 고정하고 operator API·PG 테스트를 구현한다. |
| GW-52 | j-groupware | 고객 등록 | 기술 계약 확정 선행 | not_started | 기존 key provisioning 경계를 유지해 등록 saga·실패 상태 계약을 정리한다. |
| GW-53 | j-groupware | 가입 서비스 관리 | 기술 계약 확정 선행 | not_started | 콘솔 계약과 기존 서비스 catalog를 연결한다. |
| GW-54 | j-groupware | 원하는 상태 API | 기술 계약 확정 선행 | not_started | 기존 최소 권한 API와 agent polling 계약을 확정하고 실제 연결한다. |
| GW-63 | j-groupware | 부트스트랩 | 서비스 구현 선행 | partial | 콘솔 producer·실제 준비 bundle·bootstrap entrypoint를 구현하고 격리 어댑터를 검증한다. 고객 VM 활성화는 별도다. |
| GW-64 | j-groupware | 서비스 설치 | 서비스 구현 선행 | partial | 구체적인 bundle metadata/packaging 및 서비스별 readiness/env/notification/gateway 어댑터를 연결한다. |
| GW-65 | j-groupware | 서비스 해지 | 서비스 구현 선행 | partial | web remove-all·mail backup 및 실제 gateway rollback을 lifecycle에 연결하고 결합된 격리 경로를 검증한다. |
| GW-66 | j-groupware | 프로비저닝 에이전트 | 서비스 구현 선행 | partial | 기존 reconciler에 desired API 인증과 완료 서비스 installer probe를 연결한다. |
| GW-71 | j-groupware | UI 기준 | UI 기준 선행 | not_started | 추가 질의를 반복하지 않고 기존 응답을 기다린다. |
| GW-73 | j-groupware | VM 검증·측정 | 외부 VM 인수 | not_started | 설치자 연결 후 지정 VM에서 통합 인수한다. |
| MS-07 | j-messenger | UI 토큰 적용 | UI 기준 선행 | not_started | 확정된 groupware UI token을 통합 client 화면에 적용한다. |
| MS-09 | j-messenger | 고객 서버 검증 | 외부 VM 인수 | not_started | 고객 VM에서 installer·연결·측정을 실행한다. |
| ML-03 | j-mail | 외부 발신 차단 | 외부 VM 인수 | partial | 지정 VM의 실제 방화벽으로 외부 발신 차단을 확인한다. |
| ML-20 | j-mail | 새 메일 알림 | 제품 정책 결정 필요 | not_started | 아래 E8 선택 후 기존 알림 계약에 맞춰 수신·outbox·재시도를 구현한다. |
| ML-30 | j-mail | 저장소 골격·DB | 서비스 구현 선행 | partial | E8 결정 후 outbox를 구현하고 installer 연결·VM 인수를 분리한다. |
| ML-32 | j-mail | 고객 서버 검증 | 외부 VM 인수 | not_started | E8 결정과 설치 연결 후 지정 VM에서 검증한다. |
| CA-01 | j-customer-auth-db | 손님 목록·조회 | 서비스 구현 선행 | not_started | C1/C2 이후 tenant 강제 목록·조회와 실제 PG/JWT 검증을 구현한다. |
| CA-02 | j-customer-auth-db | 손님 등록 | 서비스 구현 선행 | not_started | C1/C2 이후 등록·중복·비밀번호 원문 비노출을 검증한다. |
| CA-03 | j-customer-auth-db | 손님 수정·삭제 | 서비스 구현 선행 | not_started | C1/C2 이후 수정·삭제·권한·tenant 경계를 구현한다. |
| CA-04 | j-customer-auth-db | 권한·tenant 검사 | 서비스 구현 선행 | not_started | C1/C2 후 guest:read/write 및 foreign-tenant 거절을 실제 검증한다. |
| CA-10 | j-customer-auth-db | API 키 발급 | 서비스 구현 선행 | not_started | hashed secret·guest scopes·원문 1회 표시를 구현한다. |
| CA-11 | j-customer-auth-db | API 키 목록 | 서비스 구현 선행 | not_started | tenant별 키 metadata만 목록으로 제공하고 원문을 재조회하지 않는다. |
| CA-12 | j-customer-auth-db | API 키 회수 | 서비스 구현 선행 | not_started | 키 회수 후 다음 실제 공개 요청부터 인증 거절을 검증한다. |
| CA-20 | j-customer-auth-db | 손님 목록 조회 | 서비스 구현 선행 | not_started | 공개 손님 read-only 목록·tenant·scope·회수 경계를 구현한다. |
| CA-21 | j-customer-auth-db | 손님 쓰기 | 기술 계약 확정 선행 | not_started | C2/C5에서 guest:write 스코프 포함 규칙만 정의하고 외부 쓰기 route는 이후 범위로 남긴다. |
| CA-22 | j-customer-auth-db | 손님 로그인 | 기술 계약 확정 선행 | not_started | C2 계약 후 C3/C5 기반 로그인·서명 검증을 실제 시험한다. |
| CA-23 | j-customer-auth-db | JWKS 공개 | 기술 계약 확정 선행 | not_started | C2 계약과 일치하는 공개 JWKS 및 JWT 검증을 구현한다. |
| CA-24 | j-customer-auth-db | 로그인 시도 제한 | 기술 계약 확정 선행 | not_started | C2 제한값·429 계약을 고정하고 실제 누적/차단을 시험한다. |
| CA-25 | j-customer-auth-db | OpenAPI 문서 | 기술 계약 확정 선행 | not_started | C2 DTO로 외부 API만 문서화하고 인증 스코프와 일치시킨다. |
| CA-30 | j-customer-auth-db | 저장소 골격·DB | 서비스 구현 선행 | not_started | 전용 jgw_customer_auth DB와 server/contracts·migration부터 구현한다. |
| CA-31 | j-customer-auth-db | contracts | 기술 계약 확정 선행 | not_started | 기존 명세 범위 안에서 contracts와 immutable registry 소비를 구현한다. |
| CA-32 | j-customer-auth-db | 고객 서버 검증 | 외부 VM 인수 | not_started | C1~C6 구현 후 지정 VM에서 C8을 실행한다. |
| AP-32 | j-approval | 고객 서버 검증 | 외부 VM 인수 | not_started | 지정 VM에서 systemd·HTTPS·결재 화면 흐름을 확인한다. |
| TK-02 | j-talk | FAB·대화창 | 서비스 구현 선행 | partial | visitor producer와 실제 텍스트 대화 UI를 연결하고 브라우저에서 격리를 검증한다. |
| TK-03 | j-talk | 표시 조건 | 서비스 구현 선행 | partial | 실제 동작/허용/가입 capability를 연결하고 표시·비표시 각각을 브라우저에서 검증한다. |
| TK-04 | j-talk | 방문자 토큰 보관 | 제품 정책 결정 필요 | not_started | T2에서 방문자 세션 정책을 결정한 뒤 저장·교체한다. |
| TK-05 | j-talk | 손님 구분자 전달 | 제품 정책 결정 필요 | not_started | T2에서 재연결 충돌·소유권을 확정한 뒤 widget 전달을 연결한다. |
| TK-06 | j-talk | 실시간 수신·재연결 | 제품 정책 결정 필요 | not_started | T2 세션 정책과 WSS 계약 후 outbox·cursor 복구를 연결한다. |
| TK-07 | j-talk | 제한 안내 | 서비스 구현 선행 | not_started | T2/T4 제한 응답과 widget 안내를 연결한다. |
| TK-08 | j-talk | 삽입 예제 페이지 | 서비스 구현 선행 | not_started | 실제 widget·허용 Origin으로 예제 페이지를 실행한다. |
| TK-10 | j-talk | 방문자 토큰 발급 | 제품 정책 결정 필요 | not_started | 방문자 세션 정책을 확정하고 발급·거절을 구현한다. |
| TK-11 | j-talk | 손님 구분자 검증·연결 | 제품 정책 결정 필요 | not_started | 방 소유권·재연결 정책을 확정한 뒤 연결을 구현한다. |
| TK-12 | j-talk | 문의 메시지 보내기·받기 | 제품 정책 결정 필요 | not_started | T2 정책과 T4 인증 후 메시지 저장·방 생성·outbox를 구현한다. |
| TK-13 | j-talk | 출처 검사 | 제품 정책 결정 필요 | partial | 방문자 WSS 인증 정책 확정 후 같은 Origin owner로 actual upgrade/denial을 연결한다. |
| TK-14 | j-talk | 남용 제한 | 기술 계약 확정 선행 | partial | visitor issuer 뒤 visitor/IP rate limit을 구현하고 실제 429 경계를 검증한다. |
| TK-21 | j-talk | 배정·재배정 | 서비스 구현 선행 | partial | tenant 회원 배정 대상 검증과 배정 발생별 outbox 알림을 구현한다. |
| TK-22 | j-talk | 답장 | 서비스 구현 선행 | partial | outbox poller와 정책이 확정된 guest WSS/signed cursor 복구를 연결한다. |
| TK-23 | j-talk | 종료 | 서비스 구현 선행 | partial | visitor 소유권 정책 뒤 종료 후 새 방 생성과 전체 lifecycle을 검증한다. |
| TK-24 | j-talk | 실시간 전달 | 제품 정책 결정 필요 | partial | visitor 인증 운반 정책 뒤 typed outbox/WSS/signed cursor sync를 구현한다. |
| TK-27 | j-talk | 인증·tenant 격리 | 제품 정책 결정 필요 | partial | TTL/rotation/revocation/rebinding 정책을 확정한 뒤 visitor 인증·방 소유권·제한을 구현한다. |
| TK-30 | j-talk | 상담 알림 송신 | 기술 계약 확정 선행 | not_started | 실제 occurrence ID를 dedupKey에 고정해 같은 사건 중복만 제거한다. |
| TK-41 | j-talk | contracts | 기술 계약 확정 선행 | not_started | T2 관리/회원 DTO를 먼저 고정하고 visitor 정책 결정을 분리한다. |
| TK-42 | j-talk | 고객 서버 검증 | 외부 VM 인수 | not_started | 상담 구현 후 지정 VM에서 설치·해지·외부 widget 흐름을 검증한다. |
| WB-01 | j-web | 사이트 목록·상태 | 서비스 구현 선행 | not_started | DB 상태와 실제 probe 결과를 구별한 조회를 구현한다. |
| WB-02 | j-web | DNS 안내 | 기술 계약 확정 선행 | not_started | 도메인 검증과 DNS 안내 DTO를 고정하고 문자열·tenant 검증을 구현한다. |
| WB-10 | j-web | 콘텐츠 입력 | 기술 계약 확정 선행 | not_started | H2 검증값을 고정하고 저장·escape를 구현한다. |
| WB-11 | j-web | 미리보기 | 기술 계약 확정 선행 | not_started | H2 입력 검증과 HTML escape로 preview를 구현한다. |
| WB-12 | j-web | 배포 | 제품 정책 결정 필요 | not_started | 수동 파일 보존·교체 범위를 결정한 뒤 원자 배포와 rollback을 구현한다. |
| WB-13 | j-web | 위젯 스니펫 삽입 | 기술 계약 확정 선행 | not_started | 확정된 widget 주소·snippet contract로 삽입 및 escape를 구현한다. |
| WB-31 | j-web | contracts | 기술 계약 확정 선행 | not_started | H1 이후 계약을 고정하고 registry 소비를 검증한다. |
| WB-33 | j-web | 고객 서버 검증 | 외부 VM 인수 | not_started | 웹 구현 후 지정 VM에서 HTTPS·SFTP·FTPS·해지를 검증한다. |

## 제품 정책과 실제 인수에 필요한 결정

- T2: 방문자 token 수명·회전·회수와 browser WSS 인증 전달, guestId 재연결/방 소유권 충돌 정책
- H7: 수동 SFTP/FTPS 파일과 template 재배포의 보존·교체 경계
- 기존 UI 기준 질의의 응답(반복 질의하지 않음)
- 실제 외부 인수 실행 시 격리 VM 대상과 권한

## E8 메일 envelope와 수신 전 누락

전체 SMTP envelope를 신뢰된 capture adapter에 보존하고 Mailpit message ID와 연결. Mailpit fork 없이 정확한 모든 수신자에 기반한 알림이 가능하지만 ingress 구성 하나가 추가된다. 현 Mailpit v1.31.4의 첫 RCPT/Received와 To/Cc/Bcc 표시 header로 전체 envelope를 복원했다고 주장하지 않는다.

대안: Mailpit에 전체 envelope/ID 저장 기능을 추가한 fork; ingress 구성은 줄지만 버전 유지보수 부담이 생긴다.

FS-U07의 현 최소 범위를 유지: webhook 수신 전 누락 허용, 수신·PG 적재 후 outbox 재시도 보장. 별도 복구 기능을 추가하지 않지만 수신 전 알림 누락을 허용한다.

대안: 수신 전 무손실 요구 시 durable ingress/reconciliation을 명시적으로 범위 확대한다. 추가 저장소·복구·중복 관리가 필요하다.

## 실제 검증 범위

[연결 구현·검증 증거](cloud-connected-implementation-2026-10-08.md)를 참조한다. 웹 HTTP 11개와 호스팅 4개, agent 18개와 실제 PG 3개, 상담 14개는 Node22/24 각각 통과했고 BFF 133개는 Node24에서 통과했다. 고객 VM·실제 채팅/브라우저·전체 제품군 인수는 미완료다.

작업 브랜치의 마지막 소스 커밋:

- web_source_commit: `13861dd835362992f6ba0ee8bd237e30db8ca0ba`
- agent_source_commit: `f0183ac404a3e6bfefaffb2fd9e1e54289e4d756`
- talk_source_commit: `a022105102ffe680cf040b4d57f6f46e1d54d804`

재생성: `python3 scripts/render-feature-audit.py`. JSON·진행표·baseline·분류·ready 집계가 서로 맞아야 생성한다.
