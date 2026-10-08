# j-groupware 제품군 구성과 공통 결정

소형 그룹웨어 제품군의 구성, 공통 결정, 서비스별 최소 범위, 구현 순서, 작업 관리 방식을 정리한다. 각 서비스는 **동작을 증명하는 최소 기능**만 만든다.

**이 문서가 제품군 공통 기준의 단일 원본이다.** 여러 서비스에 걸치는 결정은 여기에 `S<번호>`로 한 번만 적는다. 각 서비스의 `docs/decisions.md`는 그 서비스만의 결정만 적고, 공통 내용은 이 문서로 링크한다(예: `architecture.md#s4`). 같은 내용을 두 곳에 적지 않는다.

정리일: 2026-10-07 (2026-10-07 통합 정리에서 서비스 문서에 흩어져 있던 공통 결정을 모으고, 모든 문서의 결정 번호를 다시 매겼다. 이전 번호 대응은 각 서비스 문서 끝의 표를 본다.)

## 1. 회원 구조

| 계층 | 누구 | 주로 쓰는 서비스 |
| --- | --- | --- |
| 운영사 담당자 | 그룹웨어를 배포·판매하는 회사 직원. 고객·계약·인증 문제 관리 | j-groupware 운영 콘솔 |
| 고객 (tenant) | 그룹웨어를 구매한 회사. 관리자 계정 보유 | j-groupware 고객 관리, 권한 부여, 서비스 사용 |
| 하위 회원 | 고객 소속 직원. 고객이 준 권한에 따라 보이는 기능이 다름 | j-groupware 화면 안의 게시판·메신저·메일·손님·결재·상담·웹 관리 |
| 고객의 고객 (손님) | 고객 회사의 손님 | 고객 웹사이트의 상담 위젯(j-talk), j-customer-auth-db 손님 계정 |

- 운영사·고객·하위 회원 인증은 **j-auth(Keycloak)**가 담당한다.
- 손님 정보와 인증은 **j-customer-auth-db**가 담당한다. Keycloak과 분리해 고객이 자기 손님 데이터를 직접 소유한다.

## 2. 전체 배치

```
                ┌────────────────────── 운영사 control plane (1대) ─────────────────┐
                │ j-groupware 운영 콘솔 · 고객/계약/가입 서비스 관리                 │
                │ j-auth (Keycloak: 운영사 realm + 고객별 realm)                     │
                └───────────────┬────────────────────────────────────────────────────┘
                                │ 고객 구매 → 고객 서버 생성, 가입 서비스 설치
          ┌─────────────────────▼──────────── 고객 서버 (고객마다 1대) ─────────────────┐
          │ Nginx ── gw.<tenant> (+ /ext/ 예외 경로, j-web 고객 사이트 블록)             │
          │   ├─ j-groupware (기본 서비스: 웹 화면 + 중계, 항상 설치)                    │
          │   └─ 가입 서비스 API: j-messenger · j-mail · j-customer-auth-db ·            │
          │                       j-approval · j-talk · j-web (내부 포트)               │
          │ PostgreSQL 인스턴스 1개 ── 서비스마다 전용 database + 전용 계정             │
          └──────────────────────────────────────────────────────────────────────────────┘
   별도 도구: j-game-client (Git 버전 감시·배포)
```

## 3. 공통 결정

<a id="s1"></a>
### S1. 서버 배치: 고객별 서버
- **결정 (사용자):**
  - control plane 서버 1대에 j-auth(Keycloak)와 운영 콘솔을 둔다.
  - 고객마다 고객 서버 1대(Hyper-V VM)를 두고, 그 안에 j-groupware와 가입한 서비스, PostgreSQL 인스턴스 1개를 모두 올린다. 여러 고객이 서버 한 대를 공유하지 않는다.
- **세부:**
  - 고객 서버 사양은 손님 수 등급 S(30명)·M(50명)·L(100명)과 가입 서비스로 운영자가 고른다([S15](#s15)).
  - 고객 서버 생성은 수동이고, realm 생성과 서비스 설치·해지는 자동이다([S2](#s2)). 최소 구현은 VM 2대(control plane 1, 고객 서버 1)로 검증한다.
  - 데이터 테이블에는 그래도 `tenant_id`를 둔다([S8](#s8)). 한 서버에 여러 tenant를 두는 경우에 대비하는 방어선이다.
- **이유:** 고객 사이 장애·부하·데이터가 서버 단위로 분리되고, 고객 사이트(j-web)의 DNS가 고객 서버 하나를 가리키면 된다.

<a id="s2"></a>
### S2. 서비스 형태와 가입
- **결정 (사용자):** 서비스 하나는 **API 서버 + 전용 PostgreSQL database** 한 쌍이다. j-messenger를 포함해 모든 서비스에 적용한다. j-groupware는 기본 서비스라 항상 설치되고, 나머지는 고객이 가입한 것만 설치한다.
- **DB 단위 (A안, 사용자):**
  - 고객 서버의 PostgreSQL 인스턴스 1개에 서비스마다 database `jgw_<서비스>`와 전용 계정을 둔다.
  - 전용 계정은 자기 database에만 접속한다(`PUBLIC`의 `CONNECT` 회수). 계정별 접속 수 제한과 `statement_timeout`을 둔다.
  - 서비스는 자기 `DATABASE_URL` 하나만 알고 다른 서비스 database를 직접 조회하지 않는다. 필요한 데이터는 상대 서비스의 API로 받는다.
  - 백업은 서비스 단위 `pg_dump`가 기본이다. 무거운 서비스는 덤프·복구 후 `DATABASE_URL`만 바꿔 전용 인스턴스로 옮길 수 있다.
- **고객 등록과 가입 절차 (자동화 범위는 사용자 결정):**
  1. **고객 서버 생성은 수동이다.** 운영자가 VM을 만들고, 콘솔이 고객 등록 때 1회 보여 주는 부트스트랩 정보(tenant, 비밀값, 에이전트 키)로 기본 설치 스크립트를 실행한다. 손님 수 등급에 따른 사양 선택([S15](#s15))도 운영자가 한다. 사양에 따른 자동화는 만들지 않는다.
  2. **realm 생성은 자동이다.** 콘솔에 고객을 등록하면 콘솔이 j-auth realm 생성 API를 호출한다(j-auth 결정 20).
  3. **가입 반영은 자동이다.** 콘솔에서 서비스를 가입·해지하면 콘솔이 j-auth 가입 API를 호출해 realm의 서비스 role·aud를 바꾼다(j-auth 결정 14).
  4. **서비스 설치·해지는 자동이다.** 고객 서버의 프로비저닝 에이전트가 콘솔의 "원하는 가입 상태"를 1분마다 가져와, 설치 스크립트로 맞춘다. 설치는 database·전용 계정, 서비스 기동, gateway 경로를 포함한다(j-groupware 결정 8).
  5. j-groupware 메뉴·중계·권한 부여 항목은 roles로 열린다. 미가입 서비스의 role은 realm에 없으므로 자연히 닫힌다.
- **해지:** [S14](#s14).
- **예외 없음:** 저장할 상태가 아직 없는 서비스(j-mail)도 database 골격을 둔다. 이미 SQLite를 쓰는 j-messenger도 옮긴다. 가치는 적지만 가입·해지·백업 절차를 하나로 맞추기 위해 한다(사용자).

<a id="s3"></a>
### S3. 권한 모델과 서비스 카탈로그
- **결정:**
  - 사람의 신분은 realm role(`operator:admin`, `tenant:admin`, `tenant:member`), 기능 권한은 서비스 이름의 role 전용 client에 둔 client role이다. 이름 규칙은 `대상:동작`이다.
  - **서비스 카탈로그는 j-auth contracts의 상수 하나가 원본이다**(j-auth 결정 13). `tenant:admin` 묶음, 부여 가능 role, aud 목록, j-groupware 권한 표는 모두 이 상수에서 계산한다. 아래 표는 읽기용 사본이다.

    | 서비스 (role client = aud) | 구분 | 기능 role | 부여 가능 | 화면 |
    | --- | --- | --- | --- | --- |
    | `j-groupware` | 기본 | `board:read`, `board:write`, `member:manage`, `org:manage` | `board:*`, `org:manage` | 게시판, 회원 관리, 조직도 |
    | `j-messenger` | 선택 | `messenger:use` | 같음 | 메신저 |
    | `j-mail` | 선택 | `mail:read` | 같음 | 메일 |
    | `j-customer-auth-db` | 선택 | `guest:read`, `guest:write` | 같음 | 손님 |
    | `j-approval` | 선택 | `approval:use` | 같음 | 결재 |
    | `j-talk` | 선택 | `talk:read`, `talk:write` | 같음 | 상담 |
    | `j-web` | 선택 | `web:read`, `web:write` | 같음 | 웹 관리 |
    | `j-console` (운영사 realm) | - | `customer:read`, `customer:write` | - | 운영 콘솔 |

  - `tenant:admin` = 기본 서비스 role + 가입한 서비스 role 전체. `operator:admin` = `customer:read` + `customer:write`. `tenant:member`는 기능 role이 없다.
  - **쓰기는 읽기를 포함한다 (사용자):** `*:write`는 Keycloak 복합 client role로 같은 대상의 `*:read`를 포함한다. 그래서 어떤 경로로 부여해도 쓰기 회원은 읽기도 가진다. j-groupware 회원 관리 화면은 쓰기를 체크하면 읽기를 체크된 채 잠근다. 쓰기를 회수하면 직접 부여한 읽기만 남는다.
  - `member:manage`와 신분 role은 회원 관리 API로 부여할 수 없다.
- **이유:** 서비스가 늘어도 카탈로그에 한 줄을 더하는 것으로 끝나고, 문서마다 식을 다시 적지 않는다.

<a id="s4"></a>
### S4. 인증과 토큰 전달 (OIDC Authorization Code)
- **결정 (사용자): 처음부터 OIDC Authorization Code로 만든다.** ROPC 로그인 API는 만들지 않는다.
- **회원 로그인:**
  - j-groupware가 BFF로 고객 realm의 Keycloak Authorization Code + PKCE(S256) 흐름을 쓴다. 로그인 client는 confidential client `j-groupware`이고, 고객 realm은 접속 이름 `gw.<tenant>`에서 정한다(realm `tenant-<tenant>`).
  - 로그인 화면은 Keycloak이 그린다. j-groupware UI 기준에 맞춘 테마를 쓴다([S5](#s5) 예외).
  - j-groupware는 브라우저에 httpOnly 세션 쿠키만 준다. access·refresh token은 서버 세션에만 둔다(j-groupware 결정 1).
  - 운영 콘솔은 운영사 realm의 `j-console` client로 같은 흐름을 쓴다.
- **토큰 전달:**
  - j-groupware는 하위 서비스를 호출할 때 세션의 access token을 Bearer로 전달한다. 만료가 30초 안으로 남았으면 Keycloak 토큰 엔드포인트로 직접 갱신한다.
  - Revoke Refresh Token을 켠다. 갱신할 때마다 refresh token이 바뀌므로, j-groupware는 세션마다 갱신을 하나씩만 실행한다(j-groupware 결정 1). 이미 쓴 refresh token이 다시 오면 Keycloak이 거절하고, 세션을 끝낸다.
  - 각 서비스는 j-auth 토큰 검증 기준(j-auth 결정 9: RS256, iss, `azp=j-groupware`, aud에 자기 client ID, `tenant` claim, 허용 tenant)으로 검증하고 자기 role을 직접 검사한다.
  - WSS는 handshake 때 한 번 검증한다. j-groupware가 세션을 삭제하면 그 세션의 WSS 중계도 끊는다.
- **세션 무효화 (이벤트 기반):**
  - 회원 권한을 바꾸거나 회원을 삭제하면, j-auth가 그 회원의 Keycloak 세션을 끝낸다.
  - Keycloak은 j-groupware의 백채널 로그아웃 엔드포인트로 알리고, j-groupware는 해당 세션을 삭제한다. 로그아웃도 같은 경로다(RP-initiated logout + 백채널 로그아웃).
- **호출 서비스 키 (보안):** j-auth 관리 API(회원 관리, 가입, realm 생성)는 사용자 Bearer와 함께 `X-JGW-Service-Key`를 요구한다(j-auth 결정 15). 회원 관리는 tenant별 j-groupware 키, 가입·realm 생성은 운영 콘솔 키다.
- **토큰 축소 (token exchange):**
  - j-groupware는 하위 서비스로 넘길 때 Keycloak standard token exchange로 aud를 그 서비스 하나로 줄인 토큰을 받아 전달한다(서비스별 캐시).
  - 그래서 하위 서비스에서 토큰이 새어도 다른 서비스에는 쓸 수 없다.
  - j-groupware Item G23에서 W1 다음에 만든다. 그 전까지는 원래 토큰을 그대로 전달한다.
- **테스트:** 샘플 realm에서만 `j-groupware` client의 Direct Access Grants를 켜서 테스트가 토큰을 바로 받는다. 자동 생성되는 고객 realm에서는 꺼져 있다(j-auth 결정 16).
- **이유:**
  - 코드가 없을 때 바로 OIDC로 가면 버려지는 ROPC 코드가 없다.
  - 비밀번호를 j-groupware가 받지 않고, Keycloak의 로그인 보호를 그대로 쓴다.
  - 백채널 로그아웃으로 세션 무효화가 이벤트 기반이 된다.

<a id="s5"></a>
### S5. 화면은 j-groupware에서만
- **결정 (사용자):** 모든 서비스는 백엔드 API만 만든다. 웹·앱 화면은 j-groupware(React)가 그린다. 기준 UI는 j-groupware `docs/ui-guidelines.md`다.
- **세부:**
  - j-messenger 화면은 j-messenger의 `@j-messenger/client-core`·`client-react` 패키지를 j-groupware 안에서 렌더링한다. j-messenger의 web·desktop·android 앱은 동결한다(j-groupware 결정 9).
  - j-groupware 앱(Android WebView 셸 등)은 backlog다.
  - **예외는 두 가지다:**
    - Keycloak 로그인 화면. j-auth가 j-groupware UI 토큰을 복사한 테마로 꾸민다(j-auth 결정 21).
    - 손님용 상담 위젯([S7](#s7)).

<a id="s6"></a>
### S6. 외부 진입, gateway, 남용 방지
- **결정:**
  - 고객 서버가 그룹웨어용으로 여는 이름은 `gw.<tenant>.jgw.test` 하나다. 서비스 API는 loopback 내부 포트로만 열고 j-groupware 서버가 중계한다.
  - **예외 경로:** 회원 세션 없이 외부에서 부르는 경로만 `gw.` server 블록에서 그 서비스로 바로 넘긴다. 인증은 그 서비스가 한다.
    - `/ext/customer-auth/` → j-customer-auth-db. 확장 공개 API와 손님 로그인 API이고, API 키 인증, 고객 사이트 서버용이다(j-customer-auth-db 결정 5·8).
    - `/ext/talk/` → j-talk. 손님 위젯, 손님 API, WSS다([S7](#s7)).
  - **j-web 고객 사이트:** j-web에 가입한 고객 서버는 사이트 도메인 server 블록(`/etc/nginx/jweb.d/`, j-web 소유)과 사이트 계정용 SFTP·FTPS를 따로 연다(j-web 결정 4·5).
  - **남용 방지 (보안):**
    - Nginx가 `/ext/` 경로에 IP별 요청 속도 제한(`limit_req`)과 동시 연결 제한(`limit_conn`, WSS 포함)을 건다. 초과하면 429다. 기본값은 j-groupware 결정 8에서 설정 가능하게 둔다.
    - 서비스는 자체 제한을 함께 둔다. j-talk은 방문자 토큰 발급·메시지 수·크기, j-customer-auth-db는 로그인 시도를 제한한다.
  - **관리 SSH 분리 (보안):** 고객 사이트용 SFTP는 운영자 SSH와 다른 sshd 인스턴스·포트로 띄운다. 운영자 SSH는 키 인증만 쓰고, 방화벽에서 운영자 출처로 제한한다(j-web 결정 5).
- **이유:** 진입점과 인증 지점이 적을수록 막을 곳이 분명하다. 공개 경로는 반드시 요청 수를 제한한다.

<a id="s7"></a>
### S7. 손님 상담 위젯
- **결정 (사용자):** j-talk은 손님 화면을 고객 웹사이트에 삽입하는 위젯으로 제공한다. 오른쪽 아래에 항상 떠 있는 버튼(FAB)을 누르면 대화창이 열린다.
- **배포 (사용자):**
  - CSS를 JS에 넣어 압축한 파일 하나 `widget.min.js`로 배포한다.
  - 주소는 고정 `https://gw.<tenant>.jgw.test/ext/talk/v1/widget.min.js`다. 파일 이름에 해시를 넣지 않고, 짧은 캐시(`Cache-Control: max-age=300`)와 ETag를 쓴다. 그래서 새로 배포하면 모든 사이트가 몇 분 안에 항상 최신 위젯을 받는다. 호환이 깨지는 변경만 경로의 `v1`을 올린다.
  - 삽입은 한 줄이다.

    ```html
    <script src="https://gw.<tenant>.jgw.test/ext/talk/v1/widget.min.js" async></script>
    ```

  - j-web은 j-talk 가입 여부와 관계없이 모든 사이트에 이 줄을 넣는다(j-web 결정 9). j-talk이 설치되지 않은 고객 서버에서는 gateway가 이 주소에 빈 스크립트(200, 내용 없음)를 돌려준다. 그래서 가입·해지가 바뀌어도 사이트를 다시 배포할 필요가 없다.
  - 위젯은 Shadow DOM 안에 그려 고객 사이트 CSS와 간섭하지 않는다. 표시 조건은 세 가지다: j-talk 동작 중, 출처 허용됨, 고객이 j-talk 가입. 하나라도 아니면 버튼을 그리지 않는다.
- **손님 식별 (사용자):**
  - 기본은 익명 방문자다. j-talk이 방문자 토큰을 발급한다.
  - 고객 사이트가 손님을 알면 위젯에 **손님 구분자**를 넘긴다. j-talk은 그 문의를 해당 손님(j-customer-auth-db 손님 id) 앞으로 저장한다.
  - **구분자 서명 (보안):** 위젯 속성으로 넘긴 구분자는 누구나 꾸밀 수 있으므로, 서명이 맞을 때만 손님으로 인정한다.
    - 서명 값은 `data-guest-id`, `data-guest-exp`, `data-guest-sig`이고, `data-guest-sig` = HMAC-SHA256(위젯 비밀키, `tenant|guestId|exp`)이다.
    - 서명은 고객 사이트의 서버가 만든다. 위젯 비밀키는 j-groupware 상담 설정에서 발급한다(j-talk 결정 2).
    - 서명이 없거나 틀리면 익명 방문자로 처리한다.
    - 고객 사이트 서버는 손님 확인에 j-customer-auth-db 로그인 API(`/ext/customer-auth/`, API 키)를 쓸 수 있다.
    - 정적 사이트(j-web)는 서버가 없으므로 익명만 쓴다.
  - j-talk은 j-customer-auth-db를 호출하지 않는다. 손님 이름 등 표시 정보는 j-groupware 상담 화면이 j-customer-auth-db에서 읽어 붙인다. 서비스 간 호출은 j-groupware → 서비스 한 방향이다.

<a id="s8"></a>
### S8. tenant 구분
- 모든 업무 테이블에 `tenant_id`를 둔다. 데이터 접근 함수는 tenant를 필수 인자로 받아 모든 쿼리 조건에 강제한다.
- 서버 설정의 허용 tenant 목록(기본 1개) 밖의 요청은 거절한다. 다른 tenant 데이터가 보이지 않는지 통합 테스트로 검증한다.

<a id="s9"></a>
### S9. DB 접근과 마이그레이션
- 드라이버 `pg`, 마이그레이션 node-pg-migrate SQL 파일, 쿼리는 SQL 직접 작성, 결과 타입 직접 정의, 버전 정확히 고정. SQLite는 쓰지 않는다.
- 각 서비스 마이그레이션은 자기 저장소에 둔다. Keycloak과 운영 콘솔 DB는 control plane PostgreSQL에 둔다.

<a id="s10"></a>
### S10. 패키지 배포: 로컬 npm 레지스트리
- **결정 (사용자):** 서비스 사이에 공유하는 패키지는 로컬 npm 레지스트리로 배포한다. 대상은 각 서비스 `contracts`, `@j-messenger/client-core`·`client-react`다. `vendor/*.tgz` 커밋 방식은 쓰지 않는다.
- **세부:**
  - 레지스트리는 Verdaccio다. 개발 PC에서 버전 고정 Docker Compose로 loopback에만 띄운다. 구성은 j-groupware `tools/registry/`에 둔다(공통 작업 X1).
  - scope는 서비스 이름이다(`@j-auth`, `@j-groupware`, `@j-messenger`, `@j-customer-auth-db`, `@j-mail`, `@j-approval`, `@j-talk`, `@j-web`). 각 저장소 `.npmrc`가 이 scope들을 로컬 레지스트리로 보낸다. 그 밖의 패키지는 공개 npm에서 받는다.
  - 게시 인증 토큰은 사용자 홈의 npmrc에만 두고 저장소에 넣지 않는다.
  - semver를 지킨다. 게시한 버전은 고치거나 지우지 않고 새 버전을 낸다. 받는 쪽은 정확한 버전과 lockfile로 고정한다. 바뀐 내용은 각 패키지 `CHANGELOG.md`에 적는다.
  - VM 배포 묶음에는 빌드된 의존성을 넣는다. 그래서 VM은 레지스트리가 필요 없다.
  - 레지스트리 저장소는 백업 대상이다. 다른 PC·CI에서 쓰는 것은 backlog다.
- **이유:** 계약이 바뀔 때마다 pack → 복사 → 커밋을 저장소마다 반복하는 일을 `npm publish` 한 번과 버전 올리기로 줄인다.
- **적용 확인 (2026-10-08):** 공식 배포 방식 비교 후 기존 Verdaccio 원안을 유지하고 `6.10.5`로 고정했다. GitHub Packages는 현재 서비스 scope 8개와 로컬 진입점 요구를 바꾸며, tarball 전달은 반복 복사 방식을 되살린다. 현재 회사 노트북에서는 시스템 설치·Docker 기동을 금지하며, 실제 Node fixture 검증과 Compose 실기동 미검증을 구별한다.

<a id="s11"></a>
### S11. 저장소 골격
- j-messenger에서 npm workspaces, `tsconfig.base.json`, eslint, prettier, Vitest, `scripts/`, `deploy/`를 복사해 줄이고 도구 버전을 같게 고정한다.
- 기본 폴더는 `apps/server`, `packages/contracts`다(서비스별 추가는 각 문서).
- 로컬 HTTPS(로컬 CA)를 쓰고, 비표준 기본 포트를 두되 설정으로 바꿀 수 있게 한다. 3001은 쓰지 않는다. 비밀값은 Git 제외 env에만 두고 로그에 남기지 않는다.

<a id="s12"></a>
### S12. 테스트 원칙과 테스트 계정
- 가짜 서버를 만들지 않는다. Vitest로 실제 j-auth·Keycloak·PostgreSQL과 필요한 서비스를 대상으로 시나리오를 검증한다. 화면 e2e(Playwright)는 j-groupware에서 한다.
- **테스트 계정 (사용자):**
  - realm JSON에는 기본 계정만 둔다(j-auth 결정 16). `op-admin`, `a-admin`, `a-member`, `b-admin`, `b-member`, `c-admin`이다.
  - 서비스별 권한을 가진 회원은 각 서비스 테스트가 j-auth 회원 관리 API(j-auth 결정 11)로 만든다. `a-admin` 토큰과 j-groupware 서비스 키를 쓴다. 실행마다 고유한 username을 쓰고, 끝나면 삭제한다.
  - 그래서 서비스 통합 테스트 Item은 j-auth I6(회원 관리 API) 뒤에 온다.

<a id="s13"></a>
### S13. 배포·검증 원칙
- 로컬에서 먼저 완료한 뒤 Hyper-V VM에서 같은 구성으로 다시 검증한다.
- 앱은 systemd로 실행한다. PostgreSQL·Keycloak·Mailpit 같은 외부 제품은 버전을 고정한 Docker Compose로 띄운다.
- 테스트 도메인은 `.jgw.test`이고 hosts와 로컬 CA 인증서 SAN에 등록한다. 외부 인터넷에 노출하지 않는다.

<a id="s14"></a>
### S14. 서비스 해지
- **결정 (사용자):** 해지하면 계정을 삭제하고 Nginx 설정을 가입 전으로 되돌린다.
- **절차:** j-groupware `deploy/provision-service --remove <서비스>`가 순서대로 한다(j-groupware 결정 8).
  1. 콘솔에서 해지를 기록하면, j-auth가 그 서비스 role·aud·client를 제거한다(j-auth 결정 14). 회원에게 준 그 서비스 권한도 함께 사라진다.
  2. 서비스 systemd unit을 멈추고 비활성화한다.
  3. 서비스 database를 `pg_dump`로 백업한다.
  4. DB 전용 계정을 `NOLOGIN`으로 바꾸고 남은 연결을 끊는다.
  5. 서비스 고유 정리를 한다.
     - j-web: 사이트 server 블록 삭제, SFTP·FTPS 계정 삭제, 사이트 디렉터리를 백업 폴더로 이동(j-web 결정 13 helper).
     - j-mail: Mailpit 컨테이너 중지, 메일 볼륨 백업.
  6. 그 서비스의 gateway 예외 경로를 빼고 설정을 다시 렌더링한다. j-talk 해지 뒤에도 위젯 주소는 빈 스크립트로 남는다([S7](#s7)).
  7. `nginx -t` 후 reload한다. 실패하면 직전 설정으로 되돌리고 오류로 멈춘다.
  8. 서비스 env 파일(비밀값)을 지운다.
- **영구 삭제:** database와 DB 계정 `DROP`, 백업 삭제는 확인 후 `--purge`로 따로 실행한다. 다시 가입하면 빈 상태로 새로 시작한다.

<a id="s15"></a>
### S15. 고객 서버 사양 선택
- **결정 (사용자):** 손님 수 등급 S(30명)·M(50명)·L(100명)과 쓰는 서비스 종류로 고객 서버 사양을 고른다. 고르는 일은 운영자가 하고, 사양에 따른 자동화는 만들지 않는다([S2](#s2)).
- **아래 값은 추정이다.** j-groupware G10 VM 검증에서 실제 메모리·CPU를 측정해 고친다.

**사양 등급**

| 사양 | vCPU | RAM | 시스템 디스크 |
| --- | --- | --- | --- |
| 소형 | 2 | 2GB | 30GB |
| 중형 | 2 | 4GB | 40GB |
| 대형 | 4 | 8GB | 60GB |

**선택표** (선택 서비스 = j-groupware를 뺀 가입 서비스 수)

| 손님 수 등급 | 선택 서비스 0~1개 | 선택 서비스 2~4개 | 선택 서비스 5~6개 |
| --- | --- | --- | --- |
| S (30명) | 소형 | 중형 | 중형 |
| M (50명) | 소형 | 중형 | 중형 |
| L (100명) | 중형 | 중형 | 중형 |

- **추가 디스크:**
  - j-mail 가입: 시스템 디스크 +10GB
  - j-web 가입: 사이트 전용 데이터 디스크 20GB를 따로 붙인다(j-web 결정 14)
- **대형:** 이 손님 수 범위에서는 필요 없다. e2e·부하 검증용으로만 쓴다.

**근거 (메모리 추정)**

| 구성 | 메모리 |
| --- | --- |
| 기본: OS(GUI 없는 Linux) + PostgreSQL 1개 + j-groupware | 약 1.05GB |
| j-messenger / j-talk | 각 약 0.15GB |
| j-mail(서버 + Mailpit) | 약 0.15GB |
| j-customer-auth-db / j-approval | 각 약 0.12GB |
| j-web(서버 + 사이트용 sshd·FTPS) | 약 0.17GB |
| 손님 수 보정 | M +0.05GB, L +0.2GB |

- 고르는 규칙: 합계 × 1.5 ≤ RAM.
- 예: L 등급 + 전 서비스 ≈ 2.1GB × 1.5 ≈ 3.2GB → 중형(4GB).
- 손님 100명 이하에서는 등급보다 서비스 수가 사양을 정한다.
- **control plane:** 2 vCPU, 4GB RAM, 30GB. Keycloak(JVM)이 가장 크다.

<a id="s16"></a>
### S16. 작업 관리
- **결정 (사용자):** PMT는 project 하나 `j-groupware-suite`로 합친다. Work·Item은 PMT 분류(classification)로, 결정·backlog는 본문 `category`로 서비스를 표시한다.
  - 분류: `suite`, `j-auth`, `j-groupware`, `j-messenger`, `j-mail`, `j-customer-auth-db`, `j-approval`, `j-talk`, `j-web`, `j-game-client`
  - 이전 서비스별 project는 보관만 한다.
- 공통 결정은 이 문서의 S 번호로, 서비스 결정은 각 서비스 문서의 번호로 기록한다. 공통 작업은 분류 `suite`, Item 접두어 `X`를 쓴다.
- 서비스 사이에 걸친 Item은 `blocked_by`로 잇고, 진행은 직렬로 한다(사용자). 순서는 5장이다.

<a id="s17"></a>
### S17. 알림 통합
- **결정 (사용자):** 알림은 j-groupware 한 곳에서 처리한다. 서비스는 서비스 종류와 내용을 보내고, j-groupware가 종류와 내용에 맞게 알림을 표시한다. 서비스마다 따로 알림 기능을 만들지 않는다.
- **수신 API (j-groupware 결정 15):**
  - `POST /internal/notifications`는 loopback 내부 포트에서만 받는다. gateway에 노출하지 않는다.
  - 서비스별 내부 키 `X-JGW-Internal-Key`가 필요하다. 설치 스크립트가 서비스마다 만들어 넣는다.
  - 본문: `service`, `type`, `tenant`, 받는 사람(`members` 회원 id 목록, `usernames`, 또는 `role` 하나), `title`, `body`(텍스트, 1KB 이하), `link`(j-groupware 화면 경로), `dedupKey`.
- **표시:**
  - j-groupware는 서비스별 알림 종류 표(종류 → 아이콘·이름·문구 틀)로 알림을 그린다. 상단 알림 아이콘에 읽지 않은 수를 띄우고, 목록·읽음 처리를 제공한다.
  - 새 알림은 SSE로 실시간 전달한다. 보관 기간은 30일이다.
  - 받는 사람이 `role`이면 그 role을 가진 회원에게 보인다.
- **보내는 서비스(첫 범위):**
  - j-approval: 결재 차례, 승인·반려 결과
  - j-talk: 새 문의(`talk:read`), 배정(담당자)
  - j-mail: 새 메일(수신자 username)
  - j-messenger는 자체 읽지 않음 표시가 있어 이후 범위다.
- **보내는 쪽 규칙:** 서비스는 자기 outbox에 알림을 기록하고, 별도 루프가 재시도하며 보낸다. 같은 `dedupKey`는 j-groupware가 한 번만 저장한다.
- **방향 예외:** 서비스 호출은 원래 j-groupware → 서비스 한 방향이다. 알림만 서비스 → j-groupware 방향을 허용한다. j-groupware는 알림을 받기만 하고 서비스를 다시 호출하지 않는다.
- **이유:** 알림 저장·표시·실시간 전달을 한 번만 만들고, 서비스는 "무슨 일이 있었는지"만 보낸다.

## 4. 서비스별 최소 범위

각 항목의 완료 기준을 PMT Work의 completion criteria로 쓴다. 세부는 각 서비스 문서에 있다.

### j-auth
- **범위:** Keycloak(Docker), 운영사 realm + 고객별 realm(OIDC client·로그인 테마·백채널 로그아웃), 회원 관리 API, 서비스 가입 API, 고객 realm 자동 생성 API, 서비스 카탈로그 contracts.
- **완료 기준:** 관리자·하위 회원이 Authorization Code 흐름으로 로그인해 역할 목록과 토큰 claim이 맞고, 회원 관리·가입·realm 생성 API가 실제 Keycloak에서 동작하는 테스트 통과.

### j-groupware
- **범위:** BFF 로그인, 하위 회원 관리, 게시판, 운영 콘솔(고객·계약·가입 서비스), 조직도, 모든 서비스 화면과 중계, gateway·서버 설치 스크립트.
- **완료 기준(W1):** 고객 관리자가 하위 회원에게 게시판 권한을 주면 그 회원만 게시판 메뉴가 보이고 글을 쓸 수 있다.

### j-messenger (기존)
- **범위:** 새 기능 없음. j-groupware가 전달한 토큰을 검증하는 내부 API로 바꾸고, SQLite에서 `jgw_messenger`로 옮기고, client 패키지를 레지스트리로 제공한다. mail 인증 모드 연결은 backlog(j-mail 결정 7).
- **완료 기준:** j-groupware 메신저 메뉴에서 같은 고객 소속 하위 회원끼리 대화 송수신.

### j-mail
- **범위:** 테스트 전용 메일 서버(Mailpit), 외부 발신 차단, `<username>@<tenant>.jgw.test` 주소, 받은편지함 API. 화면은 j-groupware "메일" 메뉴.
- **완료 기준:** 고객 서버 내부에서 보낸 메일을 j-groupware 메일 화면에서 확인, 외부 도메인 발신은 거부.

### j-customer-auth-db
- **범위:** 손님 정보 DB(CRUD), 손님 로그인 API, 확장 공개 API(API 키) + OpenAPI. 화면은 j-groupware "손님" 메뉴.
- **완료 기준:** 권한 있는 하위 회원이 화면으로 손님을 등록하고, 그 손님이 로그인 API로 인증되며, 외부 스크립트가 API로 목록을 조회.

### j-approval
- **범위:** 고객·하위 회원용 내부 전자결재 API. 문서 1종, 순차 N단계, 결재선은 j-groupware가 만들어 보낸다. 화면은 j-groupware "결재" 메뉴.
- **완료 기준:** `approval:use` 회원이 상신 → 결재선 지정자만 순서대로 승인/반려 → 작성자·결재자가 상태와 이력 조회, 다른 tenant는 보이지 않음.

### j-talk
- **범위:** j-messenger 서버 구조(outbox+WSS)를 줄여 복제한다. 손님은 위젯([S7](#s7))으로 문의하고, 하위 회원은 j-groupware "상담" 메뉴에서 배정·응대·종료한다.
- **완료 기준:** 위젯으로 보낸 손님 메시지가 j-groupware 상담 목록에 실시간 표시되고, 하위 회원이 배정·답장·종료 가능.

### j-web
- **범위:** 고객 서버에 그룹웨어와 분리된 사이트 호스팅(사이트 블록, SFTP/FTPS 계정)을 셋팅하고 템플릿 1종 정적 페이지를 배포한다. 외부 호스팅 업로드는 제외, DNS는 별도 관리. 화면은 j-groupware "웹 관리" 메뉴.
- **완료 기준:** `web:write` 회원이 도메인을 입력하면 사이트가 셋팅·배포되어 그 도메인으로 HTTPS에 열리고, SFTP·FTPS 업로드가 되며 평문 FTP는 거부된다.

### j-game-client
- **상태 (사용자):** 미정. 제일 마지막에 추가할 서비스다. 범위·완료 기준·대상 Git 서버·배포 대상은 그때 정한다.
- **처음 생각한 범위(참고):** 지정 Git 저장소의 태그 변경을 확인해 새 버전을 배포·롤백한다.

## 5. 구현 순서

직렬로 진행한다(사용자). 서비스 사이 선행은 PMT `blocked_by`로 건다.

| 순서 | 대상 | 앞 단계에서 필요한 것 |
| --- | --- | --- |
| 1 | 공통 X1 패키지 레지스트리 | 없음 |
| 2 | j-auth I1~I4 (OIDC client·테마 포함) | X1 |
| 3 | j-auth I6·I7·I8 (회원 관리, 가입, realm 생성) | I4 |
| 4 | j-groupware W1 + G23 토큰 축소 | j-auth I4·I6 |
| 5 | j-messenger 연결 + W5 | W1 |
| 6 | j-mail + W6 | W1 |
| 7 | j-customer-auth-db + W2 | W1 |
| 8 | j-approval + W3 | W1 |
| 9 | j-talk + W7 | W5(중계 코드), j-customer-auth-db |
| 10 | j-web + W8 | j-talk |
| 11 | 알림 W9 (j-groupware 알림 센터 + 각 서비스 송신) | W3, W6, W7 |
| 12 | 서비스 가입·프로비저닝 자동화 W4, VM 검증(G10, I5, 각 서비스 VM Item) | 각 서비스 완료 |
| 13 | j-game-client | 미정, 마지막 |

## 6. 공통 작업

공통 작업은 분류 `suite`에 둔다. 서비스 저장소에 코드가 있어도 여러 서비스가 함께 쓰는 Item은 여기서 링크한다.

| Item | 내용 | 코드 위치 | 선행 |
| --- | --- | --- | --- |
| X1 | 패키지 레지스트리 | j-groupware `tools/registry/` | - |
| G21 | 프로비저닝 에이전트 | j-groupware `deploy/agent` | G18, G17 |
| G22 | 알림 센터(S17) | j-groupware `apps/server`·`apps/web` | G4 |
| G11 | gateway | j-groupware `deploy/gateway` | G1 |
| G18 | 서버 설치·해지 스크립트 | j-groupware `deploy/provision-service` | G1 |
| G17 | 콘솔 가입 서비스 관리 | j-groupware `apps/console-*` | G7, j-auth I7 |
| I3 (일부) | 서비스 카탈로그 상수(j-auth 결정 13) | j-auth `packages/contracts` | I2 |

- **X1 세부:** Verdaccio 버전 고정 Compose(loopback), scope 8개 설정, 각 저장소 `.npmrc` 예시, 게시 스크립트, 저장소 백업 방법을 갖춘다.
- **X1 완료 기준:** `@j-auth/contracts` 테스트 버전을 게시하고 다른 저장소에서 정확한 버전으로 설치되는지 확인한다.

## 7. 저장소

- 저장소: `D:\workspace\test-space\github\<서비스>`, GitHub `wnwjdals7498/<서비스>`.
- 각 저장소 `.claude/settings.local.json`의 `PMT_SCOPE_ID`는 통합 project UUID를 가리킨다. 이 파일은 기기별 값이라 Git에서 제외한다.
- 통합 PMT project UUID와 이전 서비스별 project UUID는 8장 표에 적는다.
- 저장소마다 결정은 `docs/decisions.md`, 기능 목록은 `docs/features.md`에 둔다. j-messenger는 제품군 연결 기능만 `docs/suite-integration-features.md`에 둔다.

## 8. PMT

| 대상 | UUID |
| --- | --- |
| environment `j-groupware-suite` | `a08c9f99-14cc-4c59-a4a6-1669181da0dc` |
| 통합 project `j-groupware-suite` (repository `j-groupware` `5388b37e-6a64-4c2d-80ab-a1ee6e21e60c` 아래, 분류 10개) | `c43a2f51-34a8-4900-a0d2-7338d3c285fd` |
| 이전 project(보관): j-auth / j-groupware / j-messenger / j-mail | `3dbae127-2180-4787-863f-037421a21257` / `4b7567e1-d8a7-4a46-b556-a4973dcb4e32` / `52713d6c-fa28-4699-a9f7-f4723f4149bf` / `8144d327-0a0f-4c2e-94c2-687028657332` |
| 이전 project(보관): j-customer-auth-db / j-approval / j-talk / j-web | `70b997a8-e2ac-4102-8dbb-e76e3aec9467` / `f8bf6842-6cb3-4f35-8997-832291aeb5f4` / `8802d242-05ee-4538-bb8d-31a6bcb24607` / `0f74c3e3-ef72-49ce-aa3c-38e6658da3f4` |

이전 project에는 "보관됨, 통합 project로 이동" 기록만 더했고 레코드는 지우지 않았다. j-game-client는 이전 project 레코드가 PMT에 없어 분류만 만들어 두었다.

## 9. 아직 정할 것

- 패키지 레지스트리 비교는 2026-10-08에 끝냈고 기존 [S10](#s10) 원안을 유지한다. 현재 기기의 Docker 실기동 검증은 설치 금지로 차단되어 있다.
- 손님 수 등급별 실제 사양(측정 후, [S15](#s15)).
- j-game-client 전체(마지막에 추가).
