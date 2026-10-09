# 남은 기능 감사 — 2026-10-09

기존 명세/결정과 실제 소스·실행 증거 대조. 각 기능의 첫 미완료 단계 기준이며 구현 완료·제품 인수 완료를 뜻하지 않는다. 기술 계약과 선행 서비스는 구현자가 계속할 수 있는 작업이며 사용자/외부 환경 차단으로 취급하지 않는다.

현재 소스 기준: 구현 109, 부분 32, 미착수 31 / 총 172. 남은 63개. 전체 통합 인수: 미완료.

남은63의 첫 다음 단계 재감사: 독립 소스 작업16, T2/E8/H7 정책 선행21, 기존 UI 기준 응답 선행17, 실제 고객 VM 인수9. ready16은 기능 완료16을 뜻하지 않는다. native control/CA·Messenger 조합과 Messenger/Mailpit storage/PG·SQLite·파일 복원은 격리 검증했지만 전체 bootstrap·나머지 운영 binding·OS account 제거·systemd/CA trust/timer·VM 인수는 남았다. 운영 notification 자격 갱신 주체와 control-plane→고객 로컬 PG/private receiver 토폴로지를 임의 결정하지 않는다.

| 분류 | 남은 수 |
|---|---:|
| 구현 가능 | 16 |
| 기술 계약 확정 선행 | 0 |
| 서비스 구현 선행 | 0 |
| UI 기준 선행 | 17 |
| 제품 정책 결정 필요 | 21 |
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
| GW-37 | j-groupware | 웹 관리 화면 | 구현 가능 | not_started | H2 readonly/사이트/콘텐츠 계약과 기존 helper 공개 인터페이스를 먼저 고정해 API/BFF를 연결한다. 정식 화면은 UI 기준 뒤다. |
| GW-38 | j-groupware | 배포 후 허용 출처 등록 | 제품 정책 결정 필요 | not_started | 각 backend 완성 후 성공/후속 origin 실패를 분리한 BFF 연결을 구현한다. |
| GW-40 | j-groupware | 알림 수신 API | 구현 가능 | partial | 기존 manifest/worker와 남은 installer 조합의 입력·실패 경계를 연결한다. 운영 operator 자격 공급/갱신 주체와 로컬 PG/receiver 배치는 별도 결정한다. |
| GW-44 | j-groupware | 알림 화면 | UI 기준 선행 | partial | 정식 UI와 기존 알림 계약을 연결한다. |
| GW-51 | j-groupware | 고객 목록·계약 상태 | 구현 가능 | partial | 명세의 G7 계약 상태 enum·전이·변경 DTO/API를 고정하고 기존 콘솔 PG/권한과 연결한다. 단순 고객 조회 완료로 계약 변경을 완료 처리하지 않는다. |
| GW-63 | j-groupware | 부트스트랩 | 구현 가능 | partial | 준비된 번들·기본 BFF·PG·CA·agent를 연결하는 전체 bootstrap 소스와 재시작 경계를 완성한다. 실제 OS trust/systemd/timer 설치 인수는 별도다. |
| GW-64 | j-groupware | 서비스 설치 | 구현 가능 | partial | 검증된 CA/Messenger 조합을 전체 bootstrap에 연결하고 나머지 제품의 trusted adapter 입력을 고정한다. operating notification owner/topology와 실제 OS 설치는 별도다. |
| GW-65 | j-groupware | 서비스 해지 | 구현 가능 | partial | 기존 Web helper와 새 storage/DB 정리의 전체 조합·account 제거 재시도 계약을 연결한다. OS account 실제 제거/제품 의미적 복원/VM 인수를 소스 시험으로 대체하지 않는다. |
| GW-66 | j-groupware | 프로비저닝 에이전트 | 구현 가능 | partial | 고정 agent와 native 설치자의 나머지 제품 binding/실패 보고를 연결한다. 운영 알림 자격·timer 활성화·VM 인수는 별도다. |
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
| TK-21 | j-talk | 배정·재배정 | 구현 가능 | partial | 기존 회원 공개 API로 같은 tenant의 배정 대상 검증·재배정을 연결하고 occurrence별 outbox를 구현한다. visitor 전달은 T2 뒤다. |
| TK-22 | j-talk | 답장 | 제품 정책 결정 필요 | partial | outbox poller와 정책이 확정된 guest WSS/signed cursor 복구를 연결한다. |
| TK-23 | j-talk | 종료 | 제품 정책 결정 필요 | partial | visitor 소유권 정책 뒤 종료 후 새 방 생성과 전체 lifecycle을 검증한다. |
| TK-24 | j-talk | 실시간 전달 | 제품 정책 결정 필요 | partial | visitor 인증 운반 정책 뒤 typed outbox/WSS/signed cursor sync를 구현한다. |
| TK-27 | j-talk | 인증·tenant 격리 | 제품 정책 결정 필요 | partial | TTL/rotation/revocation/rebinding 정책을 확정한 뒤 visitor 인증·방 소유권·제한을 구현한다. |
| TK-30 | j-talk | 상담 알림 송신 | 구현 가능 | not_started | 회원 배정 occurrence ID와 고정 dedupKey·PG outbox/retry를 먼저 연결한다. talk.new visitor producer는 T2 뒤다. |
| TK-41 | j-talk | contracts | 구현 가능 | not_started | 관리/회원의 현재 DTO와 사건 계약을 정확 버전으로 고정한다. visitor 발급/WSS 계약은 T2 뒤다. |
| TK-42 | j-talk | 고객 서버 검증 | 외부 VM 인수 | not_started | 상담 구현 후 지정 VM에서 설치·해지·외부 widget 흐름을 검증한다. |
| WB-01 | j-web | 사이트 목록·상태 | 구현 가능 | not_started | H2 상태 DTO와 기존 helper의 owned 공개 probe를 연결해 저장 상태·실제 준비 결과·실패를 구별한다. |
| WB-02 | j-web | DNS 안내 | 구현 가능 | not_started | H2 도메인/tenant 검증과 A-record/hosts 안내 DTO를 고정한다. DNS 쓰기는 추가하지 않는다. |
| WB-10 | j-web | 콘텐츠 입력 | 구현 가능 | not_started | H2 콘텐츠 필드·로고 MIME/bytes 상한을 기술 계약으로 고정하고 HTML escape/저장을 구현한다. 수동 파일 교체는 H7 뒤다. |
| WB-11 | j-web | 미리보기 | 구현 가능 | not_started | H2 입력 검증·HTML escape로 readonly 미리보기를 구현한다. 실제 public-root 교체는 H7 뒤다. |
| WB-12 | j-web | 배포 | 제품 정책 결정 필요 | not_started | 수동 파일 보존·교체 범위를 결정한 뒤 원자 배포와 rollback을 구현한다. |
| WB-13 | j-web | 위젯 스니펫 삽입 | 구현 가능 | not_started | 확정된 tenant gateway widget 주소 한 줄을 항상 넣는 snippet 계약·escape를 구현한다. visitor 엔진·배포 덮어쓰기 정책과 구별한다. |
| WB-31 | j-web | contracts | 구현 가능 | not_started | H2 사이트/콘텐츠/계정/오류/배포 DTO를 정확 버전으로 고정하고 immutable registry 소비를 검증한다. 실행 정책 H7은 별도다. |
| WB-33 | j-web | 고객 서버 검증 | 외부 VM 인수 | not_started | 웹 구현 후 지정 VM에서 HTTPS·SFTP·FTPS·해지를 검증한다. |

## 독립 구현과 기능 완료의 경계

H2 contracts/readonly 조회·검증·미리보기/snippet과 BFF 공개 계약까지만. H7 public-root 교체, T2 visitor 엔진, UI/VM 인수로 확장하지 않는다. 설치의 나머지 조합과 console/Talk 회원 계약도 독립 소스 미완료이며 환경 차단으로 숨기지 않는다.

독립 소스의 첫 다음 단계 16개: GW-37, GW-40, GW-51, GW-63, GW-64, GW-65, GW-66, TK-21, TK-30, TK-41, WB-01, WB-02, WB-10, WB-11, WB-13, WB-31.

다음 유한 묶음 권고: WB-31, WB-02, WB-10, WB-11, WB-13, WB-01, GW-37.

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

[20차 native/storage 증거](cloud-native-storage-verification-2026-10-09.md): Node22/24 전체 BFF179 각각13files/exit0/skip0, root storage/native5·agent core21·cold unpack19·groupware check77·mail check9unit+3deploy·mail registry1 각각exit0이다. 실제 파일 권한·정지/재시작 거절·PG custom dump restore·Mailpit SMTP/SQLite 동일 ID/본문 복원과 native control/factory/wrapper inert/거절 검증이다. 실제 systemd 설치·Messenger 공개 모듈 의미적 복원·운영 갱신/토폴로지·OS account 제거·timer·20GB/VM·방화벽·UI/전체 인수는 미실행이다. 첫 cold 허용경로 누락과 전체 BFF175pass/4skip/exit1, fixture 준비와 object-field-order 비교 실패의 로그를 보존한다. 이전 receiver startup 원인은 여전히 미확정이다.

작업 브랜치의 마지막 소스 커밋:

- web_source_commit: `13861dd835362992f6ba0ee8bd237e30db8ca0ba`
- agent_source_commit: `b4e4310919edd2189c6f45e8768c7aa19dc29821`
- talk_source_commit: `41f84030119d8deaa7eff94079f95da1a4a7d23b`
- console_source_commit: `998a48abe1e66f2aefd88d28fa6adda07627107c`
- talk_bff_source_commit: `8525b5804fe6aa5ffff3d438612a1b0353c3af1d`
- bundle_source_commit: `b4e4310919edd2189c6f45e8768c7aa19dc29821`
- bootstrap_source_commit: `aa2a2f13e88fa1e6959ccb08c276434a8e7c831f`
- teardown_source_commit: `b4e4310919edd2189c6f45e8768c7aa19dc29821`
- notification_worker_source_commit: `ea24dd34636bcfebbf89ec26d87c79831a577ece`
- customer_auth_source_commit: `6cbfdc8b4ec6b104f9cf6cc0e96eb73d7229db35`
- customer_auth_test_source_commit: `b15b53bb32942eee832413729940af02c1950edf`
- tls_credentials_source_commit: `64b1d89702e4641f34ed6b24ee7b6254c270b81d`
- tls_credentials_test_source_commit: `66e41b2070ed2aa7c0efcb5e684891b3926db0b6`
- native_storage_source_commit: `b4e4310919edd2189c6f45e8768c7aa19dc29821`
- mail_capture_contracts_source_commit: `92809bc96ca75e1ccfd552f7247d989f6e8f28a2`

재생성: `python3 scripts/render-feature-audit.py`. JSON·진행표·baseline·분류·ready 집계가 서로 맞아야 생성한다.
