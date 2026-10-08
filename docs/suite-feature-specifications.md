# j-groupware-suite 기능 명세 기준

작성일: 2026-10-08. 기존 기능 목록 172개를 상세 동작과 인수 시험에 연결했다. **기능 구현·시험 결과가 아니라 구현할 동작의 명세다.** PMT 작업은 통합 project `j-groupware-suite`의 `[suite] X2 기능 명세 보완 (8개 서비스)`다.

## 문서와 기준

실제 소스·검증 범위와 미구현 항목은 [구현 추적표](implementation-progress.json)에 기록한다. 단위·정적 검사와 실제 서비스 인수 시험을 구별하며, 회사 노트북에서는 시스템 설치·Docker 기동을 하지 않는다.

2026-10-08 클라우드에서 j-auth 서버·tenant DB·토큰/서비스 키 검증·회원 API를 구현하고 실제 Keycloak·PostgreSQL 통합 검사를 수행했다. [실행 결과와 미실행 범위](../../j-auth/docs/cloud-verification-2026-10-08.md)를 근거로 추적표를 갱신했다. 전체 브라우저·BFF·VM 인수는 아직 완료하지 않았다.

공통 결정의 원본은 [architecture.md](architecture.md), 서비스별 결정의 원본은 각 저장소의 `decisions.md`다. 기존 결정을 바꾸는 내용은 확정된 요구사항으로 추가하지 않는다. 아래 명세의 세부 처리·인수 시험은 기존 결정을 구체화한 구현 기준이며, 미정 표의 항목은 담당 Item에서 확인한 뒤 contracts에 고정한다.

| 서비스 | 기존 기능 목록 | 상세 명세 | 기능 수 | 담당 Item |
| --- | --- | --- | --- | --- |
| j-auth | [목록](../../j-auth/docs/features.md) | [명세](../../j-auth/docs/feature-specifications.md) | 28 | I1~I8 |
| j-groupware | [목록](features.md) | [명세](feature-specifications.md) | 48 | G1~G23, X1 |
| j-messenger | [연결 목록](../../j-messenger/docs/suite-integration-features.md) | [연결 명세](../../j-messenger/docs/suite-integration-specifications.md) | 9 | M1~M5 |
| j-mail | [목록](../../j-mail/docs/features.md) | [명세](../../j-mail/docs/feature-specifications.md) | 11 | E1~E8 |
| j-customer-auth-db | [목록](../../j-customer-auth-db/docs/features.md) | [명세](../../j-customer-auth-db/docs/feature-specifications.md) | 16 | C1~C8 |
| j-approval | [목록](../../j-approval/docs/features.md) | [명세](../../j-approval/docs/feature-specifications.md) | 14 | A1~A9 |
| j-talk | [목록](../../j-talk/docs/features.md) | [명세](../../j-talk/docs/feature-specifications.md) | 25 | T1~T9 |
| j-web | [목록](../../j-web/docs/features.md) | [명세](../../j-web/docs/feature-specifications.md) | 21 | H1~H9 |

j-messenger의 기존 메시지 기능은 [기존 명세](../../j-messenger/docs/pmt-docs/10-feature-specifications.md)를 유지한다. 여기서는 제품군 연결만 다룬다. j-game-client는 범위 미정이라 기능 수에 포함하지 않는다.

## 공통 입출력

| 항목 | 계약 |
| --- | --- |
| 회원 식별 | Keycloak 회원은 `sub`(회원 id), `username`, `tenant`, effective roles를 구별한다. 조직도·결재선은 `sub`, 기존 메신저는 `(tenant, username)`을 쓴다. username을 결재자 id로 대체하지 않는다. |
| tenant | 내부 API는 검증된 토큰에서, 외부 API는 API 키·방문자 토큰에 묶인 서버 상태에서 결정한다. 요청 본문·쿼리의 tenant로 인증 경계를 덮어쓰지 않는다. |
| 역할 | j-auth contracts 카탈로그의 service client role을 펼친 권한이다. 화면 메뉴와 서버 route가 같은 권한 기준을 쓰고, 서비스를 가진 API 서버도 다시 검사한다. |
| 목록 | 현재 tenant의 항목·다음 페이지 정보. 다른 tenant를 필터링한 뒤 페이지·전체 건수를 계산한다. 페이지 방식·상한·정렬은 담당 contracts Item에서 명시한다. |
| 변경 | 검증 → 현재 대상·권한 확인 → 업무 변경 → 결과 반환. 성공 응답과 실제 데이터 변화가 함께 성립해야 한다. 처리 중 의존 서비스 장애를 성공으로 반환하지 않는다. |
| 오류 | 안전한 오류 종류와 추적 식별자. HTTP 상태와 서비스 코드·필드명은 contracts에 고정하고 UI에서 재로그인·권한 없음·충돌·재시도를 구분한다. |
| 비밀값 | 원문 1회 반환 항목은 응답 재조회·목록·로그에서 원문을 반환하지 않는다. 응답 유실 시 기존 원문 복구 대신 정해진 교체/재설정 경로를 쓴다. |
| 시간·크기 | 저장·API 시각은 시간대를 표현하는 형식으로 고정한다. `exp`는 해당 계약의 유닉스 초다. KB 제한은 문자열 글자 수와 구별해 실제 전송/저장 바이트로 시험한다. 정확한 단위는 contracts 관문에서 확정한다. |

웹 브라우저는 j-groupware 세션 쿠키로 접근한다. 하위 서비스용 Bearer·서비스 키는 BFF 서버가 붙인다. j-auth 관리 API는 원래 사용자 토큰과 호출 서비스 키, 하위 서비스는 G23 완료 후 서비스 하나의 audience로 축소한 토큰을 사용한다([S4](architecture.md#s4)).

## 실패와 저장 경계

| 상황 | 기대 동작 |
| --- | --- |
| 입력 규격 위반 | 계약의 입력 오류(일반 HTTP API 400). 업무 쓰기·outbox·특권 명령을 시작하지 않는다. SMTP는 SMTP 거부로 검사한다. |
| 인증 누락·무효·만료 | 401. 키/토큰 원문이나 계정 존재 여부를 노출하지 않는다. JWKS를 얻지 못해 검증할 수 없는 장애는 명세에 따른 503으로 구별한다. |
| 인증됐으나 권한 없음 | 403. 메뉴를 숨겨도 직접 API·WSS 접근을 거절해야 한다. |
| 없는 대상·다른 tenant의 대상 | 대상 존재를 노출하지 않는 404. 토큰 자체의 허용 tenant 위반은 인증/접근 거절로 처리한다. |
| 중복·이미 종결·경합 | 명세가 지정한 409. 결재·메시지 재시도·프로비저닝의 서로 다른 중복 규칙을 한 가지로 합치지 않는다. |
| 제한 초과 | 429. gateway는 `limit_req_status`·`limit_conn_status`를 명시한다. UI는 기다렸다 재시도할 수 있음을 표시한다. |
| DB·Keycloak·Mailpit·helper 장애 | 지정된 장애 응답과 실제 반영 상태. 외부 변경 후 로컬 저장 실패처럼 부분 완료가 가능하면 재시도 전 실제 상태를 확인한다. |

서비스의 업무 데이터는 해당 서비스 DB가 소유한다. BFF에는 세션·게시판·조직도·알림, 콘솔에는 고객·계약·원하는 가입 상태·에이전트 보고만 둔다. 다른 서비스 DB 직접 조회는 금지한다([S2](architecture.md#s2)).

DB 변경과 outbox 적재는 같은 서비스 트랜잭션에 넣고, 외부 송신은 commit 뒤 한다. 재시도는 같은 발생 사건을 식별하는 키를 유지한다. 알림 중복 경계는 `(tenant, service, dedupKey)`이며 서로 다른 실제 사건은 다른 키여야 한다. `type`은 사건 종류이지 발생 식별자가 아니다.

## 종단 시나리오

| ID | 사용자 흐름 | 최종 인수 기준 | 담당 |
| --- | --- | --- | --- |
| SU-T01 | 고객 관리자 로그인 → 하위 회원 추가 → 게시판 쓰기 부여 → 회원 재로그인 → 글 작성 | 메뉴와 API 권한 일치, 쓰기→읽기 포함, 권한 변경 시 기존 세션·WSS 종료, 다른 tenant 접근 거절 | I4·I6, G3~G8 |
| SU-T02 | 고객 같은 tenant의 두 회원이 메신저 메뉴에서 송수신 → 연결 단절·재연결 | 기존 dedup·outbox·cursor 복구 유지, 다른 tenant 대화 접근 불가, 로그아웃 후 연결 종료 | M1~M5, G12 |
| SU-T03 | 내부 SMTP 발송 → 메일 목록·상세 → HTML 표시 | 같은 tenant 공유 받은편지함, 타 tenant id 404, HTML 스크립트 실행 불가, 외부 수신자 SMTP 거부 | E2·E3·E5, G14 |
| SU-T04 | 손님 등록 → API 키 발급 → 사이트 서버 역할 스크립트 로그인 → 외부 목록 조회 → 키 회수 | JWT·JWKS 일치, 키의 tenant·스코프 검사, 회수 즉시 인증 거절, 비밀 원문 재조회 불가 | C3~C6, G13 |
| SU-T05 | 조직도 결재선 편집 → 상신 → N단계 승인 또는 반려 → 이력 조회 | 현재 지정자만 처리, 스냅샷 불변, 같은 단계 동시 처리 1회, 반려 사유 필수 | A4~A7, G15·G16 |
| SU-T06 | 허용 출처 위젯 문의 → 상담 메뉴 배정·답장·종료 → 다시 문의 | 실시간 전달·sync 복구, 새 문의방 생성, 다른 방문자의 방 접근 거절, 잘못된 손님 서명은 익명 | T4~T7, G19 |
| SU-T07 | 웹 관리에서 사이트 생성 → 미리보기·배포 → HTTPS 접속 → SFTP·FTPS 업로드 | 계정·파일 격리, 평문 FTP·셸 거절, DNS 안내, 위젯 스니펫 포함; 출처 등록 실패가 배포 성공을 바꾸지 않음 | H4~H8, G20 |
| SU-T08 | 결재·상담·메일 사건 → 알림 수신 → 목록·SSE → 읽음 | 같은 사건 재송신에도 1건, 현재 회원 권한·수신 대상만 노출, 회원별 읽음과 30일 보관 | G22, A9·T9·E8 |
| SU-T09 | 운영 콘솔 고객 등록 → 수동 VM 생성·부트스트랩 → 서비스 가입·해지 | realm·원하는 상태·인증 가입·설치 결과를 구별, 동일 상태 재실행 무변경, 실패 표시·복구, 해지 백업 | I7·I8, G17·G18·G21 |

위 시험은 **예정 시험**이다. 실제 Keycloak·PostgreSQL과 필요한 서비스를 사용하고, 화면 시험은 j-groupware에서 수행한다. 문서 검사 통과를 위 시나리오 통과로 기록하지 않는다. VM의 설치·해지·방화벽 시험은 격리된 검증 대상과 해당 실행 권한을 확인한 뒤 한다.

## 구현 전 확정·확인할 것

| ID | 남은 내용 | 관문·영향 |
| --- | --- | --- |
| FS-U01 | 2026-10-08 적용 확인: 기존 S10 Verdaccio 원안 유지, 6.10.5 고정 | 패키지 배포 방식 비교를 마쳤다. Node 실제 fixture와 회사 노트북 설치 금지로 미실행인 Docker 경로를 구별한다. |
| FS-U02 | 정확한 제품·패키지 버전, 포트·페이지 상한·필드 길이·오류 코드 | 각 골격/contracts Item에서 고정한다. 3001은 사용하지 않는다. 기존 결정을 바꾸는 값은 별도 결정이다. |
| FS-U03 | FGAP v2 허용/거절 실측, provisioner 최소 자격, token exchange의 단일 aud·roles 유지 | I2·I7·G23의 실제 Keycloak 시험 관문. 구성 존재만으로 보안 요구 충족을 판단하지 않는다. |
| FS-U04 | 손님 JWT 알고리즘·수명·claim·JWKS 경로, 로그인 제한값, API 키 헤더·스코프 포함 규칙 | C2에서 정하고 C4·C5·G13·사이트 서버 예제를 동일 계약에 맞춘다. |
| FS-U05 | 방문자 토큰 수명·회전·회수 경로, 브라우저 WSS 인증 전달, sync cursor·중복 사건 규격 | T2에서 정한다. 브라우저 기본 WebSocket은 임의 Authorization 헤더를 지정할 수 없으므로 HTTP 헤더 규칙만으로 WSS를 완성했다고 판단하지 않는다. |
| FS-U06 | FTPS 제품·인증 저장소·패시브 포트, 로고 형식·크기, 사이트 상태·파일 배포 방식 | H2·H5에서 고정하고 H6·H7·G20과 일치시킨다. |
| FS-U07 | Mailpit webhook 수신 전 누락에 대한 허용 범위·복구 필요 여부 | E8 전에 결정한다. webhook은 기본 빈도 제한으로 누락될 수 있고 실패를 재시도하지 않는다. j-mail outbox는 수신·적재 후 송신 재시도만 보장한다. 별도 복구 기능을 이번 범위에 추가하지 않는다. |
| FS-U08 | 조직도 상세 제약, 삭제된 결재자의 진행 문서 처리, 실제 사건별 알림 키·서비스 키 교체 | G15·A2·T2·G22에서 계약을 고정한다. 없는 결재자 id를 외부 서비스 조회로 검증하는 기능은 기존 범위에 없다. |
| FS-U09 | 설치·VM 검증 Item의 선행 관계와 직렬 순서 | G18 등 배포 준비와 G10·서비스별 VM 검증의 관계를 실행 계획에서 점검한다. 상세 명세 작성으로 기존 blocked_by를 임의 해제하지 않는다. |

## 완료 판정과 로그

명세의 각 기능 행은 기존 기능 ID → PMT Item → 인수 시험으로 연결된다. 인수 시험은 정상 결과, 금지된 접근·쓰기의 부재, 장애 뒤 실제 상태를 함께 검사한다. evidence에는 기능/시험 ID, 실행 환경·버전·commit, 입력 조건, 기대와 관찰, 종료 코드·판정·미실행 사유를 남긴다.

운영 로그는 사건 종류·추적 식별자·결과·안전한 오류 종류·소요시간·건수로 제한한다. 비밀번호·키·Bearer·쿠키·서명 cursor 원문, 메시지·메일·문서 본문, 손님 개인정보는 기록하지 않는다. 로그만으로 완료를 판정하지 않는다. 기존 j-messenger 로그 정책은 유지한다.

## 공식 기술 확인

확인일: 2026-10-08. 아래는 기술 동작 확인 자료이며 프로젝트 범위를 변경하는 근거가 아니다. 제품 버전 고정 후 해당 버전의 옵션과 실제 결과를 다시 확인한다.

| 공식 자료 | 명세에 적용한 내용 |
| --- | --- |
| [Keycloak standard token exchange](https://www.keycloak.org/securing-apps/token-exchange) | 요청 client의 confidential 인증과 standard exchange 설정을 확인하고, 대상 audience로 축소된 실제 토큰을 시험한다. FGAP 회원 관리 권한과 exchange 설정을 구분한다. |
| [Mailpit runtime options](https://mailpit.axllent.org/docs/configuration/runtime-options/) | SMTP·HTTP bind, `MP_SMTP_ALLOWED_RECIPIENTS`, 거부 수신자를 무시해 250을 반환하는 옵션을 사용하지 않는 조건을 명시한다. |
| [Mailpit webhook](https://mailpit.axllent.org/docs/integration/webhook/) | `MP_WEBHOOK_URL`·빈도 제한·실패 재시도 없음의 한계를 E8 관문에 둔다. |
| [Nginx 요청 제한](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html), [연결 제한](https://nginx.org/en/docs/http/ngx_http_limit_conn_module.html) | 프로젝트의 429 요구를 만족하도록 거절 status를 명시하고 실제 응답을 검사한다. |
| [Nginx WebSocket 중계](https://nginx.org/en/docs/http/websocket.html) | Upgrade·Connection 헤더와 연결 timeout을 중계 구성·재연결 시험에서 확인한다. |
| [WHATWG WebSocket 표준](https://websockets.spec.whatwg.org/#the-websocket-interface) | 브라우저 WebSocket 생성자의 URL·protocols 입력과 HTTP Authorization 전송을 구별해 T2 연결 인증 방식을 고정한다. |
| [PostgreSQL 권한](https://www.postgresql.org/docs/current/ddl-priv.html) | 기본 PUBLIC CONNECT 허용을 회수하고 서비스 전용 계정의 다른 DB 접속 거절을 시험한다. |
| [OWASP 비밀번호 저장](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) | 손님 argon2id 파라미터와 구현 패키지는 C3에서 공식 근거와 함께 고정한다. |

문서 검사는 `python scripts/verify-feature-specifications.py`로 수행한다. 기본은 이 저장소와 형제 서비스 저장소의 문서를 검사하며, 다른 배치에서는 `--workspace-root`로 제품군 루트를 지정한다.
