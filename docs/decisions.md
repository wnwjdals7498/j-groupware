# j-groupware 설계 결정

j-groupware 최소 구현에 필요한 설계 결정을 정리한다. 제품군 공통 기준은 `docs/architecture.md`, 인증 쪽 전제는 `j-auth/docs/decisions.md`를 따르고, 이 문서는 그 위에서 j-groupware가 정한 내용만 적는다. 각 결정은 PMT project `4b7567e1-d8a7-4a46-b556-a4973dcb4e32`에 같은 번호의 `결정 N` 레코드로 기록되어 있다.

결정일: 2026-10-06

## 1. 로그인과 세션

### 결정 1. 웹 로그인 흐름과 토큰 보관
- **결정:** BFF 구조로 한다. 브라우저 → j-groupware 서버 → j-auth 순서로 호출한다.
  - 서버는 access token 서명을 Keycloak 공개키로 검증한 뒤 세션을 PostgreSQL에 저장한다.
  - 브라우저에는 httpOnly·Secure·SameSite=Strict 세션 쿠키(세션 ID)만 준다. 토큰은 브라우저로 보내지 않는다.
- **이유:** 토큰이 브라우저에 없으므로 XSS로 탈취되지 않는다. 서버에서 세션을 강제로 끝낼 수 있다. j-messenger의 쿠키 방식과 같다.

### 결정 2. 토큰 만료와 갱신
- **결정:**
  - access token은 로그인 순간 신원과 권한을 확인하는 데만 쓴다.
  - 이후에는 j-groupware 자체 세션으로 로그인 상태를 유지한다. 기본값은 유휴 30분, 최대 8시간이고 설정으로 바꿀 수 있다. 세션이 만료되면 다시 로그인한다.
  - 세션에는 로그인 시점의 roles를 저장한다.
  - 관리자가 j-groupware에서 회원 권한을 바꾸면 그 회원의 세션을 모두 삭제한다. 회원은 다시 로그인하고 새 권한을 받는다.
  - 알려진 한계: Keycloak 콘솔에서 직접 바꾼 권한은 세션이 만료된 뒤에 반영된다.
- **이유:** j-auth를 바꾸지 않아도 되고, j-groupware에서 바꾼 권한은 바로 반영된다. 정식 갱신은 OIDC Authorization Code로 옮길 때 Keycloak 표준 refresh로 해결한다.

**2026-10-07 갱신 (임시안, PMT supersede)**
- 위 방식에는 문제가 있다. j-auth 회원 관리 API(G6)와 j-customer-auth-db 관리 API(G13)는 호출마다 사용자 access token을 직접 검사한다. 그런데 이 토큰은 Keycloak 기본 수명인 5분이 지나면 만료된다. j-auth가 결정 22에서 갱신 방식을 만들고 이 저장소에 반영을 요청했다(backlog `55de09fb…`). 사용자 지시에 따라 갱신 방식을 **임시안**으로 반영한다.
  - 로그인 응답의 access token과 refresh token은 서버 세션에만 저장한다. 브라우저로 보내거나 로그에 남기지 않는다.
  - 로그인 상태는 계속 j-groupware 자체 세션으로 유지한다. 유휴 30분, 최대 8시간은 j-auth의 Keycloak 세션 설정과 같다.
  - 하위 서비스로 access token을 전달하기 전에 만료가 30초 안으로 남았으면 `POST /auth/refresh`로 갱신한다. 갱신 응답의 roles로 세션의 roles도 바꾼다.
  - 갱신이 실패(`{ok:false}`)하면 세션을 끝내고 다시 로그인하게 한다. j-auth 장애(503)는 별도 오류로 보여 준다.
  - 권한을 바꿀 때 대상 회원의 세션을 삭제하는 규칙은 그대로다. 세션을 삭제하거나 로그아웃할 때는 `POST /auth/logout`으로 Keycloak 세션도 끝낸다.
- ~~최종안 (backlog `802d39b7-9097-47a2-9618-d31a4eb3552d`): 이벤트 기반 세션 무효화~~

**2026-10-07 확정 (사용자 결정): 위 임시안을 최소 구현의 최종 방식으로 한다.**
- "임시안"이라는 표시를 뗀다. j-groupware가 하위 서비스(j-auth 회원 관리 API, j-customer-auth-db, j-approval)를 호출할 때는 세션의 access token을 Bearer로 전달하고 필요하면 갱신한다.
- 이유: 임시안도 호출마다 j-auth를 거치지 않는다. 하위 서비스는 JWKS 캐시로 서명을 직접 검증한다. j-auth는 활성 세션 하나당 약 4.5분에 한 번 refresh만 받고, 대상은 사내 회원뿐이다(손님은 j-customer-auth-db가 인증). 따라서 이벤트 방식의 근거였던 "auth 서버 부하"는 최소 구현 규모에서 문제가 되지 않는다.
- 이벤트 기반 무효화와 사용자 토큰 없는 서비스 간 인증은 OIDC Authorization Code 전환 backlog로 옮긴다. backlog `802d39b7…`와 j-approval의 "Bearer→세션 기반 전환" backlog를 이 한 항목으로 합친다.
- 영향: j-auth 결정 14·19·22, j-customer-auth-db 결정 5, j-approval 결정 8은 바꾸지 않고 그대로 유지한다.

### 결정 3. 하위 회원 관리 구현 위치
- **결정:**
  - j-auth에 회원 관리 API(회원 추가·목록, 권한 부여·회수)를 추가한다.
  - Keycloak Admin 자격(service account)은 j-auth에만 둔다.
  - j-groupware는 관리자 세션의 access token을 붙여 이 API를 호출한다.
  - j-auth는 다음 세 가지를 검사한다: 호출자가 `member:manage`를 가졌는지, 같은 tenant인지, 부여할 수 있는 role인지.
  - 새 회원의 비밀번호는 관리자가 정한 초기 비밀번호를 **영구 비밀번호**로 설정한다. ROPC 로그인은 required action(첫 로그인 시 비밀번호 변경 등)이 걸린 계정의 로그인을 실패시키기 때문이다. 비밀번호 변경 기능은 이후 범위로 둔다.
- **이유:** Keycloak 관리 열쇠를 한 곳에만 두고, 다른 서비스도 같은 API를 재사용한다.

## 2. 권한

### 결정 4. 권한 → 메뉴·동작 매핑과 서버 검사
- **결정:**
  - `packages/permissions`에 "메뉴·API route → 필요한 role" 표를 하나 둔다.
  - 서버는 Fastify `preHandler`로 route마다 세션 roles를 검사한다.
  - 웹은 같은 표를 보고 메뉴를 숨긴다.
  - 기본 거부: 권한 선언이 없는 route가 있으면 테스트가 실패한다.
- **이유:** 화면과 서버가 같은 표를 써서 어긋나지 않는다. 권한 선언을 빠뜨린 route는 테스트에서 잡힌다.

### 결정 5. 기능 권한 이름 목록

| realm | 종류 | role | 의미 |
| --- | --- | --- | --- |
| 고객 | 신분 (j-auth 확정) | `tenant:admin`, `tenant:member` | 고객 관리자, 하위 회원 |
| 고객 | 기능 | `board:read` | 게시판 메뉴, 글 목록·조회 |
| 고객 | 기능 | `board:write` | 글 작성 |
| 고객 | 기능 | `member:manage` | 하위 회원 추가·목록, 권한 부여·회수 |
| 고객 | 기능 | `messenger:use` | 메신저 메뉴, 메신저 API·WSS 중계 (결정 16에서 추가, 결정 22에서 의미 갱신) |
| 고객 | 기능 | `guest:read` | 손님 메뉴, 손님 목록 조회 (결정 18에서 추가, client `j-customer-auth-db`) |
| 고객 | 기능 | `guest:write` | 손님 등록·수정·삭제, API 키 발급·회수 (결정 18에서 추가, client `j-customer-auth-db`) |
| 고객 | 기능 | `mail:read` | 메일 메뉴, 받은편지함 목록·본문 조회 (결정 19에서 추가, 결정 22에서 의미 갱신, client `j-mail`) |
| 고객 | 기능 | `approval:use` | 결재 메뉴, 상신·내 문서·결재함 (결정 21에서 추가, client `j-approval`) |
| 고객 | 기능 | `org:manage` | 조직도 편집 (결정 21에서 추가, client `j-groupware`) |
| 운영사 | 신분 (j-auth 확정) | `operator:admin` | 운영사 담당자 |
| 운영사 | 기능 | `customer:read` | 콘솔 고객 목록·계약 상태 조회 |
| 운영사 | 기능 | `customer:write` | 계약 상태 변경 |

- `tenant:admin`은 `member:manage`·`board:read`·`board:write`·`messenger:use`·`guest:read`·`guest:write`·`mail:read`를 포함하는 묶음 role이다(j-auth 결정 21, `mail:read`는 j-mail 요청). `operator:admin`은 `customer:read`·`customer:write`를 포함한다.
- 고객 관리자가 하위 회원에게 줄 수 있는 role은 `board:read`, `board:write`, `messenger:use`, `guest:read`, `guest:write`, `mail:read`뿐이다. 화면에서 쓰기(`board:write`, `guest:write`)를 체크하면 읽기도 같이 체크된다.
- 2026-10-07 갱신: 결정 16에 따라 `messenger:use`를 추가했다. PMT에서는 이전 결정을 supersede했다.
- 2026-10-07 갱신: 결정 18(j-customer-auth-db R4)에 따라 `guest:read`와 `guest:write`를 추가했다. PMT에서는 이전 결정을 다시 supersede했다.
- 2026-10-07 갱신: 결정 19(j-mail 요청)에 따라 `mail:read`를 추가했다. PMT에서는 이전 결정을 다시 supersede했다.
- 2026-10-07 갱신(결정 20·21): 서비스 가입 모델에 따라 위 두 문단의 고정 목록을 아래 규칙으로 바꾼다. 식을 문서마다 다시 적지 않고 j-auth contracts의 서비스 카탈로그 상수 하나를 기준으로 한다(j-auth 결정 25).
  - 기본 서비스 j-groupware의 role(`board:read`, `board:write`, `member:manage`, `org:manage`)은 모든 고객 realm에 항상 있다.
  - 선택 서비스의 role(`messenger:use`, `mail:read`, `guest:read`·`guest:write`, `approval:use`)은 그 서비스에 가입한 고객 realm에만 있다.
  - `tenant:admin` = 기본 서비스 role + 가입한 서비스 role 전체.
  - 부여 가능 role = 기본 서비스의 `board:read`·`board:write`·`org:manage` + 가입한 서비스 role. 회원 관리 화면은 j-auth `GET /auth/members/grantable-roles`로 목록을 받아 그린다. `member:manage`와 신분 role은 부여할 수 없다.
  - sample-a 기준(전 서비스 가입) 목록은 위 표와 같다.
- **이유:** 최소 범위의 완료 기준에 필요한 권한만 둔다. 읽기만 가능한 회원도 표현할 수 있다.

## 3. 데이터

### 결정 6-1. tenant 구분 컬럼
- **결정:**
  - 모든 업무 테이블에 `tenant_id` 컬럼을 둔다.
  - 데이터 접근 함수는 tenant를 필수 인자로 받는다. 모든 쿼리에는 세션의 tenant가 조건으로 들어간다.
  - 서버 설정에 허용 tenant 목록(기본 1개)을 두고, 목록에 없는 tenant의 로그인은 거절한다.
  - 다른 tenant의 데이터가 보이지 않는지 통합 테스트로 검증한다.
- **이유:** 나중에 작은 고객 여럿을 VM 하나와 DB 하나에 모을 수 있게 대비한다.

### 결정 6-2. 마이그레이션 도구와 DB 접근
- **결정:**
  - PostgreSQL 드라이버는 `pg`를 쓴다.
  - 마이그레이션은 node-pg-migrate의 SQL 파일 방식으로 관리한다.
  - 쿼리는 SQL로 직접 쓰고, 결과 타입도 직접 정의한다.
  - 버전은 정확히 고정한다.
- 2026-10-07 갱신(결정 20): j-groupware 업무 DB 이름은 `jgw_groupware`, 전용 계정으로 접속한다. 같은 인스턴스의 다른 서비스 database는 참조하지 않는다. 이 방식(드라이버·마이그레이션·SQL 직접 작성)은 제품군 모든 서비스의 공통 기준이 되었다(architecture.md 3장).
- **이유:** j-messenger와 같은 "SQL 직접 작성" 방식이고 의존성이 적다.

### 결정 7. 운영사 콘솔 위치와 고객·계약 데이터
- **결정:**
  - 같은 저장소 안에서 앱을 나눈다.
    - 고객 VM용: `apps/server`, `apps/web`
    - control plane용: `apps/console-server`, `apps/console-web`
  - 두 쪽이 함께 쓰는 코드는 `packages/*`(ui, permissions)에 둔다.
  - 고객·계약 데이터는 control plane 전용 PostgreSQL DB에 저장한다. 로컬에서는 PostgreSQL 인스턴스 하나에 DB 2개를 둔다.
  - 콘솔 고객의 tenant ID는 j-auth tenant ↔ realm 매핑 표의 값과 같다. 두 표를 자동으로 맞추는 일(고객 등록 시 realm 생성)은 후반 프로비저닝 작업(backlog)으로 둔다.
- **이유:** 배포 단위가 확실히 나뉘어 고객 VM에 콘솔 코드가 들어가지 않는다. UI와 권한 표는 공유한다.

## 4. 저장소와 연동

### 결정 8. j-auth contracts 가져오는 방식
- **결정:**
  - j-auth에서 `npm pack`으로 contracts `.tgz` 파일을 만들어 `vendor/`에 커밋한다.
  - `file:vendor/j-auth-contracts-<version>.tgz`로 참조한다.
  - 계약이 바뀌면 j-auth에서 버전을 올린 뒤 다시 pack해서 복사한다.
- **이유:**
  - 버전이 고정된다.
  - j-messenger 방식의 VM 배포 묶음에 그대로 들어간다.
  - j-auth 저장소를 형제 폴더로 받아 둘 필요가 없다.
  - npm git 의존성은 저장소 하위 폴더의 패키지를 직접 설치하지 못한다.

### 결정 9. `docs/ui-guidelines.md` 작성 범위와 시점
- **결정:**
  - 토큰(색·간격·타이포)과 레이아웃(사이드바+본문)을 먼저 쓰고 화면을 구현한다.
  - 컴포넌트 절(표, 폼, 버튼, 모달, 빈 상태, 오류)은 구현하면서 채운다. 다음 UI 서비스(j-customer-auth-db)를 시작하기 전에 완성한다.
  - 범위는 문서와 `packages/ui`(CSS 변수 + React 컴포넌트)까지다. 다른 저장소로 코드를 배포하는 방법은 다음 UI 서비스 때 정한다.
- **2026-10-07 갱신 (결정 22):** 모든 화면을 j-groupware가 표시하므로 다른 저장소로 UI 코드를 배포할 일이 없다. `packages/ui`는 j-groupware 안에서만 쓴다.
  - 컴포넌트 절 완성 시점은 "j-customer-auth-db 시작 전"에서 G9(W1 완료 전)로 바꾼다.
  - j-groupware 안에 넣는 j-messenger 화면(`@j-messenger/client-react`)은 `packages/ui`의 CSS 변수(토큰)를 따르게 맞춘다. 맞추는 작업은 j-messenger M2에서 한다.
- **이유:** 구현 전에 기준이 있고, 완성된 문서는 실제 구현과 맞는다.

### 결정 10. 저장소 구조와 j-messenger 재사용
- **결정:** j-messenger에서 다음 항목을 복사한 뒤 필요 없는 부분을 줄인다. 도구 버전은 j-messenger와 같게 고정한다.
  - npm workspaces 구성
  - `tsconfig.base.json`, eslint, prettier, Vitest 설정
  - `scripts/`(build·check·경계 검사)
  - `deploy/`(Nginx·systemd·VM 배포 묶음·인증서 스크립트)

  폴더 구성은 다음과 같다.

  ```
  apps/server          고객 VM 서버(BFF, 게시판, 회원 관리 중계)
  apps/web             고객 웹
  apps/console-server  운영사 콘솔 서버
  apps/console-web     운영사 콘솔 웹
  packages/contracts   j-groupware 자체 API 계약
  packages/permissions 권한 표(결정 4)
  packages/ui          UI 기준 구현(결정 9)
  vendor/              j-auth contracts .tgz(결정 8)
  deploy/  docs/  scripts/
  ```
- **이유:** 검증된 구조와 배포 스크립트를 그대로 옮겨 서비스 간 지식을 재사용한다(architecture.md 3장).

### 결정 11. j-auth가 없을 때 개발 방법
- **결정:**
  - j-groupware 구현은 j-auth I1~I4(Keycloak 환경, realm, 로그인 API, 통합 테스트)가 끝난 뒤 시작한다.
  - 회원 관리 Item(G6)은 j-auth 회원 관리 API가 끝난 뒤 시작한다.
  - 가짜 j-auth 서버는 만들지 않는다.
- **이유:** 사용자가 j-auth 완성 후 진행을 선택했다. 가짜 서버를 구현하는 일과 가짜가 실제와 어긋날 위험이 없어진다.

## 5. 검증과 배포

### 결정 12. 배포 원칙
- **결정:**
  - j-auth 결정 12와 같은 원칙을 따른다.
    - 로컬에서 먼저 완료한 뒤 Hyper-V VM에서 다시 검증한다.
    - HTTPS는 로컬 인증서로 쓴다.
    - 포트는 비표준 기본값을 쓰고 설정으로 바꿀 수 있게 한다.
  - VM은 2대로 나눈다.
    - control plane VM: j-auth, 운영사 콘솔
    - 고객 VM: Nginx gateway, j-groupware 웹, DB
  - 앱은 systemd로 실행한다. PostgreSQL은 버전을 고정한 Docker Compose로 띄운다.
- **이유:** architecture.md 2장의 배치(control plane / tenant plane)를 그대로 검증하고, VM 사이의 HTTPS와 토큰 검증까지 확인한다.

### 결정 13. 테스트 방식
- **결정:**
  - Vitest로 실제 j-auth·Keycloak·PostgreSQL에 API 시나리오를 실행한다.
    1. 고객 관리자가 하위 회원에게 board 권한을 준다 → 대상 세션 삭제 → 재로그인 → `/api/me` 메뉴에 게시판 포함 → 글 작성 성공
    2. 권한 없는 회원: 메뉴 없음, API를 직접 호출하면 403
    3. 다른 tenant 데이터가 보이지 않음
    4. 운영사 계정은 콘솔 고객 목록 조회 가능, 고객 계정은 콘솔 접근 거부
  - Playwright로 화면 시나리오 1개를 실행한다: 권한을 받은 회원에게만 게시판 메뉴가 보이고 글을 쓸 수 있다.
- **이유:** 서버의 권한 검사와 화면 노출을 모두 증명한다. j-messenger와 같은 도구를 쓴다.

## 6. j-messenger 연결

결정일: 2026-10-07. architecture.md 4장 j-messenger 범위(j-auth 로그인 연결, j-groupware 메뉴에서 진입, 고객 VM gateway 뒤에서 동작)를 구현하기 위한 결정이다. j-messenger의 현재 구조를 전제로 한다: 로그인은 `POST /api/v1/session {serverId, username, password}`이고, 세션은 `jm_session` 쿠키다. tenant 개념은 `serverId`이고, 웹과 API는 출처 루트(`/`, `/api/v1`)에서 동작한다고 가정한다. 2026-10-07 결정 22 이후 메신저 화면은 j-groupware 안에서 표시하고, j-messenger는 Bearer를 검증하는 내부 API로 동작한다(결정 15·17 재작성).

### 결정 14. 연결 작업 관리 위치
- **결정:**
  - j-messenger repository·project 스코프(project `52713d6c-fa28-4699-a9f7-f4723f4149bf`)를 만든다.
  - j-messenger 코드 변경 Item은 j-messenger 스코프에 둔다. j-groupware 스코프에는 메뉴 진입과 gateway Item만 둔다.
  - 두 스코프의 Item은 `blocked_by`로 서로 연결한다.
  - j-messenger AGENTS.md의 PMT 안내(`proj-mgmt-tool-v2`)는 j-messenger 세션에서 고친다.
- **이유:** 각 Item이 자기 저장소만 수정한다. architecture.md 6장의 운영 방식과 같다.

### 결정 15. j-messenger 인증의 j-auth 연결
2026-10-07 결정 22(화면 일원화)에 따라 다시 썼다. 이전 내용은 "j-messenger가 자체 로그인 화면에서 j-auth `POST /auth/login`을 호출하고 `jm_session`을 발급, 그룹웨어에서 넘어갈 때 다시 로그인"이었다. PMT에서는 supersede한다.
- **결정:**
  - j-messenger에 `AUTH_MODE=j-auth`를 추가한다. 이 모드에서 j-messenger는 로그인 화면과 로그인 API를 쓰지 않는다.
  - 모든 HTTP 요청과 WSS handshake는 j-groupware 서버를 거쳐 들어오고, `Authorization: Bearer <j-auth access token>`이 붙어 있다(결정 2, 22).
  - j-messenger 서버는 j-auth 결정 19 기준(RS256, iss, `azp=j-auth`, aud에 `j-messenger`, `tenant` claim, 허용 tenant)으로 토큰을 검증하고 `messenger:use`를 검사한다(결정 16).
  - WSS 연결은 handshake 때 한 번 검증한다. 연결이 열려 있는 동안 토큰이 만료되어도 끊지 않는다. 다시 연결할 때 j-groupware가 갱신된 토큰을 붙인다. 알려진 한계: 권한을 회수해도 이미 열린 연결은 다시 연결할 때까지 유지된다(j-groupware는 대상 세션을 삭제할 때 그 세션의 WSS 중계도 끊는다).
  - j-auth contracts는 결정 8과 같은 vendor `.tgz` 방식으로 가져온다.
  - `development-fixed` 모드는 테스트용으로 남긴다. mail 모드는 코드를 바꾸지 않고 그대로 두며, 실제 MTA 기반 연결은 backlog다(j-mail 결정 4).
  - 그룹웨어 안에서 메신저를 쓰므로 다시 로그인하지 않는다.
- **이유:** j-customer-auth-db·j-approval과 같은 "Bearer 검증 백엔드" 규칙 하나로 맞춘다. 로그인 화면과 세션 쿠키가 j-groupware 한 곳에만 있다.

### 결정 16. tenant 매핑과 메신저 사용 권한
- **결정:**
  - j-auth의 tenant ID를 j-messenger `serverId`로 그대로 쓴다. 설정의 허용 tenant 목록에 있는 tenant만 받는다.
  - 고객 realm에 기능 권한 `messenger:use`를 추가한다(결정 5 갱신).
  - `messenger:use`가 없으면 j-messenger가 요청과 WSS 연결을 403으로 거절한다. j-groupware 메뉴와 중계 route도 이 권한이 있을 때만 열린다.
  - 사용자는 기존처럼 `(serverId, username)`으로 식별한다.
  - 알려진 한계: 상대가 메신저에 한 번 이상 로그인해야 대화 상대 목록에 나타난다. 회원 목록 연동은 이후 범위로 둔다.
- **이유:** 그룹웨어의 권한 모델과 같고, 메뉴 노출과 서버 검사가 일치한다(결정 4).

### 결정 17. 진입 경로와 gateway 배치
2026-10-07 결정 22(화면 일원화)에 따라 다시 썼다. 이전 내용은 "서비스마다 서브도메인(`messenger.`·`mail.`)과 server 블록 조각, 그룹웨어 메뉴에서 새 탭"이었다. PMT에서는 supersede한다.
- **결정:**
  - 외부에 여는 이름은 `gw.<tenant>.jgw.test` 하나다. 로컬 인증서 SAN과 hosts 파일에 허용 tenant마다 이 이름을 등록한다.
  - 다른 서비스(j-messenger, j-mail, j-customer-auth-db, j-approval)는 고객 VM 내부 포트(loopback)로만 열고 gateway에 노출하지 않는다. j-groupware 서버가 중계한다.
  - gateway 설정은 j-groupware `deploy/gateway`가 관리한다.
    - 원본 `deploy/gateway/gw.conf.template`을 설치 스크립트가 허용 tenant마다 envsubst로 렌더링해 `/etc/nginx/jgw.d/gw.<tenant>.conf`에 둔다. envsubst에는 치환할 변수 목록을 명시해서 `$host` 같은 Nginx 변수가 지워지지 않게 한다.
    - 기본 설정은 http 블록에서 `include /etc/nginx/jgw.d/*.conf;`를 하고, 공통 `map $http_upgrade $connection_upgrade`와 TLS 설정 조각을 둔다.
    - 메신저 WSS가 j-groupware를 거치므로 `gw.` server 블록이 WebSocket upgrade를 전달한다.
  - 서비스 저장소는 gateway 조각을 두지 않는다.
  - **예외: 사용자 세션 없이 외부에서 부르는 경로.** j-groupware 회원 세션 없이 외부 시스템이나 손님이 직접 호출하는 경로는 `gw.` server 블록의 고정 경로로 그 서비스에 바로 넘긴다. j-groupware를 거치지 않고, 인증은 그 서비스가 한다. 현재 예외는 두 개다.
    - j-customer-auth-db 확장 공개 API(API 키 인증): `/ext/customer-auth/` → j-customer-auth-db 내부 포트(j-customer-auth-db 결정 6·10)
    - j-talk 손님 위젯·손님 API·WSS: `/ext/talk/` → j-talk 내부 포트(결정 23)
    - 예외 경로는 `deploy/gateway/gw.conf.template`에 명시적으로 나열한다. 새 예외를 추가하려면 결정을 따로 남긴다.
- **이유:** 화면과 세션이 j-groupware 한 곳에 있으므로(결정 22) 외부 진입점도 하나면 된다. 쿠키·Origin·인증서 관리가 한 이름으로 줄고, 서비스 포트가 밖에 열리지 않는다.

## 7. 작업 구성

결정 0(PMT 계층과 Item 구성)은 사용자가 제안 구성을 승인했다. PMT 계층은 environment `j-groupware-suite` → repository `j-groupware`(`5388b37e-6a64-4c2d-80ab-a1ee6e21e60c`) → project `j-groupware`(`4b7567e1-d8a7-4a46-b556-a4973dcb4e32`)이다. Item 사이의 순서는 `blocked_by`로 건다.

2026-10-07 결정 18~22를 반영한 현재 구성이다. 그동안 붙여 온 보강 표는 이 표로 합쳤다. 원칙: 다른 서비스와 연결하는 Item은 서비스마다 별도 Work에 두어 W1 완료가 다른 저장소 일정에 묶이지 않게 한다(결정 18 방식). 그래서 메신저 메뉴(G12)는 W1에서 W5로 옮겼고, W1 완료 기준에서 "메신저 메뉴" 문구를 뺐다. PMT 반영(결정 0 supersede, G15~G18 생성, G12·G14 이동과 완료 기준 교체)은 대기 중이다.

**W1 "j-groupware 최소 구현"** — 완료 기준: architecture.md 4장(고객 관리자가 하위 회원에게 게시판 권한을 주면 그 회원만 게시판 메뉴가 보이고 글을 쓸 수 있다).

| 순서 | Item | 완료 기준 요약 | 선행 |
| --- | --- | --- | --- |
| G1 | 저장소 골격 | workspaces·도구 복사, PostgreSQL Compose(고객 VM 인스턴스의 `jgw_groupware`와 전용 계정, control plane의 콘솔 DB. 로컬은 인스턴스 1개), node-pg-migrate, 로컬 HTTPS, 포트 설정, 비밀값은 Git 제외 env에만 | j-auth I4 |
| G2 | UI 기준 최소판 | ui-guidelines.md 토큰·레이아웃, packages/ui 기초 | G1 |
| G3 | 로그인·세션 | contracts vendor, BFF 로그인, 토큰 서명 검증, 서버 세션(access·refresh token은 세션에만), 허용 tenant, CSRF, 수명, 전달 전 만료 30초 이내면 `/auth/refresh`·실패 시 재로그인, 세션 삭제 시 `/auth/logout`, 실패·장애 구분, `/api/me` | G1, G2 |
| G4 | 권한 표·서버 검사 | permissions 표(제품군 모든 기능 role 상수), preHandler 403, 기본 거부 테스트, 메뉴 숨김 | G3 |
| G5 | 게시판 | tenant_id 테이블, 목록·작성·조회 API와 화면, board 권한 검사 | G4 |
| G6 | 하위 회원 관리 | j-auth 관리 API로 목록·추가·권한 부여/회수, 부여 목록은 `GET /auth/members/grantable-roles`(가입 서비스 기준), 쓰기를 체크하면 읽기 포함, 변경 시 대상 세션 삭제와 `/auth/logout` | G4, j-auth I6(`7a8e560c-c83a-429e-bf60-b6a2675d93cc`) |
| G7 | 운영사 콘솔 | 앱 분리, control plane DB, `operator` 로그인, 고객 목록·계약 상태 | G4 |
| G8 | 완료 기준 테스트 | 결정 13 시나리오 통과 | G5, G6, G7 |
| G9 | UI 기준 완성 | 컴포넌트 절 문서화, packages/ui와 일치 | G5, G6, G7 |
| G10 | Hyper-V VM 검증 | VM 2대 구성, HTTPS, systemd·Compose, gateway `gw.` 중계, VM 대상 G8 통과 | G8, G9, G11, G18, j-auth I5 |
| G11 | gateway 구성 | `deploy/gateway` 기본 설정과 include, `gw.conf.template` 렌더링·`nginx -t` 스크립트, 인증서 SAN·hosts, WebSocket upgrade 전달 | G1 |

**W2 "손님 관리 연결"**(`10f223f1-ec52-4cb4-afa1-f856ec8b2373`) — 완료 기준: guest 권한을 받은 하위 회원에게만 손님 메뉴가 보이고 손님을 등록할 수 있다. `guest:write`를 가진 회원이 API 키를 발급·회수할 수 있다.

| 순서 | Item | 완료 기준 요약 | 선행 |
| --- | --- | --- | --- |
| G13 | 손님 관리 메뉴·API 키 화면 | j-customer-auth-db contracts vendor, Bearer 중계(손님 데이터는 저장하지 않음), 권한 표 손님 항목, 최상위 "손님" 메뉴(목록·등록·수정·삭제), "API 키" 탭(발급·원문 1회 표시·목록·회수), 403·장애 구분, Vitest 통합 + Playwright e2e | j-customer-auth-db C5, j-auth I2·I4·I6, G4, G6 |

G13 ID는 `07d0a8bc-c1fc-4672-9a27-f90aaed64b8c`다. j-customer-auth-db C8의 선행 조건에 들어 있다(j-customer-auth-db 결정 0).

**W3 "결재 연결"**(결정 21, PMT 등록 대기) — 완료 기준: `approval:use`를 가진 하위 회원이 j-groupware에서 조직도 기반 또는 커스텀 결재선으로 문서를 상신하고, 결재선 지정자가 순서대로 승인·반려하며, 작성자·결재자가 상태와 이력을 본다.

| 순서 | Item | 완료 기준 요약 | 선행 |
| --- | --- | --- | --- |
| G15 | 조직도 | `jgw_groupware`에 부서 트리·직책·소속(j-auth 회원 id), "조직도" 편집 화면(`org:manage`), G6 회원 추가 시 "미배치" 자동 등록, 기존 회원 추가, 기본 결재선 산출 규칙(소속 부서장 → 상위 부서장, 작성자 본인 제외), tenant 격리, Vitest | G4, G6 |
| G16 | 결재 화면 | j-approval contracts vendor, 최상위 "결재" 메뉴(`approval:use`), 상신(기본 결재선 미리보기·커스텀 편집, 후보는 조직도 등록 계정), 내 문서·결재함·상태/이력·승인/반려(사유 필수), Bearer 중계, 403·409·503 구분, Vitest 통합 + Playwright e2e | G15, j-approval A5·A6 |

**W4 "서비스 가입"**(결정 20, PMT 등록 대기) — 완료 기준: 콘솔에서 고객을 어떤 서비스에 가입시키면 그 고객 관리자에게 그 서비스 메뉴와 부여 항목이 생기고, 해지하면 사라진다. 고객 VM에는 그 서비스 database가 생기고, 다른 서비스 계정으로는 접속할 수 없다.

| 순서 | Item | 완료 기준 요약 | 선행 |
| --- | --- | --- | --- |
| G17 | 콘솔 가입 서비스 | 콘솔 DB에 고객별 가입 서비스, 가입·해지 화면(`customer:write`), j-auth 서비스 활성화·해제 API 호출, 실패 시 상태 표시·재시도, 실제 j-auth 대상 Vitest | G7, j-auth I7 |
| G18 | 고객 VM 서비스 설치 스크립트 | `deploy/provision-service`(서비스별 `jgw_<서비스>` database·전용 계정, `PUBLIC` CONNECT 회수, 접속 수·`statement_timeout`, 서비스 env의 `DATABASE_URL` 생성(Git 제외), systemd 기동), 해지 시 `pg_dump` 후 중지(DROP은 확인 후 수동), 다른 서비스 계정 접속 거부 테스트 | G1 |

**W5 "메신저 화면 연결"**(결정 22, PMT 등록 대기) — 완료 기준: `messenger:use`를 받은 회원에게만 메신저 메뉴가 보이고, j-groupware 안에서 같은 고객 소속 하위 회원끼리 대화를 주고받는다.

| 순서 | Item | 완료 기준 요약 | 선행 |
| --- | --- | --- | --- |
| G12 | 메신저 화면 | `@j-messenger/client-core`·`client-react` vendor, 사이드바 "메신저" 메뉴(`messenger:use`), 메신저 HTTP·WSS 중계(Bearer, 재연결 시 갱신 토큰, 세션 삭제 시 WSS 종료), 메뉴 노출·중계 Vitest, Playwright 대화 | G4, G11, j-messenger M2 |

**W6 "메일 화면 연결"**(결정 22, PMT 등록 대기) — 완료 기준: `mail:read`를 받은 회원에게만 메일 메뉴가 보이고, 고객 VM 안에서 보낸 메일을 j-groupware 화면에서 읽는다.

| 순서 | Item | 완료 기준 요약 | 선행 |
| --- | --- | --- | --- |
| G14 | 메일 화면 | j-mail contracts vendor, 최상위 "메일" 메뉴(`mail:read`), 받은편지함 목록·상세(HTML 본문 샌드박스), Bearer 중계, 403·503 구분, Vitest 통합 + Playwright e2e | G4, j-mail E3 |

G14 ID는 `8b693211-8218-4ccd-9b4f-8979fd22ef72`다(완료 기준 교체 대기).

backlog: 자동 프로비저닝(고객 등록 → realm 생성 → VM 생성 → 가입 서비스 설치), VM 사이즈 측정과 전용 인스턴스 분리 기준, j-groupware 앱(Android WebView 셸, j-messenger `apps/android` 패턴)·데스크톱·iOS, OIDC Authorization Code 전환(이벤트 기반 세션 무효화 포함).

**j-messenger project(`52713d6c…`) Work "j-messenger 연결"** — 완료 기준: j-groupware 메신저 메뉴에서 j-auth 계정으로 같은 고객 소속 하위 회원끼리 대화를 주고받는다. j-messenger AGENTS.md 제약을 지킨다: serverId 격리, 로그에 비밀값을 남기지 않음, 새 의존성은 공식 호환성 메모, 자동 push·배포 금지, 포트 3001 사용 금지. j-messenger의 `apps/web`·`apps/desktop`·`apps/android`는 동결한다(삭제하지 않고 제품 경로에서 뺀다).

| 순서 | Item | 완료 기준 요약 | 선행 |
| --- | --- | --- | --- |
| M5 | PostgreSQL 전환 | SQLite → `jgw_messenger`(전용 계정), `pg`·node-pg-migrate SQL 파일, 기존 서버 테스트 통과 | - |
| M1 | Bearer 인증 어댑터 | `AUTH_MODE=j-auth`, j-auth contracts vendor, HTTP·WSS handshake Bearer 검증(aud `j-messenger`), tenant=serverId, `messenger:use` 검사, 401·403 구분, 자체 로그인 화면·`jm_session` 미사용 | j-auth I4 |
| M2 | client 패키지 제공 | `client-core`·`client-react` `npm pack` 가능, API·WSS 기본 주소를 j-groupware 중계 경로로 설정 가능, j-groupware CSS 변수 적용 | M1 |
| M3 | 연결 통합 테스트 | 실제 j-auth 토큰으로 같은 tenant 2명 WSS 송수신, 권한 없는 회원 403, tenant 격리 | M1, M5 |
| M4 | 고객 VM 검증 | VM에서 `jgw_messenger`·내부 포트, j-groupware 메신저 메뉴 → 대화, VM 대상 M3 통과 | M3, G12, G10, G18 |

M1~M4는 PMT에서 이전 정의(자체 로그인, `messenger.` 서브도메인)를 supersede해야 한다. M5는 새로 만든다.

## 8. j-auth에 넘길 변경 요청

아래 항목은 j-groupware 결정에 따라 j-auth 쪽 작업이 필요하다. 다음 j-auth 세션에서 결정·Item으로 반영한다.

2026-10-07 반영: j-auth `docs/decisions.md` 7장 결정 14~20과 Item I6으로 반영했다. 2·5·7번(client 위치, aud)은 j-auth 결정 16·19에서 `j-messenger` client와 aud까지 포함해 정했다.

2026-10-07 추가 반영: 결정 20~22와 j-approval 요청 R1~R3에 따른 j-auth 변경은 j-auth 결정 24(결재 권한), 25(서비스 가입 연동)와 Item I7로 반영했다. 7번(j-messenger가 로그인 API를 호출)은 결정 22로 없어졌다. j-messenger와 j-mail은 j-groupware가 전달한 토큰만 받는다.

1. **회원 관리 API 추가 (결정 3)**
   - 회원 목록, 회원 추가(영구 초기 비밀번호), 기능 권한 부여·회수 API를 만든다.
   - 검사할 것: 호출자 토큰 검증, `member:manage` 보유, 같은 tenant, 부여 가능한 role 목록(`board:read`, `board:write`).
   - Keycloak service account는 필요한 최소 권한(예: realm-management `manage-users`)으로 만들고 j-auth env에만 둔다.
   - 요청·응답 형식은 contracts에 추가한다.
   - j-auth에 새 Item을 만들고, 그 ID를 j-groupware G6의 `blocked_by`에 추가한다.
2. **realm JSON(I2)에 권한 이름 반영 (결정 5)**
   - 고객 realm 기능 role: `board:read`, `board:write`, `member:manage`, `messenger:use`. `tenant:admin` 묶음 role이 이 넷을 포함한다.
   - 운영사 realm 기능 role: `customer:read`, `customer:write`. `operator:admin` 묶음 role이 이 둘을 포함한다.
   - 기능 role을 어느 client에 둘지(예: 서비스별 client `j-groupware`) 정한다.
3. **테스트용 계정과 realm 추가 (결정 6-1, 13)**
   - 샘플 고객 realm 계정: 고객 관리자 1명, board 권한이 없는 하위 회원 1명 이상
   - 메신저 테스트(결정 16, M3)용 계정: 같은 tenant에서 `messenger:use`를 가진 하위 회원 2명, 이 권한이 없는 하위 회원 1명
   - tenant 분리를 검증할 **두 번째 샘플 고객 realm**
4. **contracts 배포 형태 (결정 8)**
   - `packages/contracts`를 `npm pack`으로 묶을 수 있는 패키지로 만든다. 예: 이름 `@j-auth/contracts`, semver, `dist` 포함.
   - 계약이 바뀌면 버전을 올린다.
5. **토큰 검증 기준 확정 (결정 1)**
   - 다른 서비스가 토큰을 검증할 때 쓸 정보를 contracts나 문서에 정한다: issuer(realm별 URL), JWKS 주소, audience/azp 값.
   - 로그인 응답에 tenant 또는 realm 식별 정보를 넣을지도 함께 정한다.
6. **VM 2대 구성에서 Keycloak 노출 범위 (결정 12)**
   - 고객 VM이 control plane VM의 Keycloak realm 공개 엔드포인트(JWKS 등)와 j-auth API에 HTTPS로 접근할 수 있어야 한다.
   - 관리 콘솔은 j-auth 결정 12대로 로컬 전용으로 유지한다.
7. **j-messenger도 로그인 API를 호출함 (결정 15)**
   - j-groupware와 j-messenger 두 서버가 j-auth를 호출한다.
   - 토큰의 audience/azp 기준(5번)을 두 서비스 모두에 맞게 정한다.
   - 서비스별로 client를 둘지(2번)도 이 점을 고려해 정한다.

## 9. j-customer-auth-db 변경 요청 반영

결정일: 2026-10-07. j-customer-auth-db(project `70b997a8-e2ac-4102-8dbb-e76e3aec9467`)는 API와 contracts만 제공하고, 손님 관리 화면은 j-groupware 메뉴에 둔다(j-customer-auth-db 결정 3). 이 장은 그쪽 변경 요청 R4(j-groupware backlog `a508853c-48e9-4225-9f29-7c9568a63826`)를 반영한 결정이다. j-auth 쪽 선행 요청은 이미 반영되었다. R1은 j-auth I2·I4, R3는 j-auth I6에 반영되었다(j-auth 결정 21).

### 결정 18. 손님 관리 메뉴·API 키 화면과 guest 권한
- **결정:**
  1. **Item 구성 (18-1):**
     - Work W2 "손님 관리 연결"을 새로 두고, 그 아래에 G13(손님 메뉴 + API 키 화면)을 만든다.
     - 회원 관리 화면에서 guest 권한을 부여·회수하는 기능은 G6에 추가한다.
     - G8(W1 완료 기준 테스트)은 바꾸지 않는다. 손님 시나리오 테스트는 G13 안에 둔다.
  2. **메뉴 위치 (18-2):**
     - 사이드바 최상위에 "손님" 메뉴를 둔다.
     - 탭은 "손님 목록"(`guest:read`)과 "API 키"(`guest:write`를 가진 회원에게만 보임) 두 개다.
  3. **API 키 화면 범위 (18-3):** 요청 범위만 만든다.
     - 발급: 이름을 정하고 스코프(`guest:read`/`guest:write`)를 고른다. 원문은 한 번만 보여 주며, 복사 버튼과 "다시 볼 수 없음" 경고를 함께 둔다.
     - 목록: j-customer-auth-db contracts가 주는 필드만 보여 준다.
     - 회수: 확인 모달을 거친다.
     - 마지막 사용 시각과 만료일은 j-customer-auth-db backlog 후보로 남긴다.
  4. **세션 삭제 (18-4):** 결정 2를 guest 권한에도 그대로 적용한다. guest 권한을 부여할 때와 회수할 때 모두 대상 회원의 세션을 삭제한다.
  5. **공통:**
     - j-groupware 서버는 세션에 있는 j-auth access token을 Bearer로 붙여 j-customer-auth-db 관리 API를 호출한다(j-customer-auth-db 결정 5).
     - 손님 데이터는 j-groupware DB에 저장하지 않는다.
     - j-groupware 권한 표에도 손님 항목을 넣어 j-groupware와 j-customer-auth-db가 각각 권한을 검사한다(결정 4).
     - 손님 비밀번호는 등록하는 회원이 정한 값을 영구 비밀번호로 그대로 전달하고, 로그에 남기지 않는다(j-customer-auth-db 결정 7).
     - j-customer-auth-db contracts `.tgz`는 C2가 끝난 뒤 결정 8 방식으로 `vendor/`에 받는다.
     - 회원 관리 화면에서 `guest:write`를 체크하면 `guest:read`도 같이 체크된다. 게시판 권한과 같은 규칙이다.
- **이유:**
  - 손님 데이터는 j-customer-auth-db가 소유하고, j-groupware는 화면과 중계만 맡는다.
  - Work를 나눠서 j-groupware 최소 구현(W1)의 완료가 j-customer-auth-db 일정에 묶이지 않게 한다.
  - 손님 조회는 하위 회원이 매일 하는 업무이므로 최상위 메뉴에 둔다.
  - 권한을 회수하면 바로 반영되게 한다.
- **선행 조건:** G13은 다음 Item이 모두 끝난 뒤 시작한다. 결정 11에 따라 가짜 서버는 만들지 않는다.
  - j-customer-auth-db C5 `4d17cd96-82cb-4bee-8fe6-4e4948044abc`
  - j-auth I2 `4137096c…`, I4 `595ad08a…`, I6 `7a8e560c…`
  - G4, G6
- **주의:** 세션에 저장된 access token은 Keycloak 수명(기본 5분)이 지나면 만료된다. Bearer로 전달하려면 먼저 결정 2를 갱신해야 한다. 이 갱신은 backlog `55de09fb-b54e-4c99-be79-202167db17e5`(j-auth `POST /auth/refresh` 사용)에서 다룬다. G6의 j-auth 회원 관리 API 호출에도 같은 문제가 있다.
  - 2026-10-07 해소: 결정 2(갱신 방식, 최소 구현 최종안으로 확정)로 반영했다. G13은 G3의 갱신 로직을 쓴다.
- **반영 상태:** R4 backlog의 status는 "반영됨(결정 18, Item: G13 `07d0a8bc-c1fc-4672-9a27-f90aaed64b8c`)"이다.

## 10. j-mail 변경 요청 반영

결정일: 2026-10-07. j-mail(project `8144d327-0a0f-4c2e-94c2-687028657332`)은 고객 VM의 테스트 전용 메일 서버(Mailpit)다. 이 장은 j-mail `docs/decisions.md` 5장의 4번 요청(PMT 요청 Item E6 `e76c1ce3-1acb-47c2-9a17-9a99d68f438e`)을 반영한 결정이다. 근거는 j-mail 결정 2·4·5·6이다. 이전 요청인 j-customer-auth-db 요청(결정 18)이 반영되어 있는 것을 확인했고, 같은 결정 5를 이어서 갱신했다.

### 결정 19. 메일 메뉴와 `mail:read`
2026-10-07 결정 22(화면 일원화)에 따라 2~4번을 다시 썼다. 이전 내용은 "새 탭으로 `MAIL_URL`(Mailpit 웹 UI) 열기, `mail.` 서브도메인 조각, gateway `auth_request`"였다. PMT에서는 supersede한다.
- **결정:**
  1. **권한:**
     - 고객 realm 기능 role `mail:read`를 결정 5에 추가한다. 이 role은 role 전용 client `j-mail`에 있다.
     - `mail:read`는 j-mail에 가입한 고객의 `tenant:admin` 묶음과 부여 가능 role 목록에 들어간다(결정 5, 20).
     - 회원 관리 화면(G6)에서 `mail:read`를 부여·회수한다.
  2. **메일 화면 (G14):**
     - 사이드바 최상위 "메일" 메뉴. `mail:read`가 있을 때만 보인다.
     - 받은편지함 목록(수신자·발신자·제목·시각)과 메일 상세(헤더, 텍스트·HTML 본문)를 보여 준다. HTML 본문은 샌드박스 처리해 스크립트를 실행하지 않는다.
     - j-groupware 서버가 세션의 access token을 Bearer로 붙여 j-mail API를 호출한다(결정 2). 메일 데이터는 j-groupware DB에 저장하지 않는다.
     - 권한·장애 오류(403, 503)를 구분해 보여 준다. 메뉴 노출과 조회 테스트는 G14에 둔다. G8은 바꾸지 않는다.
  3. **gateway:** j-mail은 내부 포트로만 열고 gateway에 노출하지 않는다(결정 17). `auth_request`, `mail.` 서브도메인, Mailpit 웹 UI 노출은 쓰지 않는다.
  4. **architecture.md:** §4 j-messenger 연결점 문구를 "mail 모드 연결은 backlog"로 고쳤다. §4 j-mail 범위는 결정 22에 맞춰 다시 고쳤다.
- **이유:** 손님·결재 메뉴와 같은 "j-groupware 화면 + Bearer 중계" 방식이라 규칙이 하나다.
- **PMT:**
  - 결정 19 레코드: `159bd393-61e6-4ef8-8e4a-852d0f9d746d` (결정 22 반영본으로 supersede 필요)
  - 함께 갱신(supersede)한 결정: 결정 5, 15, 17, 0
  - 새 Item: G14 `8b693211-8218-4ccd-9b4f-8979fd22ef72` (완료 기준을 메일 화면으로 교체, 7장 표)
- **j-mail 쪽 순서:** E3(메일 API) → G14. E7(VM 검증) → G10. j-mail E4(gateway 조각)는 결정 22로 없어졌다.

## 11. 제품군 구조 재정리

결정일: 2026-10-07. 5개 저장소(j-groupware, j-auth, j-customer-auth-db, j-mail, j-approval) 문서 사이의 충돌과 남은 backlog를 한 번에 정리하면서 사용자가 내린 결정이다. 제품군 공통 규칙은 architecture.md 3장("하위 서비스 호출", "서비스 가입 모델")에도 적었다.

### 결정 20. 서비스 가입 모델과 서비스별 DB
- **결정 (사용자):**
  - 서비스 하나는 API 서버 + 전용 PostgreSQL database 한 쌍이다. j-messenger까지 모든 서비스에 적용한다(j-messenger는 M5에서 SQLite를 PostgreSQL로 옮긴다).
  - DB 단위는 A안이다. 고객 VM의 PostgreSQL 인스턴스 1개에 서비스마다 database `jgw_<서비스>`와 전용 계정을 둔다. 세부 규칙은 architecture.md 3장.
  - 가입하면 realm role까지 연동한다. j-auth가 그 고객 realm에 서비스 client·기능 role·aud mapper·scope mapping을 추가하고, `tenant:admin` 묶음과 부여 가능 role에 넣는다. 해지하면 제거한다(j-auth 결정 25).
- **j-groupware 쪽 세부 (권고안 위임):**
  - j-groupware는 기본 서비스라 항상 설치되고, 가입 대상이 아니다.
  - 가입 정보의 원본은 운영 콘솔 DB의 고객별 가입 서비스 목록이다. 콘솔이 가입·해지 때 j-auth 서비스 활성화 API를 호출한다(G17). j-auth 호출이 실패하면 콘솔에 "반영 실패"로 남기고 다시 시도할 수 있게 한다.
  - 고객 VM 쪽 설치(database·전용 계정 생성, 서비스 env, systemd 기동)는 `deploy/provision-service` 스크립트가 한다(G18). 최소 구현에서는 운영자가 수동으로 실행한다. 콘솔에서 VM까지 자동으로 이어지는 것은 프로비저닝 backlog다.
  - 해지 때는 서비스를 멈추고 `pg_dump`로 백업한다. database 삭제는 확인 후 수동으로 한다.
  - 메뉴·중계 API·회원 관리 부여 항목은 별도 설정 없이 roles와 j-auth의 부여 가능 목록으로 열리고 닫힌다. 미가입 서비스의 role은 realm에 없기 때문이다.
- **이유:** 서비스마다 데이터 소유가 분명하고, 가입·해지가 "role 추가 + database 생성"이라는 같은 절차로 끝난다. 공유 인스턴스는 소형 VM의 메모리·백업·패치 부담을 줄이고, `DATABASE_URL`만 바꾸면 나중에 전용 인스턴스로 옮길 수 있다.

### 결정 21. j-approval 연결 (j-approval 요청 R4~R6 반영)
- **결정:**
  - **Work:** W3 "결재 연결"을 새로 두고 G15(조직도), G16(결재 화면)을 둔다. W1 완료 기준은 바꾸지 않는다.
  - **권한:** `approval:use`(client `j-approval`)와 `org:manage`(client `j-groupware`)를 결정 5에 추가한다. 회원 관리 화면에서 둘 다 부여·회수한다.
  - **조직도 (G15):**
    - 부서 트리·직책·소속(j-auth 회원 id)을 `jgw_groupware`에 저장하고, `org:manage` 보유자가 편집한다.
    - G6에서 회원을 추가하면 조직도 "미배치"에 자동 등록한다. 그 전에 있던 회원이나 Keycloak 콘솔에서 만든 계정은 관리자가 조직도 화면에서 추가한다.
  - **결재선은 j-groupware가 만든다 (사용자 결정):**
    - j-groupware가 조직도로 기본 결재선을 산출한다. 규칙은 소속 부서장 → 상위 부서장이고 작성자 본인은 뺀다. 작성자는 화면에서 단계를 추가·삭제하거나 순서를 바꿀 수 있다.
    - 커스텀 결재선의 후보는 조직도에 등록된 같은 tenant 계정(미배치 포함)이다(사용자 결정).
    - 상신 요청에 결재선(단계별 회원 id)을 담아 j-approval에 보낸다. j-approval은 그 결재선을 스냅샷으로 저장하고 규칙을 검증한다.
    - 그래서 j-groupware는 조직도 조회 API를 외부에 열지 않고, j-approval이 j-groupware를 다시 호출하는 일도 없다. j-approval R4의 "조직도 조회 API(Bearer)"와 "계정 디렉터리 조회 API"는 만들지 않는다.
  - **호출 인증:** j-groupware 서버가 세션의 access token을 Bearer로 붙여 j-approval API를 호출한다(결정 2).
  - **architecture.md (R6):** §1·§4·§5의 j-approval 서술을 j-approval 결정 1·2·4에 맞게 고쳤다.
- **이유:**
  - 서비스 사이 호출이 한 방향(j-groupware → j-approval)이 된다.
  - j-approval 테스트가 j-groupware 서버를 띄우지 않아도 된다.
  - 다른 tenant의 회원 id를 결재선에 넣어도 그 회원은 tenant claim 때문에 문서를 처리할 수 없으므로 안전하다.
- **반영 상태:** j-approval backlog R4(`73d710c8…`)·R5(`7879c454…`)·R6(`d8bea411…`)은 "반영됨(결정 21, W3)"이다. PMT 레코드 갱신은 대기 중이다.

### 결정 22. 화면은 j-groupware에서만 표시
- **결정 (사용자):** 모든 서비스는 백엔드 API만 만든다. 웹과 앱 화면은 j-groupware가 표시한다. 유일한 예외는 손님용 j-talk 상담 위젯이다(결정 23).
- **세부 (사용자 선택):**
  - **메신저:**
    - j-messenger의 `@j-messenger/client-core`·`client-react`를 `.tgz`로 받아 j-groupware "메신저" 메뉴 안에서 렌더링한다(결정 8 방식).
    - j-messenger의 `apps/web`·`apps/desktop`·`apps/android`는 동결한다.
  - **메신저 실시간 연결:**
    - 브라우저는 `gw.<tenant>`에만 연결한다.
    - j-groupware 서버가 메신저 HTTP와 WSS를 j-messenger 내부 포트로 중계하면서 Bearer를 붙인다.
    - j-messenger는 자체 로그인과 `jm_session`을 쓰지 않는다(결정 15).
  - **메일:**
    - j-mail 서버가 Mailpit REST API를 감싸서 Bearer·`mail:read`·tenant를 검사하고, 받은편지함 목록·상세 API를 제공한다(j-mail 결정 2).
    - j-groupware "메일" 메뉴가 이 API로 화면을 그린다(결정 19).
    - Mailpit 웹 UI, `auth_request`, `mail.` 서브도메인, j-mail 로그인 화면은 쓰지 않는다.
  - **앱:** j-groupware 앱(Android WebView 셸 등)은 backlog다. 최소 구현은 웹만 만든다.
- **결과:**
  - 외부 진입점은 `gw.<tenant>.jgw.test` 하나다(결정 17).
  - 결정 9의 "다른 저장소로 UI 배포"는 필요 없어졌다.
  - j-customer-auth-db·j-approval·j-mail·j-messenger는 모두 "j-groupware가 전달한 Bearer 토큰을 검증하는 내부 API"라는 같은 형태가 된다.
- **이유:** 로그인·세션·화면 규칙·외부 노출이 한 곳에 모인다. 서비스는 API와 데이터에만 집중한다.
- **PMT:** 결정 20·21·22 레코드 생성, 결정 15·17·19·0 supersede, M1~M4 갱신과 M5 생성은 대기 중이다.

### 결정 23. 손님용 상담 위젯 (j-talk·j-web)
- **결정 (사용자):**
  - j-talk은 손님을 위한 화면을 j-groupware가 아니라 **삽입형 상담 위젯**으로 제공한다.
    - js·css 모듈로 만들어 배포한다.
    - 이 모듈을 넣은 웹페이지에는 오른쪽 아래에 항상 Floating Action Button이 보이고, 누르면 대화창이 열린다.
  - 고객은 이 모듈을 자기 웹사이트에 추가해 손님 화면에 상담창을 띄운다. j-groupware는 추가 방법(스니펫)을 안내한다.
  - j-web과 j-talk에 함께 가입한 고객은 j-web이 만든 페이지에서 이 위젯을 볼 수 있다.
  - 결정 22("화면은 j-groupware에서만")의 유일한 예외다. 대상이 사내 회원이 아니라 손님이고, 고객의 외부 웹사이트에서 동작해야 하기 때문이다. 하위 회원의 상담 화면(전체 문의방·배정·답장·종료)은 결정 22대로 j-groupware 메뉴다.
- **손님 식별 (사용자 선택):** 익명으로 시작하고, 로그인은 선택이다.
  - 방문자는 바로 문의할 수 있다. j-talk이 방문자 토큰을 발급하고 위젯이 브라우저에 보관한다.
  - 위젯 안에서 j-customer-auth-db 손님 로그인을 하면 그 손님 계정에 대화가 연결된다. j-talk은 손님 JWT를 서명 검증한다(j-customer-auth-db 결정 2).
- **배포 위치 (사용자 선택):** 고객 VM gateway의 예외 경로(결정 17의 두 번째 예외)를 쓴다. 손님 데이터는 고객 VM 밖으로 나가지 않는다.
  - 위젯: `https://gw.<tenant>.jgw.test/ext/talk/v1/widget.js`, `widget.css`. 경로에 메이저 버전을 넣고 내용 해시로 캐시를 관리한다.
  - 손님 대화 API·WSS: `/ext/talk/` 아래. 인증은 방문자 토큰 또는 손님 JWT로 j-talk이 한다.
- **세부 (권고안, j-talk·j-web 결정 때 확정):**
  - 삽입 방법:

    ```html
    <script src="https://gw.<tenant>.jgw.test/ext/talk/v1/widget.js" async></script>
    ```

    한 줄을 붙인다. css는 widget.js가 불러온다.
  - 위젯은 Shadow DOM 안에 그려 고객 사이트의 CSS와 서로 간섭하지 않게 한다.
  - 허용 출처: 고객이 위젯을 띄울 사이트 출처(Origin)를 j-groupware 상담 설정에서 등록한다. j-talk은 등록된 출처의 요청만 받는다(CORS·WSS Origin 검사). j-web 사이트 도메인은 자동 등록한다.
  - j-web 연동: 고객이 j-web과 j-talk에 둘 다 가입했으면 j-web 템플릿이 배포할 때 스니펫을 자동으로 넣는다. 다른 사이트는 j-groupware 상담 설정 화면의 "설치 안내"(스니펫 복사, 허용 출처 등록)를 따른다.
  - 위젯이 뜨는 조건은 세 가지다: 고객이 j-talk에 가입했음, 출처가 허용됨, j-talk이 동작 중임. 어느 하나라도 아니면 버튼을 그리지 않는다.
- **이유:** 손님은 j-groupware 계정이 없고 고객의 웹사이트에서 상담을 시작한다. 스크립트 한 줄 삽입은 어떤 사이트에도 붙일 수 있고, j-web과 함께 쓰면 설정 없이 바로 보인다.
- **반영:**
  - architecture.md §4 j-talk·j-web을 갱신했다.
  - 상세 설계와 Item은 j-talk·j-web 결정 세션에서 만든다(PMT 각 project에 backlog로 등록).
