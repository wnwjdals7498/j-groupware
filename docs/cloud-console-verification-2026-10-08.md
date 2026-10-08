# GW-50 운영 콘솔 인증

고객 앱과 별도 `apps/console-server`, private `packages/bff-auth`, jgw_console migration을 구현했다. 공통 OIDC·세션·cookie/CSRF·오류 코드는 packages가 소유하고 기존 고객 서버는 같은 패키지를 재사용한다. 공유 OIDC는 고객 j-groupware 또는 operator j-console client를 고정해 issuer·azp·aud·nonce를 검증한다. 고객 설정의 허용 tenant 검사는 그대로 유지한다.

콘솔은 operator realm Authorization Code + PKCE S256, server-side state/nonce/verifier, 별도 `__Host-jgw-console-*` cookie와 DB를 사용한다. operator customer:read가 있어야 세션을 만들고 조회한다. customer:write 복합 role도 조회 가능하다. 만료 전 refresh는 기존 행 잠금으로 직렬화하며 새 token·role을 저장한다. POST logout은 CSRF를 요구하고 j-console RP logout으로 이동한다. 서명·issuer·aud·sid·events를 확인한 backchannel은 해당 세션만 종료하며 재전송은 멱등이다. 선언 없는 route는 등록 단계에서 거절한다. 고객 목록/등록·서비스 가입·에이전트 API와 정식 콘솔 화면은 아직 없다.

외부 env는 JGC_PUBLIC_ORIGIN(등록된 console.jgw.test HTTPS), JGC_PORT, JGC_CLIENT_SECRET, JGC_DB_HOST/DB_PORT/DB_PASSWORD, JGC_TLS_CERTIFICATE/TLS_KEY, KC_PUBLIC_URL이다. DB 이름·role은 jgw_console로 고정한다. `node --env-file=/external/console.env apps/console-server/dist/main.js`로 loopback에서 실행한다. client secret·DB·TLS key는 checkout 밖에 둔다. control-plane Nginx에 콘솔 경로를 실제 적용하지 않았다.

검증은 실제 operator op-admin·Keycloak·별도 PG, PKCE/nonce/cookie/DB 격리, 고객 cookie 거절·403·상태/issuer/nonce·code 재사용, 동시 refresh 1회, CSRF/RP logout, Keycloak의 실제 operator backchannel 및 재전송, 실제 DB stop/start 보존, compiled HTTPS startup/SIGTERM을 다룬다. test operator client의 callback/backchannel만 일시 변경하고 기존 전체 설정을 finally에서 복원한다. 기존 고객 realm·계정과 회사 노트북 설정은 건드리지 않는다. 테스트용 console CA/DNS는 기존 cloud Keycloak container에만 추가했고 TLS 검사는 켜져 있다.

실제 test DB는 55052, private bridge console 55053, compiled loopback 55054다. 최초 전체 회귀는 새 DB가 기존 54246/54252 시험 포트와 충돌해 115 pass·1 fail·16 skipped였다. 통과로 취급하지 않고 결과를 `.suite-runtime/j-groupware/ready-console-bff-port-collision-results.json 및 ready-console-bff-port-collision.log`에 보존했다. 새 fixture만 포트를 옮겨 데이터 volume을 보존하고 전체 검증을 재실행했다. 최종 결과는 `ready-console-bff-full-results.json`, `console-node{22,24}-final-results.json`에 기록한다. VM·정식 UI·외부 Nginx 인수와 제품군 전체 인수는 미실행이다.

최종 실행: Node 24.19.0의 실제 BFF 전체 133/133, Node 22.18.0·24.19.0의 console 각 8/8, 최종 `npm run check`(기존 unit 74개·build·typecheck·lint·format) 모두 exit 0으로 통과했다. 누락/skip은 0개다. source를 공통 패키지로 옮긴 뒤 기존 고객 BFF·회원·organization·메일·메신저·알림·WSS/SSE까지 다시 실행한 결과다.
