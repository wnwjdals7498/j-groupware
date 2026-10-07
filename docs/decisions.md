# j-groupware 설계 결정

j-groupware만의 설계 결정을 적는다. 제품군 공통 결정은 [`architecture.md`](architecture.md)의 S 번호를 따르고 여기서는 링크만 한다. PMT는 통합 project `j-groupware-suite`의 분류 `j-groupware`(j-messenger 연결 Item M은 분류 `j-messenger`)에 같은 번호로 기록한다(S16).

정리일: 2026-10-07. 통합 정리에서 결정 번호를 다시 매겼다. 이전 번호는 끝의 대응 표를 본다.

j-groupware는 기본 서비스다. 고객 서버에 항상 설치되고, 모든 서비스의 화면과 중계를 맡는다([S5](architecture.md#s5)). 운영 콘솔은 control plane에서 따로 동작한다.

## 1. 로그인과 회원

### 결정 1. 웹 로그인과 세션 (OIDC BFF)
- **결정 (사용자: 처음부터 OIDC):**
  - **로그인:**
    - j-groupware 서버가 BFF로 Keycloak Authorization Code + PKCE(S256) 흐름을 쓴다([S4](architecture.md#s4)).
    - 접속 이름 `gw.<tenant>`에서 realm `tenant-<tenant>`를 정하고, `/auth/login`이 `state`·`nonce`·PKCE 검증값을 서버에 둔 채 Keycloak으로 보낸다.
    - `/auth/callback`에서 code를 confidential client `j-groupware`(secret은 env)로 바꾸고, ID·access token을 검증한다.
  - **세션:**
    - PostgreSQL(`jgw_groupware`)에 roles, access·refresh token, Keycloak 세션 id(`sid`)를 둔다.
    - 브라우저에는 httpOnly·Secure·SameSite=Lax 세션 쿠키만 준다. Keycloak에서 돌아오는 redirect에 쿠키가 실려야 해서 Lax다. 상태를 바꾸는 요청에는 CSRF 토큰을 요구한다.
    - 토큰은 브라우저로 보내거나 로그에 남기지 않는다.
    - 세션 수명은 유휴 30분, 최대 8시간이다(j-auth 결정 10과 같은 값).
  - **갱신:**
    - 하위 서비스로 넘기기 전에 만료가 30초 안으로 남았으면 Keycloak 토큰 엔드포인트로 갱신하고, 새 refresh token과 roles로 세션을 바꾼다.
    - Revoke Refresh Token이 켜져 있으므로 같은 세션의 갱신은 세션 행 잠금(`SELECT … FOR UPDATE`)으로 한 번만 실행한다. 기다린 요청은 갱신된 토큰을 쓴다.
    - 갱신이 거절되면 세션을 끝내고 다시 로그인하게 한다. Keycloak 장애는 따로 보여 준다.
  - **로그아웃:**
    - `/auth/logout`은 세션을 지우고 Keycloak RP-initiated logout으로 보낸다.
    - `/auth/backchannel-logout`은 Keycloak이 보낸 logout token(서명·iss·aud·`sid`·events 검증)을 받아, 그 `sid`의 세션을 지우고 WSS 중계도 끊는다.
  - 회원 권한을 바꾸면 j-auth가 Keycloak 세션을 끝내고(백채널 로그아웃이 옴), j-groupware도 대상 세션을 바로 지운다(결정 2).
- **이유:** 비밀번호와 토큰이 브라우저·j-groupware 화면을 지나지 않고, 세션 무효화가 Keycloak 이벤트로 이어진다.

### 결정 2. 하위 회원 관리
- **결정:**
  - j-auth 회원 관리 API(j-auth 결정 11)로 목록·추가·삭제·권한 부여·회수를 한다. 관리자 세션의 Bearer와 tenant별 서비스 키(`JGW_SERVICE_KEY`, j-auth 결정 15)를 함께 보낸다.
  - 부여할 수 있는 항목은 `GET /auth/members/grantable-roles`로 받아 그린다. 가입한 서비스의 role만 나온다([S3](architecture.md#s3)).
  - 쓰기를 체크하면 읽기가 체크된 채 잠긴다. j-auth 복합 role과 같은 규칙이다.
  - 새 회원의 비밀번호는 관리자가 정한 초기값을 영구 비밀번호로 쓴다. 비밀번호 변경은 이후 범위다.
  - 회원을 추가하면 조직도 "미배치"에 자동 등록한다(결정 12).
  - 권한을 바꾸거나 회원을 삭제하면 j-auth가 그 회원의 Keycloak 세션을 끝낸다. j-groupware도 대상 회원의 세션과 WSS 중계를 바로 지운다.
- **이유:** Keycloak 관리 열쇠는 j-auth에만 두고, 서비스 키로 이 호출을 j-groupware에만 허용한다.

### 결정 3. 권한 표와 서버 검사
- **결정:**
  - `packages/permissions`에 "메뉴·API route → 필요한 role" 표를 하나 둔다. role 이름은 j-auth 서비스 카탈로그 상수에서 가져온다([S3](architecture.md#s3)).
  - 서버는 Fastify `preHandler`로 route마다 세션 roles를 검사한다. 웹은 같은 표로 메뉴를 숨긴다.
  - 기본 거부: 권한 선언이 없는 route가 있으면 테스트가 실패한다.
- **이유:** 화면과 서버가 같은 표를 써서 어긋나지 않는다.

## 2. 운영 콘솔

### 결정 4. 운영 콘솔, 고객 등록, 가입 서비스
- **결정:**
  - **앱 구성:** 같은 저장소에서 앱을 나눈다. 고객 서버용은 `apps/server`, `apps/web`이고, control plane용은 `apps/console-server`, `apps/console-web`이다. 공유 코드는 `packages/*`다.
  - **로그인:** 콘솔은 운영사 realm의 `j-console` client로 Authorization Code + PKCE 로그인한다(결정 1과 같은 BFF 방식).
  - **데이터:** 고객·계약·가입 서비스·고객 서버 상태는 control plane PostgreSQL의 콘솔 database에 둔다. 운영사 계정(`customer:read`/`customer:write`)이 보고 바꾼다.
  - **고객 등록 (G17):**
    1. 운영자가 tenant ID, 고객 관리자 username·초기 비밀번호를 입력한다.
    2. 콘솔이 j-auth realm 생성 API(j-auth 결정 20)를 콘솔 서비스 키와 함께 호출한다.
    3. 콘솔이 고객 서버 에이전트 키를 만든다. 해시만 저장한다.
    4. 다음을 "고객 서버 부트스트랩 정보"로 운영자에게 1회만 보여 준다: `j-groupware` client secret, tenant 서비스 키, 에이전트 키, 콘솔 주소. 콘솔은 원문을 저장하지 않는다.
    5. 고객 서버 생성과 부트스트랩 실행은 운영자가 수동으로 한다(S2).
  - **가입 서비스 (G17):**
    - 가입·해지를 기록하면 j-auth 가입 API(j-auth 결정 14)를 호출한다.
    - 실패하면 "반영 실패"로 표시하고 다시 시도할 수 있다.
    - 고객 서버 반영은 에이전트가 자동으로 한다(결정 8).
  - **원하는 상태 API (G21):**
    - 경로: `GET /console/api/agent/desired-state`, `POST /console/api/agent/status`
    - 에이전트 키(Bearer)로 인증한다. control plane Nginx가 이 두 경로만 연다.
    - 응답은 가입 서비스 목록이다. 에이전트가 보고한 설치 상태는 콘솔 화면에 보인다.
- **이유:** 고객 등록부터 서비스 설치까지 사람이 하는 일은 고객 서버 생성과 부트스트랩 한 번뿐이다(사용자 결정).

## 3. 화면과 저장소

### 결정 5. UI 기준
- **결정:**
  - `docs/ui-guidelines.md`에 토큰(색·간격·타이포)과 레이아웃(사이드바 + 본문)을 먼저 쓰고 화면을 구현한다. 컴포넌트 절(표, 폼, 버튼, 모달, 빈 상태, 오류)은 구현하면서 채우고 G9에서 완성한다.
  - `packages/ui`(CSS 변수 + React 컴포넌트)는 j-groupware 안에서만 쓴다([S5](architecture.md#s5)).
  - 안에 넣는 j-messenger 화면(`client-react`)은 `packages/ui`의 CSS 변수를 따르게 맞춘다(M2).
- **이유:** 구현 전에 기준이 있고, 완성된 문서가 실제 구현과 맞는다.

### 결정 6. 저장소 구조
- **결정:** [S11](architecture.md#s11) 골격에 다음 폴더를 둔다.

  ```
  apps/server          고객 서버(BFF, 게시판, 회원 관리, 서비스 화면 중계)
  apps/web             고객 웹(모든 서비스 화면)
  apps/console-server  운영 콘솔 서버
  apps/console-web     운영 콘솔 웹
  packages/contracts   j-groupware 자체 API 계약
  packages/permissions 권한 표(결정 3)
  packages/ui          UI 기준 구현(결정 5)
  deploy/gateway       Nginx 기본 설정·gw 템플릿(결정 8)
  deploy/provision-service  서비스 설치·해지 스크립트(결정 8)
  deploy/bootstrap     고객 서버 부트스트랩(결정 8)
  deploy/agent         프로비저닝 에이전트(결정 8)
  tools/registry       로컬 npm 레지스트리(S10, X1)
  docs/  scripts/
  ```

  다른 서비스 contracts와 j-messenger client 패키지는 로컬 레지스트리에서 정확한 버전으로 받는다([S10](architecture.md#s10)).
- **이유:** 검증된 j-messenger 구조와 배포 스크립트를 재사용한다.

### 결정 7. 테스트
- **결정:**
  - [S12](architecture.md#s12)대로 Vitest로 실제 j-auth·Keycloak·PostgreSQL에 API 시나리오를 실행한다. 권한이 필요한 회원은 테스트가 회원 관리 API로 만들고 지운다.
    1. 고객 관리자가 하위 회원에게 board 권한을 준다 → 대상 세션 삭제 → 재로그인 → `/api/me` 메뉴에 게시판 포함 → 글 작성 성공
    2. 권한 없는 회원: 메뉴 없음, API를 직접 호출하면 403
    3. 다른 tenant 데이터가 보이지 않음
    4. 운영사 계정은 콘솔 고객 목록 조회 가능, 고객 계정은 콘솔 접근 거부
  - Playwright 화면 시나리오: 권한을 받은 회원에게만 게시판 메뉴가 보이고 글을 쓸 수 있다.
  - 다른 서비스 화면 e2e는 W2~W8 각 Item에서 한다.
- **이유:** 서버의 권한 검사와 화면 노출을 모두 증명한다.

## 4. 고객 서버 구성

### 결정 8. gateway, 부트스트랩, 서비스 설치·해지, 프로비저닝 에이전트
- **결정:**
  - **gateway (G11):**
    - `deploy/gateway`가 Nginx 기본 설정과 `gw.conf.template`을 관리한다.
    - 설치 스크립트가 허용 tenant마다 envsubst로 렌더링해 `/etc/nginx/jgw.d/gw.<tenant>.conf`에 둔다. 치환 변수 목록을 명시해 `$host` 같은 Nginx 변수를 지키지 않게 한다.
    - 기본 설정은 다음을 둔다: `include /etc/nginx/jgw.d/*.conf;`, `include /etc/nginx/jweb.d/*.conf;`(j-web 사이트 블록, j-web 소유), 공통 `map $http_upgrade $connection_upgrade`, TLS 조각.
  - **예외 경로 ([S6](architecture.md#s6)):**
    - `/ext/customer-auth/` → j-customer-auth-db 내부 포트(`JCADB_INTERNAL_PORT`)
    - `/ext/talk/` → j-talk 내부 포트(`JTALK_INTERNAL_PORT`, WebSocket 포함)
    - 예외 경로는 가입한 서비스에 대해서만 렌더링한다.
    - j-talk 미가입이면 `/ext/talk/v1/widget.min.js`에 빈 스크립트(200, `application/javascript`)를 돌려준다([S7](architecture.md#s7)).
  - **남용 방지:**
    - `/ext/`에 IP별 `limit_req`(기본 10 r/s, burst 20)와 `limit_conn`(기본 20)을 건다. 초과하면 429다.
    - 값은 env로 바꿀 수 있다.
  - **설치 (G18, `deploy/provision-service <서비스>`):**
    - `jgw_<서비스>` database와 전용 계정을 만들고 권한을 막는다([S2](architecture.md#s2)).
    - 서비스 env(`DATABASE_URL` 등, Git 제외)를 만들고 systemd로 기동한다.
    - 예외 경로를 렌더링하고 `nginx -t` 후 reload한다.
    - 서비스마다 알림 내부 키(`X-JGW-Internal-Key`, 결정 15)를 만들어 서비스 env에 넣고, 해시를 j-groupware에 등록한다.
    - j-web 설치에는 다음을 더한다: 사이트용 sshd 인스턴스(별도 포트, chroot SFTP), FTPS, 특권 helper(j-web 결정 13), 사이트 디렉터리 루트, 방화벽 규칙.
  - **프로비저닝 에이전트 (G21, `deploy/agent`):**
    - 고객 서버의 systemd timer(1분)가 콘솔 원하는 상태 API를 호출한다.
    - 설치되지 않은 가입 서비스는 `provision-service <서비스>`, 가입이 끝난 서비스는 `--remove`를 실행한다. 결과는 콘솔에 보고한다.
    - 서비스 실행 묶음은 부트스트랩 때 `/opt/jgw/bundles/`에 함께 둔다. 업그레이드 배포는 범위 밖이다.
    - 같은 상태면 아무것도 하지 않는다(멱등). 한 번에 하나씩 실행한다(잠금 파일).
  - **부트스트랩 (G18, `deploy/bootstrap`):**
    - 운영자가 수동으로 만든 고객 서버에서 한 번 실행한다.
    - 하는 일: Nginx·PostgreSQL·j-groupware 설치, 부트스트랩 정보를 env에 기록, 로컬 CA 신뢰 설정, 에이전트 timer 등록.
  - **해지 (G18, `--remove`, [S14](architecture.md#s14)):**
    - 순서: unit 중지 → `pg_dump` → DB 계정 `NOLOGIN` → 서비스 고유 정리 → 예외 경로 제거 → `nginx -t`·reload(실패 시 직전 설정 복구) → env 삭제
    - 서비스 고유 정리는 다음과 같다.
      - j-web: 사이트 블록·SFTP/FTPS 계정 삭제, 사이트 디렉터리 백업 이동
      - j-mail: Mailpit 중지·볼륨 백업
    - 영구 삭제는 `--purge`로 따로 한다.
- **이유:** 가입·해지가 스크립트 하나의 정해진 순서로 끝나고, Nginx 설정이 항상 검사 후 반영된다.

## 5. 서비스 화면 연결

모든 서비스 화면은 같은 규칙이다([S4](architecture.md#s4), [S5](architecture.md#s5)): 그 서비스 contracts를 레지스트리에서 받고, 권한 표에 메뉴·route를 넣고, j-groupware 서버가 Bearer를 붙여 내부 포트로 중계하고, 서비스 데이터는 j-groupware DB에 저장하지 않는다. 오류는 401(재로그인)·403·404·409·503을 구분해 보여 준다.

### 결정 9. j-messenger 연결
- **결정:**
  - **j-messenger 쪽 (M Item):**
    - `AUTH_MODE=j-auth`에서 자체 로그인 화면·API와 `jm_session`을 쓰지 않는다.
    - 모든 HTTP와 WSS handshake에서 Bearer를 검증한다(aud `j-messenger`). `messenger:use`가 없으면 403이다.
    - tenant ID를 `serverId`로 쓰고 사용자는 `(serverId, username)`으로 식별한다.
    - `development-fixed` 모드는 테스트용으로 남긴다. mail 모드 연결은 backlog다(j-mail 결정 7).
    - 저장소를 SQLite에서 `jgw_messenger`로 옮긴다(M5, [S2](architecture.md#s2)).
    - `@j-messenger/client-core`·`client-react`를 레지스트리에 게시한다.
    - `apps/web`·`apps/desktop`·`apps/android`는 동결한다.
  - **j-groupware 쪽 (G12):**
    - "메신저" 메뉴(`messenger:use`) 안에서 `client-react`를 렌더링한다.
    - 메신저 HTTP·WSS를 j-groupware 서버가 중계한다. 다시 연결할 때는 갱신된 토큰을 붙인다.
  - 알려진 한계: 상대가 한 번 이상 메신저를 써야 대화 상대 목록에 나타난다. 조직도 연동은 이후 범위다.
- **이유:** 기존 WSS·outbox 구조를 그대로 두고 인증 진입점만 바꾼다.

### 결정 10. 손님 메뉴 (j-customer-auth-db)
- **결정:**
  - 사이드바 최상위 "손님" 메뉴다. 탭은 "손님 목록"(`guest:read`: 목록·등록·수정·삭제는 `guest:write`)과 "API 키"(`guest:write`만 보임)다.
  - API 키 화면은 이름·스코프를 정해 발급하고, 원문을 1회 표시(복사 버튼, "다시 볼 수 없음" 경고)하고, 목록과 확인 모달을 거친 회수를 제공한다. 마지막 사용 시각·만료일은 backlog다.
  - 손님 비밀번호는 등록하는 회원이 정한 값을 영구 비밀번호로 그대로 전달하고 로그에 남기지 않는다.
  - guest 권한을 부여하거나 회수할 때도 대상 세션을 삭제한다(결정 1).
- **이유:** 손님 데이터는 j-customer-auth-db가 소유하고 j-groupware는 화면과 중계만 맡는다. 손님 조회는 매일 하는 업무라 최상위 메뉴에 둔다.

### 결정 11. 메일 메뉴 (j-mail)
- **결정:** 사이드바 최상위 "메일" 메뉴(`mail:read`)다. 받은편지함 목록(수신자·발신자·제목·시각)과 상세(헤더, 텍스트·HTML 본문)를 보여 준다. HTML 본문은 샌드박스 iframe(`sandbox`, 스크립트 금지)으로 그린다.
- **이유:** 다른 서비스 메뉴와 같은 규칙이다.

### 결정 12. 조직도와 결재 (j-approval)
- **결정:**
  - **조직도 (G15):**
    - 부서 트리·직책·소속(j-auth 회원 id)을 `jgw_groupware`에 두고 `org:manage` 보유자가 편집한다.
    - 회원 추가 시 "미배치"에 자동 등록한다. 기존 회원과 Keycloak 콘솔에서 만든 계정은 관리자가 추가한다.
  - **결재선은 j-groupware가 만든다 (사용자):**
    - 기본 결재선 규칙은 소속 부서장 → 상위 부서장이고 작성자 본인은 뺀다.
    - 작성자는 단계를 추가·삭제하거나 순서를 바꿀 수 있다. 후보는 조직도에 등록된 같은 tenant 계정(미배치 포함)이다(사용자).
    - 상신 요청에 결재선(단계별 회원 id)을 담아 j-approval에 보낸다. j-approval이 j-groupware를 다시 호출하는 일은 없다.
  - **결재 화면 (G16):** 최상위 "결재" 메뉴(`approval:use`)에 상신(기본 결재선 미리보기·편집), 내 문서, 결재함, 상태·이력, 승인·반려(사유 필수)를 둔다.
- **이유:** 서비스 호출이 한 방향이 되고 j-approval 테스트에 j-groupware 서버가 필요 없다.

### 결정 13. 상담 메뉴와 위젯 설정 (j-talk)
- **결정:**
  - 최상위 "상담" 메뉴(`talk:read`)는 전체 문의방(대기·진행·종료)과 대화를 보여 준다. `talk:write` 보유자가 배정·재배정·답장·종료한다(j-talk 결정 5).
  - 손님 구분자가 있는 문의방은 j-customer-auth-db에서 손님 이름을 읽어 붙인다. 회원에게 `guest:read`가 없으면 구분자만 보인다([S7](architecture.md#s7)).
  - "상담 설정" 탭(`talk:write`)에서 다음을 한다.
    - 위젯 허용 출처 등록·삭제
    - 설치 안내(스니펫 복사, 서명 방법 예제)
    - 위젯 비밀키 발급·교체: 원문 1회 표시(j-talk 결정 2)
  - 메신저 중계 코드(G12)를 재사용해 j-talk HTTP·WSS를 중계한다.
- **이유:** 손님 쪽만 위젯 예외를 쓰고, 회원 쪽은 다른 메뉴와 같은 규칙이다.

### 결정 14. 웹 관리 메뉴 (j-web)
- **결정:**
  - 최상위 "웹 관리" 메뉴(`web:read`)다. 카페24 호스팅 관리 화면을 참조한다: 사이트 목록, 도메인 연결 상태, DNS 안내, 계정 정보.
  - `web:write` 보유자는 사이트 생성·삭제, 페이지 편집·미리보기·배포, 계정 비밀번호 재설정을 한다. 비밀번호 원문은 1회만 보여 준다(j-web 결정 6).
  - 배포에 성공하면 j-groupware 서버가 같은 사용자 Bearer로 j-talk 허용 출처 API에 사이트 출처를 등록한다. `talk:write`가 없거나 j-talk 미가입이면 안내만 보여 준다.
- **이유:** 서비스 사이 호출을 j-groupware → 서비스 한 방향으로 유지한다.

## 6. 알림과 토큰 축소

### 결정 15. 알림 센터
- **결정 (사용자: 알림은 j-groupware에서 1개로 통합, [S17](architecture.md#s17)):**
  - **수신:**
    - `POST /internal/notifications`를 loopback 내부 포트에서만 받는다.
    - 서비스별 내부 키(`X-JGW-Internal-Key`)의 해시를 확인한다. 서비스가 가입 상태이고, `type`이 그 서비스의 등록된 알림 종류여야 받는다.
    - 같은 `dedupKey`는 한 번만 저장한다.
  - **저장:** `jgw_groupware`의 `notifications`(tenant_id, service, type, 받는 사람, title, body, link, 생성 시각)와 회원별 읽음 표다. 30일 지난 알림은 지운다.
  - **알림 종류 표:**
    - `packages/permissions` 옆에 서비스별 알림 종류 표를 둔다(종류 → 아이콘·이름·문구 틀·필요 role).
    - 받는 사람이 `role`이면 그 role을 가진 회원에게만 보인다. 회원 id나 `usernames`이면 그 회원에게만 보인다.
    - 표에 없는 종류는 400이다.
  - **화면:**
    - 상단 알림 아이콘에 읽지 않은 수를 띄우고, 목록(서비스 아이콘 + 종류 이름 + 제목·내용 + 시각)과 클릭 시 `link` 이동·읽음 처리를 제공한다.
    - 새 알림은 SSE(`/api/notifications/stream`)로 바로 보낸다. 세션이 끝나면 스트림도 닫는다.
  - **첫 알림 종류:**
    - j-approval: `approval.turn`(결재 차례), `approval.done`(승인·반려 결과)
    - j-talk: `talk.new`(새 문의, `talk:read`), `talk.assigned`(배정)
    - j-mail: `mail.new`(새 메일, 수신자 username)
- **이유:** 저장·표시·실시간 전달을 한 번만 만든다. 서비스 → j-groupware 방향은 알림에만 허용한 예외다(S17).

### 결정 16. 하위 서비스용 토큰 축소
- **결정:**
  - 하위 서비스를 호출할 때 Keycloak standard token exchange로 aud를 그 서비스 하나로 줄인 토큰을 받아 전달한다([S4](architecture.md#s4)).
  - 받은 토큰은 세션·서비스별로 만료 전까지 캐시한다.
  - j-auth 회원 관리 API에는 원래 토큰과 서비스 키를 쓴다.
  - G23에서 만든다. 그 전에 만든 중계 코드는 토큰을 얻는 함수 하나만 바꾸면 되게 한다.
- **이유:** 하위 서비스에서 토큰이 새어도 다른 서비스에는 쓸 수 없다.

## 7. 작업 구성

PMT 통합 project 분류 `j-groupware`. Work마다 완료 기준을 두고 Item은 `blocked_by`로 잇는다. 다른 서비스와 연결하는 Item은 서비스마다 별도 Work에 두어 W1 완료가 다른 저장소 일정에 묶이지 않게 한다.

**W1 "j-groupware 최소 구현"** — 완료 기준: 고객 관리자가 하위 회원에게 게시판 권한을 주면 그 회원만 게시판 메뉴가 보이고 글을 쓸 수 있다.

| Item | 완료 기준 요약 | 선행 |
| --- | --- | --- |
| G1 저장소 골격 | S11 골격, `.npmrc` 레지스트리 scope, Compose PostgreSQL(고객 서버 `jgw_groupware`·전용 계정, control plane 콘솔 DB. 로컬은 인스턴스 1개), node-pg-migrate, 로컬 HTTPS, 포트, Git 제외 env | j-auth I4, X1 |
| G2 UI 기준 최소판 | ui-guidelines.md 토큰·레이아웃, packages/ui 기초 | G1 |
| G3 로그인·세션 | 결정 1 전체(Authorization Code + PKCE, 콜백, 세션, 갱신 잠금, RP 로그아웃, 백채널 로그아웃), `@j-auth/contracts` 레지스트리 설치, `/api/me`, Playwright 로그인 | G1, G2 |
| G4 권한 표·서버 검사 | 결정 3, 카탈로그 상수 기반 표, preHandler 403, 기본 거부 테스트, 메뉴 숨김 | G3 |
| G5 게시판 | tenant_id 테이블, 목록·작성·조회 API와 화면, board 권한 검사 | G4 |
| G6 하위 회원 관리 | 결정 2(서비스 키, grantable-roles, 쓰기→읽기 잠금, 추가·삭제), 변경 시 세션 삭제·logout | G4, j-auth I6 |
| G7 운영 콘솔 | 앱 분리, 콘솔 DB, `operator` 로그인, 고객 목록·계약 상태 | G4 |
| G8 완료 기준 테스트 | 결정 7 시나리오 통과 | G5, G6, G7 |
| G9 UI 기준 완성 | 컴포넌트 절 문서화, packages/ui와 일치 | G5, G6, G7 |
| G11 gateway | 결정 8 gateway·예외 경로·빈 위젯 응답·남용 방지, 렌더링·`nginx -t` 스크립트, 인증서 SAN·hosts, WebSocket 전달 | G1 |
| G23 토큰 축소 | 결정 16, 서비스별 aud 1개 토큰 발급·캐시, 다른 서비스 aud 거절 확인 테스트 | G3 |
| G10 Hyper-V VM 검증 | VM 2대, HTTPS, systemd·Compose, `gw.` 중계, VM 대상 G8 통과, 메모리·CPU 측정(S15) | G8, G9, G11, G18, j-auth I5 |

**W2 "손님 관리 연결"** — 완료 기준: guest 권한을 받은 회원에게만 손님 메뉴가 보이고 손님을 등록할 수 있다. `guest:write` 회원이 API 키를 발급·회수할 수 있다.

| Item | 완료 기준 요약 | 선행 |
| --- | --- | --- |
| G13 손님 메뉴·API 키 화면 | 결정 10, 공통 중계 규칙, Vitest 통합 + Playwright e2e | G4, G6, j-customer-auth-db C5 |

**W3 "결재 연결"** — 완료 기준: `approval:use` 회원이 조직도 기반 또는 커스텀 결재선으로 상신하고, 지정자가 순서대로 승인·반려하며, 작성자·결재자가 상태와 이력을 본다.

| Item | 완료 기준 요약 | 선행 |
| --- | --- | --- |
| G15 조직도 | 결정 12 조직도·미배치 자동 등록·기본 결재선 규칙, tenant 격리, Vitest | G4, G6 |
| G16 결재 화면 | 결정 12 결재 화면, 공통 중계 규칙, Vitest + Playwright e2e | G15, j-approval A5·A6 |

**W4 "고객 등록·서비스 가입 자동화"** — 완료 기준: 콘솔에 고객을 등록하면 realm이 자동으로 생기고, 부트스트랩한 고객 서버에서 가입한 서비스가 자동 설치되어 메뉴·부여 항목이 생긴다. 해지하면 자동으로 사라지고 계정·Nginx 설정이 되돌려진다. 다른 서비스 DB 계정으로는 접속할 수 없다.

| Item | 완료 기준 요약 | 선행 |
| --- | --- | --- |
| G17 콘솔 고객 등록·가입 서비스 | 결정 4 고객 등록(realm 생성 호출, 부트스트랩 정보 1회 표시)·가입 서비스, 콘솔 서비스 키, 실패 표시·재시도, 실제 j-auth 대상 Vitest | G7, j-auth I7·I8 |
| G18 부트스트랩·설치·해지 스크립트 | 결정 8 부트스트랩·설치·해지·`--purge`, 알림 내부 키, j-web 설치 항목, 해지 후 계정·Nginx 원상복구 확인, 다른 서비스 계정 접속 거부 테스트 | G1, G11 |
| G21 프로비저닝 에이전트 | 결정 4 원하는 상태 API, 결정 8 에이전트(timer, 멱등, 잠금, 상태 보고), 가입 → 자동 설치 → 해지 → 자동 제거 테스트 | G17, G18 |

**W5 "메신저 화면 연결"** — 완료 기준: `messenger:use` 회원에게만 메신저 메뉴가 보이고, j-groupware 안에서 같은 고객 소속 하위 회원끼리 대화를 주고받는다.

| Item | 완료 기준 요약 | 선행 |
| --- | --- | --- |
| G12 메신저 화면 | 결정 9 j-groupware 쪽, 중계(재연결 시 갱신 토큰, 세션 삭제 시 WSS 종료), Vitest, Playwright 대화 | G4, G11, M2 |

**W6 "메일 화면 연결"** — 완료 기준: `mail:read` 회원에게만 메일 메뉴가 보이고, 고객 서버 안에서 보낸 메일을 화면에서 읽는다.

| Item | 완료 기준 요약 | 선행 |
| --- | --- | --- |
| G14 메일 화면 | 결정 11, 공통 중계 규칙, Vitest + Playwright e2e | G4, j-mail E3 |

**W7 "상담 연결"** — 완료 기준: `talk:read` 회원에게만 상담 메뉴가 보이고, 위젯 문의가 실시간으로 목록에 뜨며, `talk:write` 회원이 배정·답장·종료하고 허용 출처·위젯 비밀키를 관리한다.

| Item | 완료 기준 요약 | 선행 |
| --- | --- | --- |
| G19 상담 화면·설정 | 결정 13, G12 중계 재사용, Vitest 통합 + Playwright e2e(위젯 → 상담 화면) | G4, G6, G11, G12, G13, j-talk T5 |

**W8 "웹 관리 연결"** — 완료 기준: `web:write` 회원이 도메인을 입력하면 사이트가 셋팅·배포되고, j-talk 가입 고객은 사이트 출처가 허용 출처로 등록된다.

| Item | 완료 기준 요약 | 선행 |
| --- | --- | --- |
| G20 웹 관리 화면 | 결정 14, 공통 중계 규칙, 비밀번호 1회 표시 UI, Vitest 통합 + Playwright e2e | G4, G6, G19, j-web H7 |

**W9 "알림"** — 완료 기준: 결재 차례·새 문의·새 메일이 j-groupware 알림 아이콘에 실시간으로 뜨고, 받을 권한이 있는 회원에게만 보인다.

| Item | 완료 기준 요약 | 선행 |
| --- | --- | --- |
| G22 알림 센터 | 결정 15(내부 수신 API·키, 종류 표, 저장·보관, SSE, 화면), Vitest + Playwright | G4 |
| A9 / T9 / E8 | 각 서비스의 알림 송신(j-approval·j-talk·j-mail 문서) | G22 |

**j-messenger 연결 (분류 `j-messenger`)** — 완료 기준: j-groupware 메신저 메뉴에서 j-auth 계정으로 같은 고객 소속 하위 회원끼리 대화를 주고받는다. j-messenger AGENTS.md 제약을 지킨다: serverId 격리, 로그에 비밀값 없음, 새 의존성은 공식 호환성 메모, 자동 push·배포 금지, 포트 3001 금지.

| Item | 완료 기준 요약 | 선행 |
| --- | --- | --- |
| M5 PostgreSQL 전환 | SQLite → `jgw_messenger`(전용 계정), S9 도구, 기존 서버 테스트 통과 | - |
| M1 Bearer 인증 어댑터 | 결정 9 j-messenger 쪽 인증, `@j-auth/contracts` 레지스트리 설치, 401·403 구분 | j-auth I4, X1 |
| M2 client 패키지 게시 | `client-core`·`client-react` 레지스트리 게시, API·WSS 기본 주소를 중계 경로로 설정 가능, j-groupware CSS 변수 적용 | M1 |
| M3 연결 통합 테스트 | 실제 j-auth 토큰(테스트가 회원 관리 API로 만든 회원 2명)으로 같은 tenant WSS 송수신, 권한 없는 회원 403, tenant 격리 | M1, M5, j-auth I6 |
| M4 고객 서버 검증 | VM에서 `jgw_messenger`·내부 포트, j-groupware 메신저 메뉴 → 대화, VM 대상 M3 통과 | M3, G12, G10, G18 |

backlog: j-groupware 앱(Android WebView 셸)·데스크톱·iOS, 메신저 대화 상대 조직도 연동, 메신저 알림 송신. 범위 밖(사용자): 고객 서버 생성 자동화, 사양에 따른 자동화.

## 이전 번호 대응

| 새 | 이전 | 비고 |
| --- | --- | --- |
| 1 | 1, 2 | OIDC BFF로 다시 씀. 토큰 전달 원칙은 S4 |
| 2 | 3 | +서비스 키, 쓰기→읽기 |
| 3 | 4 | |
| 4 | 7, 20(콘솔 부분) | +고객 등록·realm 자동 생성·원하는 상태 API |
| 5 | 9 | |
| 6 | 10 | |
| 7 | 13 | |
| 8 | 17, 20(설치), 25(R3) | +해지, 남용 방지 |
| 9 | 14, 15, 16, 22(메신저 부분) | 14(PMT 위치)는 S16으로 대체 |
| 10 | 18 | |
| 11 | 19 | |
| 12 | 21 | |
| 13 | 24, 23(설정 부분) | +위젯 비밀키 |
| 14 | 25 | |
| 15 | 새로 추가 | 알림 센터(S17) |
| 16 | 새로 추가 | 토큰 축소 |
| S3 | 5 | 권한 이름 표 |
| S4 | 2(전달 원칙) | |
| S8, S9 | 6-1, 6-2 | |
| S10 | 8 | vendor → 레지스트리 |
| S12 | 11 | |
| S13 | 12 | |
| S2 | 20 | |
| S5, S6, S7 | 22, 17(원칙), 23 | |
| S16 | 0, 14 | |
