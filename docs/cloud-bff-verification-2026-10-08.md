# 클라우드 BFF 구현·검증 기록 — 2026-10-08

`/workspace/j-groupware`의 별도 작업 브랜치 `codex/cloud-auth-foundation-20261008`에서 G1 → G3 → G4 → G5 서버 부분을 구현했다. j-auth의 `0fd0eb5bdf2bd012672f6701c2be8d6b14aa0e62`를 선행으로 사용했고, 이번 묶음에서 j-auth 소스는 변경하지 않았다. 기존 커밋·사용자 변경을 보존했다. 회사 노트북 설치 금지는 유지된다. 실행은 격리 클라우드 테스트이며 운영 배포가 아니다.

## 구현 범위

| 범위 | 실제 코드·동작 |
| --- | --- |
| G1 | npm workspace, contracts/permissions/server, HTTPS loopback 엔트리, 전용 PG role/DB 검사·checksum migration, health, 안전한 오류·로그 |
| G3 | 고객 realm Code + PKCE, 원자적 state 소비, nonce·ID/access 검증, PG 세션·CSRF, idle/max 제한, 직렬 refresh, RP logout, 서명된 backchannel, `/api/me` |
| G4 | j-auth 카탈로그의 roles로 메뉴 데이터·route 권한 표 구성, 선언 없는 route 등록 거부, 직접 API 403 |
| G5 서버 | tenant 격리 게시판 목록·작성·조회, bound SQL, 50개 cursor 페이지·마이크로초 정렬, 잘못된 입력 400·다른 tenant 글 404 |
| X1 보완 | workspace 내부 지정 패키지 게시 시 npm `--workspaces=false`, 실제 workspace fixture의 게시·금지 endpoint 검사 |

테마·사이드바·게시판 React 화면은 포함하지 않는다. `/`는 로그인 연결을 위한 기본 HTML이다. 메뉴 목록 반환은 사이드바 완성을 뜻하지 않는다. 세션 종료 hook은 구현·시험했지만 WSS/SSE 중계는 아직 없다.

## 실행 결과

| 명령 | 결과 | 실측 범위 |
| --- | --- | --- |
| `npm ci --ignore-scripts --offline --no-audit --no-fund` | 종료 0 | 고정 lockfile·기존 클라우드 캐시에서 workspace 설치 |
| `npm run check` | 종료 0, 단위 32/32 | build·테스트 타입 검사·RSA 토큰 경계 단위 시험·lint·format |
| `npm run test:integration -- --reporter=json --outputFile=…` | 종료 0, 16/16, 실패 0·미실행 0 | 실제 Keycloak·PostgreSQL·HTTPS BFF 시나리오 |
| `npm run test:registry` | 종료 0, 1/1 | Node Verdaccio 6.10.5의 실제 인증·게시·immutable 설치·ACL·endpoint 제한·백업 |
| j-auth `npm run test:integration -- --reporter=json --outputFile=…` | 종료 0, 61/61, 실패 0·미실행 0 | 기존 인증·회원·가입·provisioning 전체 회귀; backchannel 컨테이너 설정 변경 후 재검사 |

JSON 원본은 체크아웃 밖 `/workspace/.suite-runtime/j-groupware/integration-results.json`, `/workspace/.suite-runtime/j-auth/integration-results-phase3.json`에 저장하고 직접 확인했다. 이 개수는 상세 명세의 전체 인수 시험 개수와 같지 않다. j-auth의 이전 정적/단위 48개와 이번 실제 61개 회귀는 별도다. 문서 검사 역시 서비스 시험으로 세지 않는다.

## 실제 통합 16개 시나리오

1. dedicated non-superuser PG 신원, migration 동시 실행·재실행, 타 DB 접속 거절.
2. 실제 Keycloak Code/PKCE·callback·쿠키·브라우저 token 비노출·callback 재전송 거절.
3. 실제 HTTPS Host 오염·forwarded header·다른 브라우저 state·다른 tenant 쿠키 격리.
4. 동시 callback 2개 중 하나만 성공하고 PG 세션 1개 생성.
5. 기대 nonce 변경 시 실제 callback 거절, PKCE verifier 변경 시 Keycloak code 거절.
6. 로그인 flow 교체·취소·재사용·만료, 기존 정상 세션 보존.
7. 재로그인 cookie 변경, 이전 cookie 접근 거절.
8. CSRF 누락·다른 Origin 거절, 글 작성·조회, 다른 tenant 404·추가 tenant 필드 400.
9. 60개 이상 게시판 cursor 조회의 중복 경계, 잘못된 JSON·달력 날짜·시간·정밀도 cursor 400.
10. 실제 권한 없는 회원의 메뉴 제외·직접 API 403.
11. 실제 동시 요청 8개에서 refresh 1회, 새 access/refresh 저장.
12. 요청 전 transport 장애 주입 시 503·세션 보존, 실제 서버 재시도 성공.
13. 실제 Keycloak refresh 거절 시 세션 삭제·401, PG 시각 조정으로 idle/max 및 종료 hook 확인.
14. 실제 j-auth 권한 부여·회수 → Keycloak backchannel 네트워크 POST 200 → 대상 BFF 세션 삭제. 다른 회원·tenant 보존, 실제 서명 token 재전송 무변경 200·타 realm/변조 400, 재로그인 후 새 권한·API 결과 확인.
15. 실제 CSRF 로컬 logout·303 → Keycloak 확인 화면 POST → redirect·기존 refresh `invalid_grant`, 재사용 401.
16. compiled BFF loopback HTTPS 시작·종료·재시작, PG 세션 유지, 캡처한 서버 로그에 fixture secret·token 없음.

nonce·PKCE·만료 행 조정과 transport 장애는 의도적인 경계 주입이다. 서버 중단 장애나 Playwright 시험으로 표시하지 않는다. 새 무작위 fixture tenant를 실제 j-auth API에서 생성하고 자신이 소유한 realm·control-plane/BFF 행만 정리한다. 운영 계정·고객 데이터는 사용하지 않는다.

## 테스트 환경과 수정한 실패

별도 PostgreSQL 18.6은 `127.0.0.1:54232`로만 공개한다. 비밀 env·TLS 개인키·volume은 체크아웃 밖에 둔다. 초기 PG 스크립트 읽기 권한 오류를 수정하고 새 격리 volume으로 확인했다. 초기 빈 import 디렉터리는 보존했으며 기존 j-auth DB를 초기화하지 않았다.

Keycloak에서 backchannel을 받는 통합 서버만 private Docker bridge에 수신한다. compiled 엔트리는 loopback이다. 컨테이너의 두 정확한 fixture host DNS·NO_PROXY와 readonly BFF CA truststore를 Compose override에 지속한다. outgoing proxy로 인한 backchannel 403을 로그로 확인하고 해당 fixture 목적지만 로컬 경로로 보냈다. 기존 NO_PROXY 항목과 다른 목적지의 proxy를 보존했다. TLS 검증은 활성화하고 OS DNS·CA는 변경하지 않았다. 공식 [Keycloak truststore](https://www.keycloak.org/server/keycloak-truststore)와 [outgoing HTTP](https://www.keycloak.org/server/outgoinghttp) 설정을 기준으로 했다.

첫 registry 회귀는 이번 작업의 Verdaccio가 4873을 사용하여 안전하게 실패했다. 해당 fixture 프로세스만 종료했다. workspace fixture의 보조 `npm config get`에도 `--workspaces=false`를 적용하고 전체 시나리오를 재실행해 통과했다. 실패·미실행을 통과로 대체하지 않았다. 격리 registry에 실제 auth 패키지 두 개를 게시·설치했으며 공개 npm·운영 registry 게시는 아니다.

## 남은 범위

`docs/ui-guidelines.md`가 없어 정식 색상·타이포·간격·sidebar/폼 규격을 확인해야 한다. 기존 sidebar+본문 결정만으로 디자인을 임의 확정하지 않았다. 기본 Keycloak 화면의 HTTP 로그인·logout을 시험했지만 jgw theme·Playwright·brute-force 인수는 미실행이다. 이 부재가 서버 구현을 막지는 않았다.

다음 의존 작업은 G23 서비스별 token exchange·캐시·중계, G6 회원 관리 BFF/화면, G2/G9 UI 기준과 sidebar·게시판 화면이다. 실제 WSS/SSE 연결 종료, 운영 콘솔, gateway/Nginx, VM·설치/해지·에이전트·다른 서비스 통합은 미구현 또는 미검증이다. PR·main 병합·운영 배포는 실행하지 않았다.

세션 token은 전용 PG에 저장하므로 PG 파일·백업 접근 통제가 필요하다. Keycloak refresh가 소비된 뒤 응답이 유실되면 재로그인이 필요할 수 있고 원문 복구를 보장하지 않는다. RP logout은 JWT를 URL에 노출하지 않는 client_id 방식으로 Keycloak 사용자 확인을 요구한다([RP-Initiated Logout](https://openid.net/specs/openid-connect-rpinitiated-1_0.html)). 자세한 계약은 [서버 개발 안내](server-development.md)를 따른다.

추적표는 코드와 실행 범위를 구별하고 `whole_suite_verified=false`를 유지한다.
