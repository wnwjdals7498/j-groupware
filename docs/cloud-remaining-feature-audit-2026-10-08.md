# 남은 96개 기능 전수 분류 — 2026-10-08

기존 명세/결정과 실제 소스·실행 증거 대조. 각 기능의 첫 미완료 단계 기준이며 구현 완료·제품 인수 완료를 뜻하지 않는다. 기술 계약과 선행 서비스는 구현자가 계속할 수 있는 작업이며 사용자/외부 환경 차단으로 취급하지 않는다.

현재 구현 76개·부분 20개·미착수 76개, 총 172개다. 이전 66/19/87 기준과 원본 상태는 [JSON](cloud-remaining-feature-audit-2026-10-08.json)에 보존했다. ready 20개 중 10개 구현·5개 부분·5개 미착수다. 완료된 10개를 목록에서 제거했고 미완료 10개는 실제 첫 의존성으로 교정했다. ready 0은 전체 완료를 뜻하지 않는다. `whole_suite_verified=false`다.

| 분류 | 수 | 의미 |
| --- | ---: | --- |
| 구현 가능 | 0 | 구현자가 계속할 수 있는 선행 작업 |
| 기술 계약 확정 선행 | 20 | 구현자가 계속할 수 있는 선행 작업 |
| 서비스 구현 선행 | 42 | 구현자가 계속할 수 있는 선행 작업 |
| UI 기준 선행 | 14 | 외부/사용자 관문 |
| 제품 정책 결정 필요 | 11 | 외부/사용자 관문 |
| 외부 VM 인수 | 9 | 외부/사용자 관문 |
| 현재 최소 범위 제외 | 0 | 외부/사용자 관문 |

service·contract는 구현자가 계속할 수 있는 선행 작업이다. 실제 외부 차단으로 취급하지 않으며, ready 0은 전체 구현 완료를 뜻하지 않는다.

기술 enum·길이·오류·endpoint·FTPS/helper 선택은 구현자 작업이다. 방문자 수명/재연결/소유권과 수동 업로드 덮어쓰기·메일 E8 수신 전 누락 보장은 제품 정책으로 구별한다. UI 질의는 기존 대기를 유지하고 회사 노트북·운영 호스트 설치는 수행하지 않는다.

| ID | 기능 | 첫 미완료 단계 | 근거·다음 작업 |
| --- | --- | --- | --- |
| AU-02 | 고객 realm 템플릿 | UI 기준 선행 | realm import·claim·권한 소유자 검증은 실행했으나 로그인 theme와 브라우저 인수가 남았다. 확정될 UI 기준으로 theme를 적용하고 실제 OIDC 브라우저 흐름을 검증한다. |
| AU-05 | OIDC 로그인 | UI 기준 선행 | Code/PKCE·state·nonce·쿠키·갱신은 검증했고 theme·Playwright·brute-force 인수는 남았다. UI 기준 도착 후 로그인 화면과 실제 브라우저 제한 시험을 연결한다. |
| AU-09 | 로그인 화면 테마 | UI 기준 선행 | 정식 로그인 디자인 기준 문서가 없고 기존 사용자 질의가 대기 중이다. 기존 질의의 답을 적용해 Keycloak theme를 구현한다. |
| AU-51 | VM 검증·측정 | 외부 VM 인수 | 고객 Hyper-V/VM 대상과 운영 인수 권한이 제공되지 않았다. 격리 VM이 지정되면 설치·HTTPS·자원 측정·방화벽 인수를 실행한다. |
| GW-12 | 메뉴 숨김 | UI 기준 선행 | 역할별 메뉴 데이터 필터는 검증했으나 정식 sidebar가 없다. UI 기준에 맞춰 필터된 메뉴만 표시하고 탐색을 시험한다. |
| GW-13 | 회원 목록·추가·삭제 | UI 기준 선행 | 회원 생성·삭제·경합·재시도 API는 실제 검증했고 회원 화면이 남았다. 기존 회원 BFF 계약으로 화면과 브라우저 시나리오를 구현한다. |
| GW-14 | 권한 부여·회수 화면 | UI 기준 선행 | 권한 catalog·읽기 포함·grant/revoke는 검증했고 checkbox 화면이 없다. UI 기준에 맞춰 기존 권한 계약을 화면에 연결한다. |
| GW-20 | 게시판 | UI 기준 선행 | PG 게시판·tenant·cursor·권한 검사는 검증했고 화면이 없다. 기존 게시판 API의 정식 화면을 구현한다. |
| GW-21 | 조직도 편집 | UI 기준 선행 | 조직도 CRUD·제약·revision 경합은 검증했고 화면이 없다. 기존 조직도 API로 편집 화면과 충돌 안내를 구현한다. |
| GW-30 | 메신저 화면 | UI 기준 선행 | 메신저 HTTP·WSS·첨부 BFF까지 이번 배치로 연결했으나 정식 화면은 없다. 설치된 공개 client 패키지로 정식 메신저 화면을 연결한다. |
| GW-31 | 메일 화면 | UI 기준 선행 | 실제 SMTP·PG·Keycloak 메일 BFF는 검증했고 HTML sandbox 정식 화면이 없다. 기존 read 계약으로 화면·sandbox·Playwright를 구현한다. |
| GW-32 | 손님 관리 화면 | 서비스 구현 선행 | 손님 CRUD backend가 아직 docs-only다. UI 기준도 별도로 필요하다. C1/C2/C3 backend 후 기존 BFF 인증 패턴으로 relay·화면을 연결한다. |
| GW-33 | API 키 화면 | 서비스 구현 선행 | 손님 API 키 backend가 아직 없으며 UI 기준도 필요하다. C5 backend·one-time secret 계약 후 BFF와 화면을 연결한다. |
| GW-34 | 결재 화면 | UI 기준 선행 | 결재 backend/BFF는 검증했고 정식 화면이 없다. 기존 결재 계약으로 상신·승인·반려 화면을 구현한다. |
| GW-35 | 상담 화면 | 서비스 구현 선행 | 상담 회원 API backend가 없고 정식 UI 기준도 필요하다. 독립적인 talk 회원 API부터 구현한 뒤 BFF·화면을 연결한다. |
| GW-36 | 상담 설정 | 서비스 구현 선행 | talk Origin·widget 키 backend는 실제 검증했다. 그룹웨어 설정 BFF relay와 정식 UI가 없다. 관리 API 계약으로 token 축소 relay를 연결하고 UI 기준 도착 후 화면을 구현한다. |
| GW-37 | 웹 관리 화면 | 서비스 구현 선행 | web DB·회원 조회 backend는 구현했다. helper·사이트/계정 변경·정식 웹 관리 UI가 없다. web DB·인증·helper·계약부터 구현한 뒤 BFF·화면을 연결한다. |
| GW-38 | 배포 후 허용 출처 등록 | 서비스 구현 선행 | talk origin API는 실제 검증했다. web deploy 및 성공/출처 등록 부분 실패 BFF 연결이 없다. 각 backend 완성 후 성공/후속 origin 실패를 분리한 BFF 연결을 구현한다. |
| GW-40 | 알림 수신 API | 서비스 구현 선행 | 알림 receiver·구독 갱신·교체 겹침은 검증됐고 production installer key provisioning 연결이 없다. 완성된 installer 인증·key provisioning 경계로 실제 가입 연결을 구현한다. |
| GW-44 | 알림 화면 | UI 기준 선행 | 알림 목록·읽음·SSE backend는 검증했고 아이콘·탐색 화면이 없다. 정식 UI와 기존 알림 계약을 연결한다. |
| GW-51 | 고객 목록·계약 상태 | 기술 계약 확정 선행 | 고객 목록·계약 상태 요구는 확정됐고 구체 상태 enum·전이·DTO가 기술 계약으로 남았다. G17 상태 계약을 고정하고 operator API·PG 테스트를 구현한다. |
| GW-52 | 고객 등록 | 기술 계약 확정 선행 | j-auth 고객/realm 생성 API는 있으나 콘솔의 실패 복구·installer 키 교체 연결 계약이 남았다. 기존 key provisioning 경계를 유지해 등록 saga·실패 상태 계약을 정리한다. |
| GW-53 | 가입 서비스 관리 | 기술 계약 확정 선행 | 서비스 가입/해제 API는 구현됐고 콘솔 DTO·desired/actual 표시 연결이 남았다. 콘솔 계약과 기존 서비스 catalog를 연결한다. |
| GW-54 | 원하는 상태 API | 기술 계약 확정 선행 | desired 상태 API·agent 인증/키 교체·revision 계약을 G17/G21에서 연결해야 한다. 기존 최소 권한 API와 agent polling 계약을 확정하고 실제 연결한다. |
| GW-63 | 부트스트랩 | 서비스 구현 선행 | 콘솔 로그인은 실제 검증했지만 GW-52의 one-time agent 키·고객 bootstrap 정보 producer와 GW-54의 agent 인증 계약 및 패키지/env/CA·agent 설치 묶음이 없다. GW-52/GW-54의 agent 키·desired-state producer 후 기본 bundle/env/CA와 격리 bootstrap adapter를 구현한다. |
| GW-64 | 서비스 설치 | 서비스 구현 선행 | 실제 service bundle/env 프로필·알림 키 provisioning과 설치 inventory가 없고, guest·talk 방문자·web helper 등 일부 producer가 미완료다. 완성된 서비스별 bundle manifest·notification key 등록과 격리 DB/unit/nginx adapter를 구현한다. |
| GW-65 | 서비스 해지 | 서비스 구현 선행 | 설치 inventory·DB/계정 소유권과 서비스별 remove adapter가 없어서 systemd→dump→NOLOGIN→고유 정리→nginx rollback→env 삭제를 한 경로로 실행할 수 없다. GW-64 소유권 기록·WB-25/mail volume 정리와 함께 S14 실행 adapter를 실제 격리 fixture로 검증한다. |
| GW-66 | 프로비저닝 에이전트 | 서비스 구현 선행 | 내부 reconciler의 process/file/lock/retry는 검증됐고 console wire·실제 installer/probe adapter는 없다. 기존 reconciler에 desired API 인증과 완료 서비스 installer probe를 연결한다. |
| GW-71 | UI 기준 | UI 기준 선행 | canonical docs/ui-guidelines.md가 없으며 이미 질의가 대기 중이다. 추가 질의를 반복하지 않고 기존 응답을 기다린다. |
| GW-73 | VM 검증·측정 | 외부 VM 인수 | suite 고객 VM·설치·해지·외부 접속 인수 대상이 없다. 설치자 연결 후 지정 VM에서 통합 인수한다. |
| MS-07 | UI 토큰 적용 | UI 기준 선행 | 메신저 formal UI token 기준이 없다. 확정된 groupware UI token을 통합 client 화면에 적용한다. |
| MS-09 | 고객 서버 검증 | 외부 VM 인수 | 클라우드 PG/BFF 검증을 고객 VM systemd·방화벽·자원 측정으로 대체할 수 없다. 고객 VM에서 installer·연결·측정을 실행한다. |
| ML-03 | 외부 발신 차단 | 외부 VM 인수 | network-none 내부 SMTP capture는 검증했고 고객 VM의 25/465/587 egress 방화벽은 미실행이다. 지정 VM의 실제 방화벽으로 외부 발신 차단을 확인한다. |
| ML-20 | 새 메일 알림 | 제품 정책 결정 필요 | E8의 full SMTP envelope 수신자 보존 경로와 수신 전 webhook 누락 허용 범위가 확정되지 않았다. 아래 E8 선택 후 기존 알림 계약에 맞춰 수신·outbox·재시도를 구현한다. |
| ML-30 | 저장소 골격·DB | 서비스 구현 선행 | 전용 DB·migration은 검증됐고 E8 결정 뒤 outbox 및 systemd/VM 연결이 남았다. E8 결정 후 outbox를 구현하고 installer 연결·VM 인수를 분리한다. |
| ML-32 | 고객 서버 검증 | 외부 VM 인수 | 고객 VM mail 서비스·gateway·방화벽 인수 대상이 없다. E8 결정과 설치 연결 후 지정 VM에서 검증한다. |
| CA-01 | 손님 목록·조회 | 서비스 구현 선행 | C1/C2/C3 손님 저장소·계약·인증 골격이 없다. C1/C2 이후 tenant 강제 목록·조회와 실제 PG/JWT 검증을 구현한다. |
| CA-02 | 손님 등록 | 서비스 구현 선행 | C1/C2/C3 골격이 없지만 guest:write·argon2id 저장 요구는 확정돼 있다. C1/C2 이후 등록·중복·비밀번호 원문 비노출을 검증한다. |
| CA-03 | 손님 수정·삭제 | 서비스 구현 선행 | C3 저장소가 없지만 tenant/권한 CRUD 요구는 확정돼 있다. C1/C2 이후 수정·삭제·권한·tenant 경계를 구현한다. |
| CA-04 | 권한·tenant 검사 | 서비스 구현 선행 | j-auth audience/role 검증 패턴은 있으나 손님 서버 골격이 없다. C1/C2 후 guest:read/write 및 foreign-tenant 거절을 실제 검증한다. |
| CA-10 | API 키 발급 | 서비스 구현 선행 | C3 손님 backend 뒤 C5 키 발급 계약을 연결해야 한다. hashed secret·guest scopes·원문 1회 표시를 구현한다. |
| CA-11 | API 키 목록 | 서비스 구현 선행 | C5 키 backend가 없다. tenant별 키 metadata만 목록으로 제공하고 원문을 재조회하지 않는다. |
| CA-12 | API 키 회수 | 서비스 구현 선행 | C5 키 backend가 없다. 키 회수 후 다음 실제 공개 요청부터 인증 거절을 검증한다. |
| CA-20 | 손님 목록 조회 | 서비스 구현 선행 | C3/C5 backend와 API key scope 게이트가 없다. 공개 손님 read-only 목록·tenant·scope·회수 경계를 구현한다. |
| CA-21 | 손님 쓰기 | 기술 계약 확정 선행 | 현재 작업은 외부 쓰기 스코프의 계약 정의이며 공개 CRUD route는 첫 구현에서 열지 않는다. C2/C5에서 guest:write 스코프 포함 규칙만 정의하고 외부 쓰기 route는 이후 범위로 남긴다. |
| CA-22 | 손님 로그인 | 기술 계약 확정 선행 | API 키 필수·서명 JWT·JWKS·동일 실패는 확정됐고 알고리즘·TTL·claim은 C2의 구현자 기술 확정 항목이다. C2 계약 후 C3/C5 기반 로그인·서명 검증을 실제 시험한다. |
| CA-23 | JWKS 공개 | 기술 계약 확정 선행 | 공개 JWKS 요구는 확정됐고 경로·kid·알고리즘은 C2에서 고정한다. C2 계약과 일치하는 공개 JWKS 및 JWT 검증을 구현한다. |
| CA-24 | 로그인 시도 제한 | 기술 계약 확정 선행 | account/IP 시도 제한 요구는 확정됐고 정확한 수치는 C2에서 고정할 기술 계약이다. C2 제한값·429 계약을 고정하고 실제 누적/차단을 시험한다. |
| CA-25 | OpenAPI 문서 | 기술 계약 확정 선행 | @fastify/swagger와 /ext/customer-auth/ 공개 경로는 확정돼 있다. C2 DTO로 외부 API만 문서화하고 인증 스코프와 일치시킨다. |
| CA-30 | 저장소 골격·DB | 서비스 구현 선행 | C1은 독립적으로 착수할 수 있고 실제 auth·PG cloud 환경은 준비돼 있다. 전용 jgw_customer_auth DB와 server/contracts·migration부터 구현한다. |
| CA-31 | contracts | 기술 계약 확정 선행 | 관리·로그인·공개 API DTO와 오류·JWT 규격은 C2에서 구현자가 고정한다. 기존 명세 범위 안에서 contracts와 immutable registry 소비를 구현한다. |
| CA-32 | 고객 서버 검증 | 외부 VM 인수 | 손님 서비스 코드와 고객 VM 인수가 모두 남았고 VM 대상은 없다. C1~C6 구현 후 지정 VM에서 C8을 실행한다. |
| AP-32 | 고객 서버 검증 | 외부 VM 인수 | 결재 실제 backend/BFF 검증 이후 고객 VM 인수 대상이 없다. 지정 VM에서 systemd·HTTPS·결재 화면 흐름을 확인한다. |
| TK-01 | 위젯 배포 파일 | 서비스 구현 선행 | 단일 JS 번들만 만드는 것은 실제 방문자 채팅 위젯 완료가 아니다. 방문자·방·WSS/outbox API producer와 표시 조건 relay가 없다. TK-10/12/24/41 뒤 실제 widget를 만들고 고정 경로·ETag·gzip 크기를 측정한다. |
| TK-02 | FAB·대화창 | 서비스 구현 선행 | Shadow DOM/FAB 형태는 확정됐으나 visitor engine/transport가 없다. widget 표면과 backend transport를 단계적으로 연결하고 실제 왕복 전에는 완료 처리하지 않는다. |
| TK-03 | 표시 조건 | 서비스 구현 선행 | 스크립트 load·활성 가입·브라우저 token 세 조건 요구는 확정됐으나 token/가입 조회가 없다. T4/T5 정책·활성 조회 후 표시 조건을 검증한다. |
| TK-04 | 방문자 토큰 보관 | 제품 정책 결정 필요 | 방문자 토큰 수명·회전·회수 정책과 browser WSS 인증 전달이 미정이다. T2에서 방문자 세션 정책을 결정한 뒤 저장·교체한다. |
| TK-05 | 손님 구분자 전달 | 제품 정책 결정 필요 | guestId 서명 형식은 명세가 있으나 기존 방문자/방과 손님 재연결·소유권 정책이 미정이다. T2에서 재연결 충돌·소유권을 확정한 뒤 widget 전달을 연결한다. |
| TK-06 | 실시간 수신·재연결 | 제품 정책 결정 필요 | browser WSS 전달·세션 종료 정책이 없고 visitor 엔진도 없다. T2 세션 정책과 WSS 계약 후 outbox·cursor 복구를 연결한다. |
| TK-07 | 제한 안내 | 서비스 구현 선행 | 429 안내 요구는 확정됐으나 실제 제한 응답 backend가 없다. T2/T4 제한 응답과 widget 안내를 연결한다. |
| TK-08 | 삽입 예제 페이지 | 서비스 구현 선행 | 위젯 삽입 예제 요구는 확정됐으나 배포 파일과 실제 backend가 없다. 실제 widget·허용 Origin으로 예제 페이지를 실행한다. |
| TK-10 | 방문자 토큰 발급 | 제품 정책 결정 필요 | visitor 토큰의 TTL·회전·회수는 인증 정책이며 임의 수치를 만들 수 없다. 방문자 세션 정책을 확정하고 발급·거절을 구현한다. |
| TK-11 | 손님 구분자 검증·연결 | 제품 정책 결정 필요 | 서명 위조는 익명 처리로 정해졌으나 기존 방·guestId 재연결 충돌의 처리가 미정이다. 방 소유권·재연결 정책을 확정한 뒤 연결을 구현한다. |
| TK-12 | 문의 메시지 보내기·받기 | 제품 정책 결정 필요 | 메시지 길이·속도·열린 방 1개는 정해졌으나 visitor 세션/방 소유권 정책이 미정이다. T2 정책과 T4 인증 후 메시지 저장·방 생성·outbox를 구현한다. |
| TK-13 | 출처 검사 | 제품 정책 결정 필요 | 정확한 Origin DB 검사와 실제 HTTP GET/OPTIONS는 구현했다. 방문자 WSS 인증 운반·재연결 정책과 이를 소비할 WSS endpoint가 미정이다. 방문자 WSS 인증 정책 확정 후 같은 Origin owner로 actual upgrade/denial을 연결한다. |
| TK-14 | 남용 제한 | 기술 계약 확정 선행 | IP 발급 10/min·메시지 20/min·4KB·열린 방 1개는 확정돼 있으며 byte 계산·429 DTO가 T2 기술 계약이다. 제한 contract와 원자 counter를 구현하고 visitor 인증 연결 후 실제 초과를 검증한다. |
| TK-20 | 문의방 목록·조회 | 서비스 구현 선행 | 상담 목록·조회·talk:read·tenant 격리는 확정됐고 T1/T2 서버 골격이 없다. 회원용 방 조회부터 독립 구현하고 actual JWT/PG를 검증한다. |
| TK-21 | 배정·재배정 | 서비스 구현 선행 | 배정/재배정·talk:write·상태 전이는 확정됐고 T1/T2 골격이 없다. 회원 배정·경합·이력·알림 occurrence ID를 구현한다. |
| TK-22 | 답장 | 서비스 구현 선행 | talk:write 회원 답장·종료방 409 요구는 확정됐고 엔진이 없다. 회원 메시지 저장·outbox를 먼저 구현한다. |
| TK-23 | 종료 | 서비스 구현 선행 | talk:write 종료·닫힌 방 답장 거절은 확정됐고 엔진이 없다. 원자 종료와 경합·중복·409를 구현한다. |
| TK-24 | 실시간 전달 | 제품 정책 결정 필요 | 회원 Bearer는 확정됐으나 visitor browser WSS 인증과 종료/회전이 미정이다. 확정된 visitor transport로 실제 WSS·단절·재연결을 검증한다. |
| TK-27 | 인증·tenant 격리 | 제품 정책 결정 필요 | 회원 JWT·role·tenant·실제 JWKS/DB 실패는 구현했다. 방문자 token 수명/회전/회수와 손님 재연결·기존 방 소유권 변경 정책은 미정이다. TTL/rotation/revocation/rebinding 정책을 확정한 뒤 visitor 인증·방 소유권·제한을 구현한다. |
| TK-30 | 상담 알림 송신 | 기술 계약 확정 선행 | talk.new/assigned 대상과 PG outbox·재시도는 확정됐고 재배정 반복의 사건 ID가 T2/G22에서 필요하다. 실제 occurrence ID를 dedupKey에 고정해 같은 사건 중복만 제거한다. |
| TK-40 | 저장소 골격·DB | 서비스 구현 선행 | server·내부 관리 contracts·실제 전용 PG/HTTPS는 구현했다. apps/widget와 방·방문자 contracts/엔진·전체 T2 게시가 없다. 실제 visitor/room producer를 구현한 뒤 widget workspace·완전한 T2 계약을 만든다. |
| TK-41 | contracts | 기술 계약 확정 선행 | 관리/회원 계약은 독립 고정 가능하고 visitor 정책에 의존하는 계약 부분은 별도다. T2 관리/회원 DTO를 먼저 고정하고 visitor 정책 결정을 분리한다. |
| TK-42 | 고객 서버 검증 | 외부 VM 인수 | 상담 T1~T7 구현과 고객 VM 대상이 필요하다. 상담 구현 후 지정 VM에서 설치·해지·외부 widget 흐름을 검증한다. |
| WB-01 | 사이트 목록·상태 | 서비스 구현 선행 | 사이트 상태 조회 요구는 확정됐고 H1/H2·helper probe가 없다. DB 상태와 실제 probe 결과를 구별한 조회를 구현한다. |
| WB-02 | DNS 안내 | 기술 계약 확정 선행 | hosts/DNS 안내 요구는 확정됐고 구체 응답 DTO는 H2에서 고정한다. 도메인 검증과 DNS 안내 DTO를 고정하고 문자열·tenant 검증을 구현한다. |
| WB-03 | 사이트 생성 | 서비스 구현 선행 | 도메인 unique·UUID site·helper create·backup 실패 처리는 확정됐고 H6가 없다. H1/H2/H4/H5 뒤 실제 helper·rollback을 연결한다. |
| WB-04 | 사이트 삭제 | 서비스 구현 선행 | 사이트 삭제 시 backup 이동 요구는 확정됐고 H6가 없다. helper 삭제·Nginx 검사·백업 실패 중단을 구현한다. |
| WB-05 | 사이트 계정 | 서비스 구현 선행 | nologin·root chroot·public writable·암호 1회 표시가 확정됐고 helper가 없다. H6 account 명령·계정 격리와 원문 비로그를 검증한다. |
| WB-06 | 계정 비밀번호 재설정 | 서비스 구현 선행 | 비밀번호 stdin·hash-only·1회 표시 요구는 확정됐고 helper가 없다. helper password 변경과 실패 복구·비로그를 검증한다. |
| WB-07 | 인증·tenant 격리 | 서비스 구현 선행 | 실제 회원 j-web aud·read/write 복합 조회·401/403·foreign404·JWKS/DB503은 검증했다. helper를 쓰는 실제 web:write 변경 route가 없다. H5/H6 helper·사이트/계정 변경 route에 같은 memberGate로 write 검사를 연결한다. |
| WB-10 | 콘텐츠 입력 | 기술 계약 확정 선행 | 콘텐츠 필드와 HTML escape는 확정됐고 로고 MIME·bytes·필드 상한은 H2 기술 계약이다. H2 검증값을 고정하고 저장·escape를 구현한다. |
| WB-11 | 미리보기 | 기술 계약 확정 선행 | 단일 템플릿 미리보기 요구는 확정돼 있다. H2 입력 검증과 HTML escape로 preview를 구현한다. |
| WB-12 | 배포 | 제품 정책 결정 필요 | 원자 교체·직전 버전 보관은 정해졌지만 SFTP/FTPS 수동 파일과 템플릿 재배포의 덮어쓰기 경계가 없다. 수동 파일 보존·교체 범위를 결정한 뒤 원자 배포와 rollback을 구현한다. |
| WB-13 | 위젯 스니펫 삽입 | 기술 계약 확정 선행 | 고정 widget snippet을 항상 포함하도록 결정돼 있다. 확정된 widget 주소·snippet contract로 삽입 및 escape를 구현한다. |
| WB-20 | 특권 helper | 서비스 구현 선행 | H5의 실제 SFTP/FTPS/local-user 호스팅 fixture(WB-32)와 OS helper 실행·부분 상태/rollback producer가 없다. 하위 명령·경로 규칙은 확정된 구현자 작업이다. H5 공식 제품/계정 fixture를 만든 뒤 7개 고정 helper 명령·secret stdin·Nginx rollback을 격리 root container에서 검증한다. |
| WB-21 | 사이트 서빙 | 서비스 구현 선행 | 고정 Nginx template·nginx -t·rollback은 확정됐고 helper/H5가 없다. 실제 isolated Nginx 서빙과 실패 시 이전 설정 복구를 검증한다. |
| WB-22 | 사이트용 SFTP | 서비스 구현 선행 | 분리 sshd·chroot·nologin·암호 인증은 확정됐고 H5/H6가 없다. 격리 OpenSSH로 파일/계정 격리·shell 거절을 검증한다. |
| WB-23 | FTPS | 기술 계약 확정 선행 | FTPS 제품·local-user 통합·패시브 포트는 H5 공식 문서 조사와 선택을 구현자에게 위임했다. 공식 제품 자료로 버전을 고정하고 TLS·평문 거절·계정 격리를 cloud에서 시험한다. |
| WB-24 | 사이트 데이터 디스크 | 서비스 구현 선행 | 고정 루트 실제 mountinfo·device·statfs와 cloud mount 누락 거절은 구현했다. site du 및 helper 쓰기 전 probe 연결과 실제 별도 디스크가 남았다. WB-20/사이트 디렉터리 producer에 du·쓰기 guard를 연결하고 별도 20GB 대상의 positive mount 인수를 실행한다. |
| WB-25 | 해지 정리 | 서비스 구현 선행 | remove-all의 block→Nginx 검사→계정→backup 이동 순서가 확정됐고 helper가 없다. 실제 helper 해지와 실패 중단·재실행을 검증한다. |
| WB-31 | contracts | 기술 계약 확정 선행 | 사이트·배포·계정 상태/DTO는 H2에서 구현자가 고정한다. H1 이후 계약을 고정하고 registry 소비를 검증한다. |
| WB-32 | 로컬 테스트 호스팅 | 기술 계약 확정 선행 | H5 버전 고정 Compose와 TLS·공유 볼륨 요구는 확정됐고 FTPS 제품 선택이 선행이다. 공식 자료로 FTPS를 선택한 후 격리된 실제 Nginx/SFTP/FTPS 시험을 만든다. |
| WB-33 | 고객 서버 검증 | 외부 VM 인수 | 웹 H1~H8 구현과 별도 데이터 디스크가 있는 고객 VM 대상이 필요하다. 웹 구현 후 지정 VM에서 HTTPS·SFTP·FTPS·해지를 검증한다. |
