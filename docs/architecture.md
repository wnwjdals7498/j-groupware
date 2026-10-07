# j-groupware 제품군 구성

소형 그룹웨어 제품군의 전체 구성, 서비스별 최소 범위, 구현 순서, PMT 운영 방식을 정리한다. 각 서비스는 **동작을 증명하는 최소 기능**만 만든다.

## 1. 회원 구조

| 계층 | 누구 | 주로 쓰는 서비스 |
| --- | --- | --- |
| 운영사 담당자 | 그룹웨어를 배포·판매하는 회사 직원. 고객·계약·인증 문제 관리 | j-groupware 운영 콘솔 |
| 고객 (tenant) | 그룹웨어를 구매한 회사. 관리자 계정 보유 | j-groupware 고객 관리, 권한 부여 |
| 하위 회원 | 고객 소속 직원. 고객이 준 권한에 따라 보이는 기능이 다름 | 게시판, j-messenger, j-mail, j-approval(내부 전자결재), j-talk 등 |
| 고객의 고객 (end customer) | 고객 회사의 손님 | j-customer-auth-db로 인증, j-talk 대상 |

- 운영사·고객·하위 회원 인증은 **j-auth(Keycloak)**가 담당한다.
- 고객의 고객 인증은 **j-customer-auth-db**가 담당한다. Keycloak과 분리해 고객이 자기 손님 데이터를 직접 소유·관리한다.

## 2. 전체 배치

```
                ┌────────────────────── 운영사 control plane ──────────────────────┐
                │ j-groupware 운영 콘솔 · 계약/고객 관리 · 프로비저닝                │
                │ j-auth (Keycloak: 운영사 realm + 고객별 realm)                    │
                └───────────────┬───────────────────────────────────────────────────┘
                                │ 고객 구매 → 예상 사이즈로 VM 생성
          ┌─────────────────────▼──────────── 고객별 VM (tenant plane) ───────────────┐
          │ gateway (Nginx) ── gw.<tenant> 하나만 외부 노출                             │
          │   ├─ j-groupware web (기본 서비스, 항상 설치)                              │
          │   ├─ j-messenger · j-mail · j-approval · j-talk  (가입한 서비스만 기동)    │
          │   └─ j-customer-auth-db (고객의 고객 DB/인증/API)                          │
          │ PostgreSQL 인스턴스 1개 ── 서비스마다 전용 database + 전용 계정            │
          └────────────────────────────────────────────────────────────────────────────┘
   별도 도구: j-web (웹호스팅 페이지 생성·배포), j-game-client (Git 버전 감시·배포)
```

- **VM 사이즈:** 고객이 신청한 "고객의 고객 수"로 등급을 정한다. 최초 기준안은 S(~1천), M(~1만), L(~10만)이다. 실제 vCPU/RAM 값은 j-groupware 프로비저닝 Item에서 측정 후 확정한다.
- **중계:** 고객 VM의 Nginx 하나가 외부 요청(`gw.<tenant>.jgw.test`)을 받아 j-groupware로 넘긴다. 다른 서비스는 VM 내부 포트로만 열리고 j-groupware 서버가 Bearer를 붙여 중계한다. j-messenger의 `deploy/nginx-lab.conf` 패턴을 재사용한다.
- **최소 구현 단계에서는** VM 생성을 수동 스크립트(또는 로컬 VM 1대)로 대신한다. 자동 프로비저닝은 j-groupware 후반 Item으로 둔다.

## 3. 공통 기술 기준

j-messenger와 같은 스택을 기본값으로 둔다. 서비스 간 지식과 코드를 그대로 옮기기 위해서다.

| 영역 | 기준 |
| --- | --- |
| 런타임 | Node 22.18+, TypeScript, npm workspaces (`apps/*`, `packages/*`) |
| 서버 | Fastify. 외부 명령·조회는 HTTPS, 실시간 사건은 WSS |
| 계약 | `packages/contracts`에 TypeBox schema·DTO·오류 코드 |
| 웹 UI | 모든 서비스는 백엔드 API만 두고, 웹·앱 화면은 j-groupware(React)가 표시한다(j-groupware 결정 22). 기준 UI 문서는 `docs/ui-guidelines.md`. j-groupware 앱은 backlog. 예외: 손님용 j-talk 상담 위젯(j-groupware 결정 23) |
| 외부 노출 | 고객 VM gateway는 `gw.<tenant>.jgw.test` 하나만 연다. 다른 서비스는 내부 포트로만 열고 j-groupware 서버가 중계한다(j-groupware 결정 17) |
| DB | 모든 서비스는 자기 PostgreSQL database를 가진다(아래 "서비스 가입 모델"). SQLite는 쓰지 않는다. 드라이버 `pg`, node-pg-migrate SQL 파일, SQL 직접 작성, 버전 정확히 고정(j-groupware 결정 6-2). Keycloak과 운영 콘솔 DB는 control plane PostgreSQL |
| 배포 | VM + Nginx + systemd. 서비스별 `deploy/` 폴더 |
| 인증 연동 | 모든 서비스는 j-auth가 돌려준 권한 목록으로 기능 노출을 결정 |
| 하위 서비스 호출 | j-groupware가 세션의 j-auth access token을 Bearer로 전달하고, 만료 30초 이내면 `POST /auth/refresh`로 갱신(j-groupware 결정 2). 최소 구현의 최종 방식이다. 이벤트·세션 기반 전환은 OIDC 전환 backlog |
### 서비스 가입 모델

2026-10-07 사용자 결정. 서비스 하나는 **API 서버 + 전용 PostgreSQL database** 한 쌍이다. j-groupware는 기본 서비스라 항상 설치되고, 나머지(j-messenger, j-mail, j-customer-auth-db, j-approval, j-talk)는 고객이 가입한 것만 켠다.

- **가입 시 일어나는 일:**
  1. 운영 콘솔에 고객의 가입 서비스가 기록된다(j-groupware 결정 20).
  2. 콘솔이 j-auth 서비스 활성화 API를 호출한다. j-auth는 그 고객 realm에 서비스 client, 기능 role, aud mapper, scope mapping을 추가하고 `tenant:admin` 묶음과 부여 가능 role 목록에 넣는다(j-auth 결정 25). 해지하면 반대로 제거한다.
  3. 고객 VM 설치 스크립트가 PostgreSQL에 그 서비스의 database와 전용 계정을 만들고, 서비스를 기동하고, gateway 조각을 설치한다(j-groupware 결정 20). 최소 구현에서는 수동 실행이고, 자동화는 프로비저닝 backlog다.
  4. j-groupware 메뉴와 중계 API는 회원의 roles로 열린다. 가입하지 않은 서비스의 role은 realm에 없으므로 메뉴·API·권한 부여 항목이 자연히 닫힌다.
- **DB 단위 (A안):** 고객 VM의 PostgreSQL 인스턴스 1개에 서비스마다 database `jgw_<서비스>`와 전용 계정을 둔다.
  - 전용 계정은 자기 database에만 접속한다(`PUBLIC`의 `CONNECT` 회수). 계정별 접속 수 제한과 `statement_timeout`을 둔다.
  - 서비스는 자기 `DATABASE_URL` 하나만 알고, 다른 서비스의 database를 직접 조회하지 않는다. 필요한 데이터는 상대 서비스의 API로 받는다.
  - 마이그레이션은 각 서비스 저장소에 둔다. 백업은 서비스 단위 `pg_dump`를 기본으로 한다.
  - 이 규칙을 지키면 큰 고객이나 무거운 서비스를 전용 인스턴스로 옮길 때 덤프·복구 후 `DATABASE_URL`만 바꾸면 된다. 분리 기준은 프로비저닝 Item의 측정 후 정한다.
  - 이유: 소형 VM에서 인스턴스를 서비스 수만큼 띄우면 메모리·백업·패치가 배로 늘고, 가입 자동화 단계가 많아진다. 데이터 분리는 database와 계정으로 충분하다.

## 4. 서비스별 최소 범위

각 항목의 "완료 기준"을 PMT Item의 completion criteria로 그대로 쓴다.

### j-auth
- **범위:** Keycloak 기동(Docker), 운영사 realm 1개 + 샘플 고객 realm 1개, 역할 매핑. 로그인 API 하나.
- **API:** `POST /auth/login {tenant, username, password}` → `{ok:false}` 또는 `{ok:true, roles:[...], access token}`. 로그인 결과, 권한 목록, 각 서비스가 Keycloak 공개키로 검증할 access token을 반환한다. 토큰 필드명은 j-auth `packages/contracts`에서 정한다(j-auth 결정 6).
- **완료 기준:** 관리자·하위 회원 계정으로 성공/실패와 역할 목록이 맞게 돌아오는 테스트 통과.
- **주의:** 비밀번호를 직접 받는 방식(ROPC)은 OAuth 2.1에서 제외됐다. 최소 구현에만 쓰고, 이후 각 서비스는 Keycloak Authorization Code(OIDC) 흐름으로 옮긴다.

### j-groupware
- **범위:** 웹서버-DB 1쌍, j-auth 로그인, 고객 관리자용 하위 회원 관리(추가·권한 부여), 게시판(글 목록/작성/조회), 운영사 콘솔(고객 목록·계약 상태).
- **UI 기준 문서:** `docs/ui-guidelines.md`에 색·간격·타이포 토큰, 레이아웃(사이드바+본문), 공통 컴포넌트(표, 폼, 버튼, 모달, 빈 상태, 오류) 정의. 다른 서비스는 이 문서를 따른다.
- **완료 기준:** 고객 관리자가 하위 회원에게 게시판 권한을 주면 해당 회원만 게시판 메뉴가 보이고 글을 쓸 수 있다.

### j-messenger (기존)
- **범위:** 새 기능은 만들지 않는다. j-groupware가 전달한 j-auth 토큰을 검증하는 내부 API로 바꾸고, 화면은 `client-core`·`client-react` 패키지를 j-groupware "메신저" 메뉴 안에서 렌더링한다. WSS도 j-groupware가 중계한다(j-groupware 결정 15·22). 자체 web·desktop·android 앱은 동결한다. 서비스 가입 모델에 맞춰 저장소를 SQLite에서 PostgreSQL database `jgw_messenger`로 옮긴다(j-groupware 결정 20, Item M5).
- **완료 기준:** j-groupware 메신저 메뉴에서 같은 고객 소속 하위 회원끼리 대화 송수신.
- **연결점:** README의 "실제 메일 인증"(mail 인증 모드) 연결은 backlog로 둔다. j-mail이 쓰는 Mailpit에는 메일 계정과 IMAP이 없기 때문이다(j-mail 결정 4). j-messenger는 `AUTH_MODE=j-auth`를 쓴다(j-groupware 결정 15).

### j-mail
- **범위:** 테스트 전용 메일 서버. 외부 발신 차단, hosts 수정으로 임시 도메인(예: `*.jgw.test`) 사용. Mailpit 같은 캡처형 SMTP를 써서 직접 만들 부분을 최소화한다.
- **주소와 화면:**
  - 메일 주소는 `<username>@<tenant>.jgw.test`이다(j-mail 결정 5).
  - j-mail 서버가 Mailpit REST API를 감싼 받은편지함 API를 내부 포트로 제공한다. `mail:read`와 tenant를 검사한다(j-mail 결정 2·6).
  - 화면은 j-groupware "메일" 메뉴다(j-groupware 결정 19·22). Mailpit 웹 UI는 노출하지 않는다.
- **완료 기준:** 고객 VM 내부에서 보낸 메일을 j-groupware 메일 화면에서 확인, 외부 도메인 발신 시도는 거부.

### j-customer-auth-db
- **범위:** 고객의 고객 정보 DB(CRUD), 로그인 API, 확장용 공개 API(API 키 인증) + OpenAPI 문서. 관리 화면은 자체 web 앱 없이 j-groupware "손님" 메뉴로 둔다(j-customer-auth-db 결정 3, j-groupware 결정 18).
- **완료 기준:** 권한 있는 하위 회원이 UI로 손님을 등록하고, 그 손님이 로그인 API로 인증되며, 외부 스크립트가 API로 목록을 조회.

### j-approval
- **범위:** 고객과 하위 회원을 위한 내부 전자결재 백엔드 API. 문서 1종, 순차 N단계. 결재선은 j-groupware가 조직도로 산출하거나 작성자가 커스텀 지정해 상신 요청에 담아 보낸다. 화면은 j-groupware "결재" 메뉴다(j-approval 결정 1·2·4, j-groupware 결정 21). 손님은 관계없다.
- **완료 기준:** `approval:use`를 가진 하위 회원이 문서를 상신 → 결재선 지정자만 순서대로 승인/반려 → 작성자·결재자가 상태와 이력 조회, 다른 tenant는 보이지 않음.

### j-talk
- **범위:** j-messenger 서버 구조(outbox+WSS)를 복제·축소. 손님이 문의를 남기면 권한 있는 하위 회원이 전체 문의방을 보고 배정·응대·종료.
- **손님 화면:** 삽입형 상담 위젯(js·css)이다(j-groupware 결정 23). 고객 웹사이트 오른쪽 아래에 항상 떠 있는 버튼을 누르면 대화창이 열린다. 익명으로 시작하고, j-customer-auth-db 손님 로그인은 선택이다. 위젯과 손님 API·WSS는 `gw.<tenant>.jgw.test/ext/talk/`에서 제공한다. 하위 회원 상담 화면은 j-groupware 메뉴다.
- **완료 기준:** 위젯으로 보낸 손님 메시지가 j-groupware 상담 목록에 실시간 표시되고, 하위 회원이 배정·답장·종료 가능.

### j-web
- **범위:** 웹호스팅(카페24 등) 도메인과 접속 정보를 받아 템플릿 1종으로 정적 페이지를 만들고 업로드. 고객이 j-talk에도 가입했으면 페이지에 상담 위젯 스니펫을 자동으로 넣고, 사이트 도메인을 위젯 허용 출처로 등록한다(j-groupware 결정 23).
- **완료 기준:** 테스트 호스팅(또는 로컬 SFTP/FTP 대역)에 페이지가 배포되고 도메인으로 열린다.
- **주의:** 호스팅 접속 정보는 저장소·로그에 남기지 않고 고객 VM의 비밀 저장소에서만 읽는다.

### j-game-client
- **범위:** 지정 Git 저장소의 태그/릴리스 변경을 주기적으로 확인하고, 새 버전을 받아 대상 폴더에 배포·이전 버전으로 되돌리기.
- **완료 기준:** 테스트 저장소에 새 태그를 만들면 client가 감지해 배포하고, 버전 기록과 롤백이 동작.

## 5. 구현 순서와 의존성

| 순서 | 서비스 | 앞 단계에서 필요한 것 |
| --- | --- | --- |
| 1 | j-auth | 없음 |
| 2 | j-groupware | j-auth 로그인 API |
| 3 | j-messenger 연결 | j-auth, j-groupware 메뉴·gateway |
| 4 | j-mail | 고객 VM gateway, 임시 도메인 |
| 5 | j-customer-auth-db | j-auth(guest 권한), j-groupware 손님 메뉴(G13) |
| 6 | j-approval | j-auth(결재 권한), j-groupware 조직도·결재 화면(W3) |
| 7 | j-talk | j-messenger 서버 구조, j-customer-auth-db |
| 8 | j-web | UI 기준 문서 |
| 9 | j-game-client | 독립. 마지막에 둠 |

j-web과 j-game-client는 의존성이 적다. 앞 단계가 막히면 병렬로 당겨도 된다.

## 6. 저장소와 PMT 운영

- 저장소: `D:\workspace\test-space\github\<서비스>`, GitHub `wnwjdals7498/<서비스>`.
- PMT 계층: environment `j-groupware-suite` → 서비스별 repository → 서비스별 project.
- 각 저장소의 `.claude/settings.local.json`에 `PMT_SCOPE_ID`(project UUID)가 들어 있다. 이 파일은 기기별 값이라 Git에서 제외한다.
- 서비스마다 PMT에 "요구사항 트리 + 위 완료 기준"을 먼저 저장하고, 작업은 Item claim → 증거 기록 → finish 순서로 진행한다.

| 서비스 | PMT project UUID |
| --- | --- |
| environment `j-groupware-suite` | `a08c9f99-14cc-4c59-a4a6-1669181da0dc` |
| j-auth | `3dbae127-2180-4787-863f-037421a21257` |
| j-groupware | `4b7567e1-d8a7-4a46-b556-a4973dcb4e32` |
| j-messenger | `52713d6c-fa28-4699-a9f7-f4723f4149bf` |
| j-mail | `8144d327-0a0f-4c2e-94c2-687028657332` |
| j-customer-auth-db | `70b997a8-e2ac-4102-8dbb-e76e3aec9467` |
| j-approval | `f8bf6842-6cb3-4f35-8997-832291aeb5f4` |
| j-talk | `8802d242-05ee-4538-bb8d-31a6bcb24607` |
| j-web | `0f74c3e3-ef72-49ce-aa3c-38e6658da3f4` |
| j-game-client | `0689e174-004c-4423-ad64-1e4b5ef323dd` |

## 7. 아직 정할 것

- ~~VM 생성 수단~~ **확정:** Hyper-V. 로컬에서 먼저 완료한 뒤 Hyper-V VM에서 다시 검증한다(j-auth 결정 12, j-groupware 결정 12).
- ~~Keycloak 고객 분리 방식~~ **확정:** 고객별 realm. 운영사 realm 1개 + 고객별 realm(j-auth 결정 3).
- 큰 고객은 서비스별로 분리할지. 기본값은 **확정:** 고객 VM 하나에 가입 서비스를 같이 올리고 PostgreSQL 인스턴스 1개를 공유한다(3장 서비스 가입 모델). 전용 인스턴스·VM 분리 기준은 프로비저닝 Item에서 측정 후 정한다.
- j-game-client 대상 Git 서버 종류(GitHub, Gitea 등)와 배포 대상(Windows 폴더, 서버).
- j-web 대상 호스팅의 업로드 방식(FTP/SFTP/API).
