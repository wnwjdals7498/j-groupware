# 클라우드 gateway 구현·검증 (2026-10-08)

범위는 G11의 GW-60·GW-61·GW-62다. `/workspace/j-groupware`, 작업 브랜치 `codex/cloud-auth-foundation-20261008`에서 진행한다. 회사 노트북 설치, 운영 gateway 적용, 원격 배포·PR·main 병합은 실행하지 않는다. 인증 준비·PG/BFF 작업 결과는 기존 기록을 유지한다.

## 구현

`deploy/gateway`에 기본 설정·tenant 템플릿·TLS 조각·외부 env 프로파일 검증·실제 whitelist envsubst·검증/반영 CLI를 추가했다. 가입한 외부 경로만 loopback 서비스로 중계하고 내부 알림 경로를 막는다. 미가입 상담 위젯의 빈 JS 응답도 rate/connection 제한을 통과하며 429를 명시한다. 실제 상대 IP를 사용하고 안전한 access 로그를 둔다.

설정 root 잠금·원자적 파일 쓰기·변경 없을 때 reload 생략·nginx -t 실패 복구·reload 결과 실패 뒤 이전 설정 재검증/reload를 구현했다. j-web 소유 파일은 보존한다. bootstrap·서비스 설치/해지·운영 콘솔과 가입 상태 취득은 후속 작업이다.

## 실행 증거

실제 Nginx1.30.5, 이미지 `nginx@sha256:9bf97bd7714f5e24c1ccd545ecb9eb5435cb6d109c97cebb15e7e455e0239edb`, OpenSSL3.5.7, Node24.19.0 및 Node22.18.0을 사용했다. 컨테이너는 현재 uid, read-only root, capability 제거이며 gateway/upstream은 loopback에만 bind했다. 임시 TLS는 fixture이며 종료 시 설정·키·테스트 컨테이너를 제거했다. 기존 auth/서비스 PG 컨테이너를 유지했고 host 설정·systemd·방화벽은 변경하지 않았다.

| 실행 | 관찰·종료 |
| --- | --- |
| `JGW_GATEWAY_TEST_RUNTIME=isolated-cloud npm run test:gateway` | 실제 Nginx 13/13, 실패·cancel·skip0, exit0 |
| 같은 marker + Node22.18.0 `node --test tests/gateway/gateway.integration.test.mjs` | 실제 Nginx 13/13, 실패·cancel·skip0, exit0 |
| `npm run check` | build·typecheck·단위65/65·lint·format 통과, exit0 |
| 확장 `npm run lint`, `npm run format:check` | 새 gateway 코드·시험 포함 통과, exit0 |
| `JGW_TEST_ENV=/workspace/.suite-runtime/j-groupware/messenger-pg.env npm run test:integration` | 실제 Keycloak/j-auth·전용PG·BFF 전체114/114, 실패·skip0, exit0 |

외부 결과: `/workspace/.suite-runtime/j-groupware/gateway-tests.log`, `gateway-node22.log`, `gateway-check.log`, `gateway-bff.log`, `gateway-bff-results.json`. 재현 fixture와 결과는 클라우드 전용이다. 최종 코드 커밋은 이 문서를 포함한 작업 브랜치에서 확인하며 원격 CI 미실행과 로컬 통과를 구별한다.

`tests/gateway/gateway.integration.test.mjs`는 실제 envsubst/nginx -t, host·HTTPS redirect, TLS upstream 검증, 내부 경로 거절, 가입 서비스 경로·URI, BFF/talk WSS echo, 미가입 empty widget, 요청429와 WSS 연결429, Nginx 검증 실패·reload 결과 실패 복구, 동시 잠금·멱등, 입력/경로 거절, 외부 env CLI와 로그 비노출을 검사한다. upstream 3개는 프로토콜 fixture다. 이 결과를 실제 j-talk/j-customer-auth-db 업무 인수로 기록하지 않는다.

reload 명령이 exit0을 반환해도 master가 새 포트 bind에 실패할 수 있다. 13번째 시험은 실제 충돌 포트를 열어 `nginx -t`·signal exit0 뒤 새 세대가 반영되지 않는 상황을 만들었다. bounded HTTPS 세대 관찰이 실패를 감지하고 원본 파일·이전 세대를 실제로 복구했으며 기존 HTTP308·HTTPS200이 유지됐다. 이전에 관찰 없이 성공을 보고할 수 있었던 경계를 보강했다.

첫 시험은 fixture Docker envsubst에 stdin 옵션이 빠져 빈 출력이 생겨 setup 실패(12 cancelled)했다. 옵션 수정과 빈 렌더링 결과 거절을 추가했다. 다음 setup은 read-only container의 Nginx 기본 fastcgi temp 디렉터리 생성 때문에 실패했고, 모든 Nginx temp 경로를 owned root로 옮겼다. 이어 11통과·1실패는 rate 값 변경 후 실제 shared quota가 reload를 넘어 남은 상태에서 정상 요청을 너무 빨리 기대한 시험이었다. quota 회복을 확인한 뒤 과부하를 보내는 방식으로 고쳤다. 이 실패들을 통과로 취급하지 않는다.

## 남은 인수

GW-T16의 실제 프로토콜/격리 gateway 범위와 실제 고객 VM 배포·서비스 설치·전체 업무·브라우저 인수를 구별한다. GW-63/64/65, GW-54와 GW-66의 콘솔 원본 계약·운영 키·실제 설치기 연결은 아직 완료되지 않았다. G11을 VM 인수 전체 완료로 표시하거나 SU-T09를 통과로 표시하지 않는다. 정식 UI 가이드 문서도 여전히 없다.

공식 기준: [Nginx limit_req](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html), [limit_conn](https://nginx.org/en/docs/http/ngx_http_limit_conn_module.html), [WebSocket 중계](https://nginx.org/en/docs/http/websocket.html), [설정 검사·reload](https://nginx.org/en/docs/beginners_guide.html). 기본 제한 응답이 503이므로 본 구현은 두 지시자에 429를 명시한다. WebSocket hop-by-hop 헤더는 직접 넘기며 실패한 reload가 성공으로 보고되지 않도록 반영 결과를 검사한다.

## 2026-10-08 첨부 크기 후속

[첨부 BFF 후속](cloud-messenger-files-verification-2026-10-08.md)에서 정확한 메신저 업로드 경로의 wire 상한만5,065,536 bytes로 확장했다. 다른 API의1MiB 제한은 유지하며 실제 Nginx 정상 첨부 전달·초과413·다른 API413을 추가해 Node22·24 각각14/14를 검증했다. 기존13개 프로토콜 검증과 운영 VM 미완료 경계는 유지한다.
