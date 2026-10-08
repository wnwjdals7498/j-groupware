# 클라우드 실제 메신저 인증·WSS 연결 — 2026-10-08

j-groupware `9993f9cd8f3f28bcc3566bcc3639ffe98b5c411a`와 j-messenger M1 `0447c9bfab3543233eafa1cff22185c5ebafee91`을 연결했다. [메신저 고정 계약/모듈 회귀/미완료 범위](../../j-messenger/docs/cloud-j-auth-verification-2026-10-08.md)를 함께 읽는다.

## 실제 서비스 관통 시험

새 `tests/bff/messenger.integration.test.ts`는 기존 transport peer를 대체하지 않고 실제 compiled 메신저 서버를 별도 검증한다. 실제 j-auth가 두 임시 realm/가입/회원과 Keycloak client를 만들고 Code/PKCE 및 단일 audience exchange를 사용한다. 실제 메신저의 저장소는 원본과 구별한 격리 **SQLite** 파일이며 M5 PostgreSQL 인수 성공을 뜻하지 않는다.

11개 시나리오에서 같은 username 두 tenant의 별도 사용자 id, sub와 내부 id 구별·새 cookie/session 미생성, 무권한/wrong audience/다른 realm/변조 bearer의 사용자 무변경, 자체 login/logout/server list 미등록·cookie/query/Origin 우회 거절을 확인했다. 두 회원의 실제 개인 대화·메시지 저장·WSS `message.created.v1`·중복 재전송/내용 충돌·타 tenant404를 확인했고 단절 중 메시지를 authoritative cursor sync로 복구했다.

BFF의 `/api/messenger/ws`에서 실제 메신저 ready frame을 받았고 실제 logout과 실제 role 회수로 양쪽 relay가 종료됐다. 무권한 회원의 BFF handshake 403도 확인했다. 실제 JWKS 네트워크 접속 실패 503/사용자 무변경, 파일 DB 재열기 후 사용자/메시지 보존, compiled main의 기본 remote verifier HTTP 요청과 SIGTERM 정상 exit 0도 통과했다. token/비밀번호/메시지 본문이 서비스/시험 로그에 없는지 확인했다.

실제 회원 HTTP와 업무 저장은 메신저에 직접 호출했으며 BFF의 메신저 업무 HTTP route를 구현했다고 주장하지 않는다. BFF에는 기존 WSS relay의 실제 서비스 연결을 확인했다. 정식 client 패키지·메신저 UI/Playwright·PostgreSQL·고객 VM은 후속이다.

## 실행·TLS·재현

- 최종 `npm run check`: build/typecheck·그룹웨어 단위 48/48·lint/format 통과.
- 전체 실제 BFF `npm run test:integration`: **100/100**, 실패·skip 0. 기존/결재 73개, 알림 16개, 메신저 11개다.
- 메신저 `npm run check`: contracts10·core13·react13·server93·web4·배포 프로필11과 타입/경계/lint 통과. build/format 통과.
- Node22.18의 메신저 서버 타입/93개 회귀도 통과했다. 메신저 production `npm audit`의 알려진 advisories는 0건이다.

`npm run test:integration` 전 j-auth·j-approval·j-messenger를 설치/build하고 체크아웃 밖 격리 env/실제 서비스 런타임을 준비해야 한다. 누락된 의존성/잘못된 env는 skip 없이 실패한다. launcher는 isolated-cloud marker와 외부 env 위치를 확인한 뒤 시험용 auth/groupware CA와 기존 추가 CA를 같은 외부 runtime의 PEM으로 묶어 Node 프로세스만 신뢰하게 한다. 자체 서명 fixture certificate의 SAN과 일치하는 loopback 주소를 사용한다. compiled main 시험의 별도 resolver는 시험 파일에서만 auth 호스트의 실제 loopback 접속을 지정한다. 운영 소스에서 resolver를 import하거나 TLS 검증을 끄지 않는다.

첫 시험의 SAN 불일치·BFF의 추가 CA 누락과 잘못 가정한 이벤트 `.v1` 이름을 실제 공개 계약에 맞췄다. 이 실패 실행을 통과로 집계하지 않았다. 후속 전체 검사에서 unused 시험 변수를 발견해 실제 무권한 BFF handshake 검사에 사용했으며 최종 전체 검사를 재실행했다. 원본은 체크아웃 밖 `/workspace/.suite-runtime/j-groupware/messenger-{check,integration,full}*`와 j-messenger 검증 기록이다.

현재 클라우드 실행/파일/네트워크 차단은 없다. 회사 노트북에는 설치하지 않았다. 운영 데이터/자격을 변경하지 않았고 PR/main 병합/배포를 하지 않았다. PMT Windows 경로/도구는 클라우드에 없어서 해당 PMT 기록만 미실행이다. 정식 UI 기준, G18/G21 구독/설치·알림 키 투영, 실제 상담/메일 업무·알림, M5/M2/M3/M4 및 고객 VM/Nginx 인수는 남아 있다. `whole_suite_verified=false`다.
