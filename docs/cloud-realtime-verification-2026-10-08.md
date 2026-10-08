# 클라우드 실제 WSS/SSE 세션 종료 검증 — 2026-10-08

G15 `b15a700570b8dfdde84d47af3cbbfe74ad0c1623` 이후 연결 수명 관리와 WSS 중계·SSE 전송 채널을 구현했다. 같은 작업 브랜치와 격리 Keycloak·j-auth·PostgreSQL을 사용한다. 운영 데이터·자격·회사 노트북·OS hosts/CA는 변경하지 않았다.

## 서버 계약

- `GET /api/messenger/ws`: HTTPS 서버의 WSS upgrade. 기존 쿠키 세션과 `messenger:use`, 정확한 Origin을 검사한다. query 필드는 허용하지 않는다. 서버 설정 `JGW_SERVICE_MESSENGER_URL`의 고정 loopback origin과 `/api/v1/events`로만 연결한다. redirect를 따르지 않는다. G23의 갱신·단일 audience `j-messenger` 토큰을 서버에서 붙이고 브라우저 쿠키·Authorization·Origin·임의 경로를 넘기지 않는다.
- `GET /api/notifications/stream`: 쿠키 세션의 실제 SSE 전송 채널. 연결 확인/keepalive 주석만 보내며 알림 업무 이벤트·수신 API·저장·읽음 필터는 아직 연결하지 않았다. Origin이 있으면 정확한 origin만 허용한다. GET에 query로 token/tenant를 받지 않는다.

Fastify의 동일 권한 표와 session guard를 사용한다. 인증·역할·Origin·설정·token exchange 실패는 upgrade 전에 안전한 HTTP 오류로 처리한다. upgrade 뒤 하위 연결 실패는 1011, 세션 종료는 1008, 정상 peer 종료는 1000으로 종료한다. 원래 token으로 우회하거나 upstream 오류 이유를 브라우저로 복사하지 않는다.

WSS 양방향 프레임을 보존하고 비동기 작업 전에 message handler를 붙인다. 프레임·송신 buffer는 1 MiB, 초기 대기 queue는 64개/1 MiB, upstream handshake는 5초다. 느린 소비자는 종료한다. transport 연결은 인스턴스당 1000개·세션당 8개로 제한한다. SSE buffer는 64 KiB, keepalive는 15초다. 연결 유지나 keepalive로 기존 DB의 last_seen을 갱신하지 않으며 기존 인증된 HTTP 요청의 유휴 30분·최대 8시간 정책을 그대로 적용한다. 새 WSS 연결에서는 실제 refresh/token exchange를 수행한다.

## 커밋과 다중 인스턴스

`005-realtime-session-events.sql`은 세션 DELETE와 roles 값 변경에 transactional PG NOTIFY를 추가한다. payload는 tenant와 session hash뿐이다. commit된 변경만 전달하며 rollback에서는 종료 이벤트를 만들지 않는다. 같은 인스턴스의 기존 종료 hook도 즉시 연결을 정리한다. 다른 인스턴스는 동일 DB의 LISTEN을 통해 자기 tenant/hash 연결만 닫는다.

인스턴스마다 전용 listener 1개를 사용한다. 연결 등록 전에 listener를 준비하고, 연결을 등록한 뒤 DB의 세션·역할·수명을 다시 검사해 handshake 중 삭제를 놓치지 않는다. 1초 주기의 DB 재확인으로 만료나 이벤트 누락을 보완한다. DB 조회 또는 listener가 실패하면 열린 연결을 닫는다. listener를 잃은 뒤 새 연결을 받기 전에 다시 LISTEN하며 readiness도 이를 확인한다. DB 응답이 지연되면 기존 5초 statement timeout의 영향을 받으므로 1초가 장애 상황의 절대 종료 보장은 아니다.

Fastify preClose에서 열린 WSS/SSE와 listener/timer를 정리한다. WSS close handshake가 완료되지 않으면 250 ms 뒤 terminate한다. SIGTERM으로 compiled 프로세스를 종료할 때도 실제 소켓이 닫히는 것을 확인했다.

## 실제 실행 결과와 한계

- `npm run check`: build·테스트 타입 검사·단위 **48/48**·lint·format 통과.
- `npm run test:integration -- --reporter=json --outputFile=…`: 전체 **63/63**, 실패·미실행 0. 기존 실제 BFF 52개와 실시간 11개다.
- 변경된 lockfile의 `npm ci --ignore-scripts --offline`: 성공. `npm run test:registry`: 격리 Verdaccio **1/1**, 실패·미실행 0.

실시간 시험은 실제 TLS WSS 프레임과 HTTP SSE body, 실제 Code/PKCE·Keycloak 토큰 갱신·서비스 토큰, 실제 PG LISTEN/NOTIFY를 사용한다. 같은 논리 origin의 BFF 두 인스턴스에서 동일/별도 세션을 열어 로그아웃·권한 회수·실제 Keycloak backchannel·직접 DB 폐기·만료·listener 종료를 검사했다. 다른 회원/tenant 유지, foreign cookie·Origin·role·query 거절, rollback 후 연결 유지, logout 중 늦은 token exchange, compiled 프로세스의 정상 종료와 로그 비밀값 비노출도 확인했다.

WSS 하위 peer는 `ws`를 쓰는 격리 전송 규약 시험 장치이며 실제 Keycloak JWT의 서명·tenant·단일 audience·role을 확인한다. **j-messenger 업무 서버를 실행한 시험이 아니다.** 이 장치의 frame 왕복을 실제 메신저 대화·outbox·PostgreSQL 이전·S12 서비스 인수 성공으로 표시하지 않는다. 기존 j-messenger에는 아직 j-auth/PG 통합이 없어 실제 제품 중계 인수는 M1/M5/G12 후속이다. SSE 역시 실제 연결 수명만 검증했고 GW-T13 알림 수신/저장/필터/재송신 인수는 미실행이다.

원본은 체크아웃 밖 `/workspace/.suite-runtime/j-groupware/realtime-check.log`, `realtime-integration-results.json`, `realtime-ci.log`, `realtime-registry.log`다. 문서 검사는 `realtime-spec-validation.json`에 따로 저장한다. j-auth는 `1a8c09e933ab6de6fc953592ddda8cd9015620b9`이며 선행 실제 63개를 이미 실행했고 이번 묶음에서 코드를 바꾸지 않았다.

UI 기준 `docs/ui-guidelines.md` 부재·정식 화면/Playwright·VM/Nginx 인수는 별도 미검증이다. `whole_suite_verified=false`이며 PR·main 병합·배포를 하지 않았다.

## 의존성 근거

`@fastify/websocket@11.3.1`은 Fastify 5 hook을 사용하는 WS route를, `ws@8.22.0`은 server-side upstream client를, `@types/ws@8.18.2`는 타입 검사를 담당한다. 정확 버전과 integrity를 lockfile에 고정했다. [Fastify 공식 WS 문서](https://github.com/fastify/fastify-websocket)의 hook·동기 handler 등록 계약과 [ws 공식 문서](https://github.com/websockets/ws)의 Node client/server API를 확인했다. TLS 검증을 해제하지 않았다.
