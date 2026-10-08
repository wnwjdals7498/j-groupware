# G12/M2 메신저 BFF HTTP 연결 — 2026-10-08

상태: **업무 HTTP와 공개 client transport 검증 완료; 정식 화면·전체 인수 미완료**. 메신저 client 구현 커밋은 `d3537a0eed66ff704575be69a787698222b03c48`이다. [M5 저장 증거](cloud-messenger-postgres-verification-2026-10-08.md)와 [client 사용 범위](../../j-messenger/docs/cloud-bff-client-verification-2026-10-08.md)를 함께 읽는다.

`/api/messenger/api/v1` 아래 현재 회원·회원 목록·대화 목록/생성·메시지 목록/생성·읽음 조회/변경·sync의 **9개** 명시적 경로를 추가했다. 모든 경로는 현재 BFF 세션과 `messenger:use`를 요구하고 변경 요청은 기존 Origin/CSRF 검사도 적용한다. 내부 서비스 주소와 audience는 서버 설정으로 결정한다. 쿼리/본문으로 token·tenant·serverId·URL 등을 추가하면400이다. BFF가 단일 audience Bearer를 얻고 고정 loopback 서비스만 호출하며 쿠키/외부 Authorization은 전달하지 않는다.

메신저 wire DTO를 검증하고 허용 필드만 새 응답에 복사한다. 성공 본문1MiB·페이지100·signed64 decimal ID·CSRF body64KiB·trim 후 UTF-16 4000자 한계를 적용한다. 오류는 native `{error:{code,message,requestId}}`로 반환하며 UUID requestId와 X-Request-Id를 사용한다. upstream token/credential/cookie/error 상세·redirect는 전달하지 않는다. 오류410은 알려진 sync/reset·본문 만료 코드만 허용한다. 파일/보존/native login 관리 경로가 없어 capabilities도 false로 보고한다. 그룹웨어 로그인·로그아웃을 사용한다.

- 실제 Keycloak·PostgreSQL 메신저/BFF **14/14**, 실패/skip0. 공개 client의 회원·대화 생성/목록·메시지 목록·잘못된 ID 오류, BFF 쿠키/CSRF·외부 Origin/추가 필드 거절, 메시지201/동일 재시도200/변경409/다른 tenant404, 실제 WSS 메시지·읽음 사건, 단절 cursor sync와 실제 downstream 중단503/세션 보존을 검증했다.
- 전체 실제 BFF **103/103**, 실패/skip0. 기존 결재/조직/회원/알림/SSE/WSS/compiled restart와 메신저 PG14개를 실행했다.
- j-groupware 전체 check: 단위 **57/57**(기존48+새9), build/type/lint/format 통과. 새9개는 격리 transport의 본문 상한·credential/cookie 투영 방지·잘못된 tenant/JSON/ID/status/expiry code 경계이며 실제 backend 시험으로 세지 않는다.
- 메신저 전체 check/build/format(core17·server94·contracts10·React13·web4·deploy11), j-auth18+30와 j-approval17 전체 check 통과.

전체 회귀 첫 실행에서 compiled BFF 로그인4건이503이었다. 시험의 env 파일명 변환이 `integration.env`에만 맞아 PG 입력 env를 덮어쓴 원인이었다. 입력 파일을 보존하고 새 tenant별 compiled env를 만들며 child process에 정확한 설정을 넘기도록 수정한 뒤103개를 다시 실행했다. 최초 실패를 통과로 처리하지 않았다.

정식 UI/Playwright·공통 패키지 registry 설치·파일 BFF·고객 VM/외부 gateway·부하는 미검증이다. `GW-30`은 화면이 없어 partial이고 MS-06은 transport 코드 구현으로 구분한다. Windows PMT 경로/도구 부재는 해당 기록만 차단한다. `whole_suite_verified=false`를 유지한다. 회사 노트북·운영 구독/키·PR/main/배포는 변경하지 않았다.
