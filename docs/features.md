# j-groupware 기능 목록

j-groupware가 제공해야 하는 기능 목록이다. 근거는 [`decisions.md`](decisions.md)의 결정 번호와 [`architecture.md`](architecture.md)의 S 번호이고, 담당 Item은 PMT 통합 project `j-groupware-suite`의 분류 `j-groupware`다. 현재 코드·실행 범위는 [구현 추적표](implementation-progress.json)와 [클라우드 BFF 검증 기록](cloud-bff-verification-2026-10-08.md)을 따른다. 목록 자체는 인수 완료를 뜻하지 않는다.

j-groupware는 기본 서비스로, 고객 서버의 웹 화면 전체와 하위 서비스 중계, control plane의 운영 콘솔, 고객 서버 운영 스크립트를 맡는다.

작성일: 2026-10-07

상세 동작·입출력·실패 처리·인수 시험은 [기능 명세](feature-specifications.md)를 따른다.

## 1. 로그인과 세션 (고객 웹)

| ID | 기능 | 핵심 동작 | 사용 주체 | 근거 | Item |
| --- | --- | --- | --- | --- | --- |
| GW-01 | OIDC 로그인 | `gw.<tenant>`에서 realm 결정, `/auth/login` → Keycloak Authorization Code + PKCE, `state`·`nonce` 검증 | 회원 | 결정 1, S4 | G3 |
| GW-02 | 로그인 콜백 | `/auth/callback`: code 교환(confidential `j-groupware`), ID·access token 검증, 세션 생성 | 회원 | 결정 1 | G3 |
| GW-03 | 서버 세션 | PostgreSQL 세션(roles, 토큰, `sid`), httpOnly·Secure·SameSite=Lax 쿠키, CSRF 토큰, 유휴 30분·최대 8시간 | 회원 | 결정 1 | G3 |
| GW-04 | 토큰 갱신 | 만료 30초 이내면 Keycloak 토큰 엔드포인트로 갱신, 세션 행 잠금으로 한 번만, 거절 시 재로그인 | 서버 내부 | 결정 1, j-auth 결정 10 | G3 |
| GW-05 | 로그아웃 | `/auth/logout`: 세션 삭제 + RP-initiated logout | 회원 | 결정 1 | G3 |
| GW-06 | 백채널 로그아웃 | `/auth/backchannel-logout`: logout token 검증, `sid` 세션 삭제, WSS 중계 종료 | Keycloak | 결정 1, S4 | G3 |
| GW-07 | 내 정보 | `/api/me`: 사용자, tenant, roles, 보이는 메뉴 | 회원 | 결정 3 | G3 |
| GW-08 | 토큰 축소 | 하위 서비스 호출 시 standard token exchange로 aud 1개 토큰 발급·캐시, 중계 코드는 토큰 함수 하나만 사용 | 서버 내부 | 결정 16, S4 | G23 |

## 2. 권한과 회원 관리

| ID | 기능 | 핵심 동작 | 사용 주체 | 근거 | Item |
| --- | --- | --- | --- | --- | --- |
| GW-10 | 권한 표 | `packages/permissions`: 메뉴·route → role, role 이름은 j-auth 카탈로그 상수 | 서버·웹 | 결정 3, S3 | G4 |
| GW-11 | 서버 권한 검사 | Fastify `preHandler`로 route마다 roles 검사, 403, 권한 선언 없는 route는 테스트 실패 | 서버 | 결정 3 | G4 |
| GW-12 | 메뉴 숨김 | 같은 권한 표로 웹 사이드바 메뉴 노출 결정 | 회원 | 결정 3 | G4 |
| GW-13 | 회원 목록·추가·삭제 | j-auth 회원 관리 API 호출(Bearer + 서비스 키), 영구 초기 비밀번호 | `member:manage` | 결정 2 | G6 |
| GW-14 | 권한 부여·회수 화면 | `grantable-roles`로 체크박스 구성, 쓰기 체크 시 읽기 체크·잠금 | `member:manage` | 결정 2, S3 | G6 |
| GW-15 | 권한 변경 후 세션 정리 | 대상 회원 세션·WSS 즉시 삭제(j-auth가 Keycloak 세션도 종료) | 서버 | 결정 1·2 | G6 |

## 3. 게시판과 조직도

| ID | 기능 | 핵심 동작 | 사용 주체 | 근거 | Item |
| --- | --- | --- | --- | --- | --- |
| GW-20 | 게시판 | 글 목록·작성·조회, tenant_id 격리 | `board:read`, 작성 `board:write` | 결정 7, S8 | G5 |
| GW-21 | 조직도 편집 | 부서 트리·직책·소속(j-auth 회원 id) 편집 | `org:manage` | 결정 12 | G15 |
| GW-22 | 미배치 자동 등록 | 회원 추가 시 조직도 "미배치"에 등록, 기존 회원 수동 추가 | 서버 | 결정 2·12 | G15 |
| GW-23 | 기본 결재선 산출 | 소속 부서장 → 상위 부서장, 작성자 제외 | 서버 | 결정 12 | G15 |

## 4. 서비스 화면과 중계

공통: 그 서비스 contracts 설치, 권한 표 항목, Bearer를 붙인 내부 포트 중계, 서비스 데이터 미저장, 401·403·404·409·503 구분 표시(결정 5장).

| ID | 기능 | 핵심 동작 | 사용 주체 | 근거 | Item |
| --- | --- | --- | --- | --- | --- |
| GW-30 | 메신저 화면 | `@j-messenger/client-react`를 "메신저" 메뉴 안에 렌더링, HTTP·WSS 중계(재연결 시 갱신 토큰, 세션 삭제 시 종료) | `messenger:use` | 결정 9 | G12 |
| GW-31 | 메일 화면 | 받은편지함 목록·상세, HTML 본문 샌드박스 iframe | `mail:read` | 결정 11 | G14 |
| GW-32 | 손님 관리 화면 | 손님 목록·등록·수정·삭제, 손님 비밀번호 전달(로그 없음) | `guest:read`, 쓰기 `guest:write` | 결정 10 | G13 |
| GW-33 | API 키 화면 | 발급(이름·스코프, 원문 1회·복사·경고), 목록, 회수(확인 모달) | `guest:write` | 결정 10 | G13 |
| GW-34 | 결재 화면 | 상신(기본 결재선 미리보기·편집, 후보는 조직도 계정), 내 문서, 결재함, 상태·이력, 승인·반려(사유 필수) | `approval:use` | 결정 12 | G16 |
| GW-35 | 상담 화면 | 전체 문의방(대기·진행·종료)·대화, 배정·재배정·답장·종료, 손님 이름 표시(`guest:read` 있을 때) | `talk:read`, 처리 `talk:write` | 결정 13 | G19 |
| GW-36 | 상담 설정 | 위젯 허용 출처 등록·삭제, 설치 안내(스니펫·서명 예제), 위젯 비밀키 발급·교체(원문 1회) | `talk:write` | 결정 13, S7 | G19 |
| GW-37 | 웹 관리 화면 | 사이트 목록·도메인 연결 상태·DNS 안내·계정 정보·용량, 사이트 생성·삭제, 페이지 편집·미리보기·배포, 비밀번호 재설정(원문 1회) | `web:read`, 처리 `web:write` | 결정 14 | G20 |
| GW-38 | 배포 후 허용 출처 등록 | 배포 성공 시 사용자 Bearer로 j-talk 허용 출처 API 호출, 권한·가입 없으면 안내 | `web:write`(+`talk:write`) | 결정 14 | G20 |

## 5. 알림

| ID | 기능 | 핵심 동작 | 사용 주체 | 근거 | Item |
| --- | --- | --- | --- | --- | --- |
| GW-40 | 알림 수신 API | loopback `POST /internal/notifications`, 서비스별 내부 키, 가입·종류 검사, `dedupKey` 중복 제거 | 하위 서비스 | 결정 15, S17 | G22 |
| GW-41 | 알림 종류 표 | 서비스별 종류 → 아이콘·이름·문구 틀·필요 role, 표에 없으면 400 | 서버·웹 | 결정 15 | G22 |
| GW-42 | 알림 저장·보관 | `notifications` + 회원별 읽음, 받는 사람(회원·username·role), 30일 보관 | 서버 | 결정 15 | G22 |
| GW-43 | 실시간 알림 | SSE `/api/notifications/stream`, 세션 종료 시 닫힘 | 회원 | 결정 15 | G22 |
| GW-44 | 알림 화면 | 상단 아이콘 읽지 않은 수, 목록(서비스·종류·내용·시각), 클릭 시 이동·읽음 | 회원 | 결정 15 | G22 |

## 6. 운영 콘솔 (control plane)

| ID | 기능 | 핵심 동작 | 사용 주체 | 근거 | Item |
| --- | --- | --- | --- | --- | --- |
| GW-50 | 콘솔 로그인 | 운영사 realm `j-console` Authorization Code + PKCE, BFF 세션 | 운영사 | 결정 4 | G7 |
| GW-51 | 고객 목록·계약 상태 | 조회(`customer:read`), 계약 상태 변경(`customer:write`) | 운영사 | 결정 4 | G7 |
| GW-52 | 고객 등록 | tenant ID·관리자 입력 → j-auth realm 생성 호출 → 에이전트 키 생성 → 부트스트랩 정보 1회 표시(원문 미저장) | `customer:write` | 결정 4, S2 | G17 |
| GW-53 | 가입 서비스 관리 | 가입·해지 기록 → j-auth 가입 API 호출, 실패 표시·재시도, 실제 상태 비교 | `customer:write` | 결정 4 | G17 |
| GW-54 | 원하는 상태 API | `GET /console/api/agent/desired-state`, `POST …/status`(에이전트 키), 설치 상태 표시 | 고객 서버 에이전트 | 결정 4 | G21 |

## 7. 고객 서버 운영

| ID | 기능 | 핵심 동작 | 사용 주체 | 근거 | Item |
| --- | --- | --- | --- | --- | --- |
| GW-60 | gateway 기본 설정 | `jgw.d`·`jweb.d` include, WebSocket map, TLS, `gw.conf.template` tenant별 렌더링, `nginx -t` | 운영자·스크립트 | 결정 8, S6 | G11 |
| GW-61 | 예외 경로 | `/ext/customer-auth/`, `/ext/talk/`(WSS) 가입 서비스만 렌더링, j-talk 미가입 시 빈 위젯 스크립트 | 외부·손님 | 결정 8, S6·S7 | G11 |
| GW-62 | 남용 방지 | `/ext/`에 IP별 `limit_req`·`limit_conn`, 429, env로 값 변경 | gateway | 결정 8, S6 | G11 |
| GW-63 | 부트스트랩 | 수동 생성 서버에서 1회: Nginx·PostgreSQL·j-groupware 설치, 부트스트랩 정보 env 기록, 로컬 CA 신뢰, 에이전트 등록 | 운영자 | 결정 8, S2 | G18 |
| GW-64 | 서비스 설치 | `provision-service <서비스>`: `jgw_<서비스>`·전용 계정·권한, env, 알림 내부 키, systemd, 예외 경로, j-web 추가 구성 | 에이전트 | 결정 8, S2 | G18 |
| GW-65 | 서비스 해지 | `--remove`: 중지 → `pg_dump` → `NOLOGIN` → 서비스 고유 정리 → 경로 제거 → `nginx -t`·reload(실패 시 복구) → env 삭제, `--purge` 별도 | 에이전트·운영자 | 결정 8, S14 | G18 |
| GW-66 | 프로비저닝 에이전트 | systemd timer 1분, 원하는 상태 조회 → 설치·해지 실행, 멱등·잠금, 상태 보고 | 고객 서버 | 결정 8 | G21 |

## 8. 공통 기반

| ID | 기능 | 핵심 동작 | 근거 | Item |
| --- | --- | --- | --- | --- |
| GW-70 | 저장소 골격 | workspaces, 도구, Compose PostgreSQL, node-pg-migrate, 로컬 HTTPS, `.npmrc` | 결정 6, S11 | G1 |
| GW-71 | UI 기준 | `ui-guidelines.md` 토큰·레이아웃·컴포넌트, `packages/ui` | 결정 5 | G2·G9 |
| GW-72 | 패키지 레지스트리 | 제품군 공유 패키지 게시·설치 수단(Verdaccio 원안, 6.10.5 고정) | S10 | X1 |
| GW-73 | VM 검증·측정 | VM 2대, `gw.` 중계, VM 대상 G8, 메모리·CPU 측정 | S13·S15 | G10 |

## 9. 범위 밖·backlog

- j-groupware 앱(Android WebView 셸)·데스크톱·iOS
- 메신저 대화 상대 조직도 연동, 메신저 알림 송신
- 범위 밖(사용자): 고객 서버 생성 자동화, 사양에 따른 자동화
