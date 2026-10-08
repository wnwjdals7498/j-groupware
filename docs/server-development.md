# 고객 BFF 개발·실행

G1 → G3 → G4 → G5의 서버 부분을 구현했다. `apps/server`는 고객 하나의 BFF이며, 운영 콘솔·서비스 중계·정식 웹 화면은 후속 범위다. Node 22.18 이상, PostgreSQL 18.6, 기존 j-auth의 Keycloak 26.8.0을 사용한다. 고정 패키지 버전과 무결성은 `package-lock.json`이 기준이다.

## 설치와 실행

S10에 따라 `@j-auth/contracts@0.1.0`, `@j-auth/token-verifier@0.1.0`은 loopback Verdaccio에서 설치한다. 형제 저장소 소스를 직접 참조하지 않는다. 기존 [레지스트리 안내](registry-workflow.md)를 따른다. 레지스트리가 준비된 환경에서 `.npmrc.example`을 `.npmrc`로 복사하고 `npm ci`를 실행한다. `.npmrc`와 자격 증명은 Git 대상이 아니다. 이번 클라우드에서는 실제 격리 Verdaccio에 두 패키지를 게시·설치하고, 캐시를 사용한 `npm ci --ignore-scripts --offline`도 확인했다. 공개 npm 게시를 수행하지 않았다.

`deploy/server.env.example`을 체크아웃 밖으로 복사해 값을 채운다. 실제 고객 secret과 TLS 개인키를 소스에 넣지 않는다. Keycloak 고객 realm의 confidential `j-groupware` client에 정확한 public origin의 `/auth/callback`, post-logout `/`, backchannel `/auth/backchannel-logout`을 등록해야 한다. DB와 역할은 각각 `jgw_groupware`이며, non-superuser·자기 DB만 CONNECT하는 전용 역할을 사용한다. 런타임은 시작할 때 SQL migration을 행 잠금이 아닌 advisory transaction lock으로 직렬 적용하고, 적용된 파일의 checksum 변경·다른 DB·superuser를 거부한다.

```sh
npm run build
node --env-file=/external/runtime/server.env apps/server/dist/main.js
```

서버는 `127.0.0.1:54233`에 HTTPS로만 수신한다. 인증서는 체크아웃 밖에 있어야 한다. public origin은 `https://gw.<tenant>.jgw.test`이고 포트 3001은 거부한다. reverse proxy는 등록된 Host를 전달해야 한다. forwarded header로 tenant·origin을 결정하지 않는다. 외부 Nginx·VM 설치와 배포는 이 변경에서 실행하지 않았다.

## 로그인·세션 계약

`GET /auth/login`은 5분짜리 서버 flow를 만들고 Authorization Code + PKCE S256으로 이동한다. callback은 flow 쿠키·state·tenant를 원자적으로 소비하고 ID token의 서명·issuer·audience·nonce·subject·sid와 access token을 검사한다. 동시 callback·재전송은 세션을 중복 생성하지 않는다. 취소·실패 후에는 새 로그인을 시작한다. 기존 정상 세션이 있는 브라우저의 취소는 그 세션을 지우지 않는다.

브라우저에는 `__Host-jgw-session`과 임시 `__Host-jgw-login` 쿠키만 보낸다. 두 쿠키는 Secure·HttpOnly·SameSite=Lax·Path=/이고 Domain이 없다. 세션 식별자의 SHA-256만 DB에 저장한다. access/refresh token은 서버 DB에만 둔다. `/api/me`는 tenant·sub·username·roles·메뉴·CSRF 토큰을 반환한다. 변경 요청에는 `x-csrf-token`과 정확한 Origin이 필요하다. 유휴 30분·최대 8시간, access 만료 30초 이내 갱신을 적용한다.

갱신은 PG 세션 행 잠금으로 직렬화한다. 실제 refresh 거절은 세션을 삭제하고 401, 통신·JWKS 장애는 503이다. 요청 전에 발생한 통신 실패는 rollback 후 재시도가 가능하다. Keycloak이 refresh를 이미 소비한 뒤 응답이 유실되면 결과를 확정할 수 없고, 후속 재시도에서 재로그인이 필요할 수 있다. 이를 성공·완전 복구로 간주하지 않는다.

`POST /auth/logout`은 CSRF 검사 뒤 로컬 세션을 지우고 RP logout URL로 303을 보낸다. 브라우저 JWT 노출을 피하기 위해 `client_id`와 등록된 redirect를 사용하므로 Keycloak의 로그아웃 확인 화면을 거친다. 실제 확인 POST와 refresh 거절을 통합 시험했다. backchannel은 서명·issuer·audience·iat·jti·sid·events와 nonce 부재를 검사한다. 같은 jti 재전송은 200으로 무변경 처리하며, tenant/sid에 맞는 세션만 삭제한다. sid tombstone과 생성/삭제 advisory lock으로 종료된 sid의 세션 재생성을 막는다. 세션 종료 hook은 준비했지만 실제 WSS·SSE 중계는 아직 없다.

## 권한과 게시판

`packages/permissions`의 카탈로그 기반 role 표를 메뉴 데이터와 route 검사에 함께 쓴다. 공개·OIDC·backchannel을 포함해 선언 없는 route는 등록 단계에서 실패한다. 메뉴가 없어도 API 직접 호출은 403이다. 서비스가 미구현인 메뉴의 화면까지 구현됐다는 뜻은 아니다.

`GET /api/board/posts`, `GET /api/board/posts/:id`는 `board:read`, `POST /api/board/posts`는 `board:write`가 필요하다. tenant는 서버 설정에서만 가져온다. 제목 1~200자, 본문 1~20,000자, 요청 전체 64 KiB 제한이다. tenant 등 추가 필드는 400이다. 생성 시 작성자는 인증된 sub다. 목록은 50개씩 `(created_at,id)` 내림차순이고 cursor는 DB 시각의 마이크로초 정밀도를 유지한다. 잘못된 cursor는 400, 다른 tenant 글은 404다. 정식 게시판 화면은 아직 없다.

## 검사와 격리 환경

```sh
npm run check
npm run test:registry
npm run test:integration
```

`check`는 build·테스트 타입 검사·단위 시험·lint·format이다. registry 시험은 실제 Node Verdaccio를 임시 디렉터리에 시작하며 4873이 사용 중이면 기존 registry를 건드리지 않고 실패한다. npm workspace 안의 지정 패키지 게시·중복 버전·금지 endpoint·ACL·백업을 검사한다.

BFF 통합은 기존 j-auth 격리 클라우드 환경을 선행으로 요구한다. 새 격리 runtime은 아래 순서로 준비한다. 기존 runtime을 재실행해 secret을 덮어쓰지 않는다.

```sh
node scripts/prepare-bff-cloud-tests.mjs
docker compose --env-file ../.suite-runtime/j-groupware/compose.env -f ../.suite-runtime/j-groupware/compose.yaml -p j-groupware-cloud-test up -d
node scripts/wire-bff-cloud-backchannel.mjs
npm run test:integration
```

env·TLS·PG volume·JSON 결과는 `/workspace/.suite-runtime`에 둔다. 테스트는 새 `bff-a-*`, `bff-b-*` realm을 실제 j-auth API로 만들고 자신의 fixture만 정리한다. 실제 Keycloak의 backchannel을 받는 테스트 서버만 private Docker bridge에 bind한다. compiled 운영 엔트리의 loopback HTTPS·재시작 후 세션 유지도 따로 시험한다. Node 테스트 DNS와 Keycloak 컨테이너의 exact fixture host 매핑, 해당 두 host와 gateway의 NO_PROXY, readonly private CA truststore를 사용한다. OS hosts·CA 저장소 변경과 TLS 검증 해제는 없다. wiring은 격리 Keycloak 컨테이너만 재생성하고 데이터를 유지한다.

실행 결과와 미실행 인수 범위는 [클라우드 BFF 검증 기록](cloud-bff-verification-2026-10-08.md)을 따른다.

## 하위 서비스 token exchange (G23)

서버 controller는 `app.services.request(sessionCookie, serviceId, path, options)`를 사용한다. `JGW_SERVICE_MAIL_URL` 등 catalog 이름을 대문자/밑줄로 바꾼 env로 명시적인 loopback origin을 설정한다. 현재 제품별 controller는 아직 없으며 이 함수의 token을 브라우저에 보내지 않는다. 고정 목적지·단일 audience·PG cache·refresh/취소 계약과 실제 검증 범위는 [G23 기록](cloud-token-exchange-verification-2026-10-08.md)을 따른다.
