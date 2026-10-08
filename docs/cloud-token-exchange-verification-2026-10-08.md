# 클라우드 G23 토큰 축소 검증 — 2026-10-08

선행 `7319a5cf939b6197b570fb86203bada028dceb90` 이후 G23의 서버 구현을 추가했다. 작업 브랜치는 `codex/cloud-auth-foundation-20261008`이다. 실제 j-auth·Keycloak·전용 PostgreSQL 격리 환경을 사용했고 운영 데이터·자격 증명은 변경하지 않았다.

## 코드와 계약

- `OidcClient.serviceToken`은 confidential client로 standard token exchange를 요청한다. access token만 요청하며 audience는 서비스 하나다. 실패 시 원래 토큰을 전달하지 않는다.
- `ServiceTokens.get`은 catalog의 하위 tenant service만 받고, 같은 세션의 인증·refresh·role 검사와 cache 처리를 PG 행 잠금으로 직렬화한다. 같은 세션/서비스의 동시 요청은 교환 한 번이다.
- 캐시는 `(tenant,session_hash,service)`와 원래 access token의 SHA-256, 만료를 저장한다. 원래 token이 바뀌거나 cache 만료가 30초 이내면 새로 교환한다. 외래 키 cascade로 세션 삭제 때 cache도 삭제된다.
- 새 token과 cache hit 모두 서명·issuer·tenant·sub·sid·정확히 하나인 audience·30초 이상의 만료·catalog role·원래 세션 권한 범위를 검사한다. 다른 service의 resource role이 섞이면 거절한다. realm의 신원 역할은 유지될 수 있다.
- 정상 refresh 뒤 하위 교환 실패나 취소는 savepoint로 cache 변경만 되돌린다. 이미 Keycloak에서 회전한 refresh token은 PG에 유지해 재사용 거절을 유발하지 않게 한다. PG 자체 저장 실패/응답 유실의 기존 재로그인 경계는 남는다.
- `ServiceClient.request`는 서버 소유 origin·path와 축소 Bearer만 사용한다. 목적지는 명시된 `127.0.0.1` 포트이며 3001·외부 host·userinfo·origin 경로·query/hash를 거부한다. 요청의 cookie·서비스 키는 복사하지 않는다. redirect는 따라가지 않고 제한 시간/취소를 적용한다.
- `createApp`은 후속 service controller가 사용할 공통 함수 `app.services`와 `app.serviceTokens`를 연결한다. env의 `JGW_SERVICE_<NAME>_URL`로 내부 endpoint를 설정한다. 토큰을 브라우저에 반환하는 route나 사용자 지정 proxy 목적지는 만들지 않았다. j-auth 회원 API는 G6에서 원래 token+서비스 키를 쓰므로 이 함수의 대상이 아니다.

프로토콜은 [Keycloak standard token exchange](https://www.keycloak.org/securing-apps/token-exchange)를 확인하고 설치된 26.8.0으로 실제 검증했다.

## 실행 결과와 한계

`npm run check`의 build·테스트 타입 검사·단위 48개·lint·format이 통과했다. `npm run test:integration -- --reporter=json --outputFile=…`은 전체 23개 통과·실패 0·미실행 0이다. 기존 BFF 16개와 새 G23 7개를 함께 실행했다. JSON은 `/workspace/.suite-runtime/j-groupware/g23-integration-results.json`, 검사 로그는 같은 외부 runtime의 `g23-check.log`에 둔다. j-auth 소스는 `0fd0eb5bdf2bd012672f6701c2be8d6b14aa0e62` 그대로이며 이전 실제 61개 회귀 기록을 유지한다.

실제 tenant에 mail/messenger를 j-auth 가입 API로 추가하고 실제 로그인 token을 교환했다. 8개 동시 호출 1회 교환·세션별 분리, 다른 audience/tenant 거절, 미가입 역할·unknown service 거절, cache 서명 변조 차단, 실제 refresh 후 cache 교체, cache 만료·통신 장애 재시도, refresh 성공 뒤 교환 실패의 refresh 보존, 실제 교환 응답 뒤 취소 시 token 미반환·cache 미저장, 실제 logout·회원 role 변경 backchannel의 cache 삭제와 반복을 확인했다.

loopback HTTP 수신 fixture가 축소 token을 실제 JWKS로 검증하여 응답했고 cookie/서비스 키 미전달·외부 path/redirect 거절을 확인했다. 이 수신기는 transport 경계를 확인하는 테스트 서버이며 실제 j-mail/j-messenger 제품 서버가 아니다. 당시 제품 업무 API·화면·WSS 종단 인수는 미실행이었다. 후속 결재·메신저 기록과 [실제 메일 BFF 연결](cloud-mail-bff-verification-2026-10-08.md)에서 실행한 범위를 확인한다. 정식 화면/전체 고객 VM 인수와 구별한다.

첫 실행 22개 중 세 가지 실패를 그대로 남겨 진단했다. 응답 본문을 읽는 도중 취소가 503으로 바뀌던 코드를 수정했다. realm 신원 역할까지 제거된다고 보던 기대값을 수정했다. 가입 해지가 즉시 logout을 보낸다고 가정했던 시험은 실제 계약상 logout을 보내는 회원 role 변경 시험으로 바꿨다. 가입 API의 client 제거가 이미 발행된 JWT를 즉시 폐기한다고 주장하지 않는다. 최종 23개 재검사는 refresh 후 실패 경계도 추가해 통과했다.

정식 UI·theme·Playwright, 실제 서비스 중계 route/업무 응답, WSS/SSE 종료·gateway·VM은 후속 범위다. `whole_suite_verified=false`를 유지한다. 실제 회원 관리 BFF는 이어서 구현한다.
