# 메일 BFF 클라우드 구현·검증 (2026-10-08)

j-mail의 [SMTP/PG 기반 커밋 21aaf1638e5cc66c7650388fdf20186ae0e9db82](https://github.com/wnwjdals7498/j-mail/commit/21aaf1638e5cc66c7650388fdf20186ae0e9db82), [인증 API/contracts 커밋 fc8533275aac2c591c55ceaad28bcf8834fcb54a](https://github.com/wnwjdals7498/j-mail/commit/fc8533275aac2c591c55ceaad28bcf8834fcb54a)을 승인된 브랜치에 푸시했고 원격 SHA를 확인했다. [메일 실행/신뢰 전제/실패 이력](https://github.com/wnwjdals7498/j-mail/blob/fc8533275aac2c591c55ceaad28bcf8834fcb54a/docs/cloud-inbox-verification-2026-10-08.md)이 선행이다.

## 연결한 서버 범위

`GET /api/mail/messages?offset=0&limit=20`·`GET /api/mail/messages/:id`는 ROUTES의 `mail:read`, HttpOnly 세션과 G23 단일 audience exchange를 사용한다. 목적지는 외부 env의 명시적인 loopback j-mail origin이며 cookie/서비스 key를 하위 서비스로 전달하지 않는다. 추가 tenant/source·잘못된 query/id는400이다. immutable `@j-mail/contracts@0.1.0`의 bounded DTO parser로 native 내부 필드/무관 자격을 제거하고 최대16MiB response/기존10초 transport timeout을 적용한다. 페이지 offset/limit와 상세 id가 요청과 일치해야 한다. 하위 오류 본문은 전달하지 않고401/403/404/503을 안전한 메시지로 변환한다.

j-mail은 Mailpit 표시 To가 아니라 SMTP가 넣은 첫 Received로 tenant를 확인한 뒤 total/page를 계산한다. native 상세 GET의 Read 변경 전에 readonly headers로 foreign id404를 결정한다. pinned Mailpit/SMTP-only capture/한 tenant의 고객 VM profile이라는 신뢰 전제를 유지한다. HTML은 untrusted JSON 문자열만 반환한다. **정식 메일 UI·iframe sandbox·Playwright를 구현/검증한 것은 아니므로 GW-31은 partial**이다.

## 실행 증거

| 검사 | 결과 |
| --- | --- |
| j-mail Node22.18/24.19 실제 통합 | 각각18/18, fail/skip0; unit9/deploy3와 build/typecheck/lint/format 통과 |
| j-mail registry | loopback 게시/별도 exact 소비자/pack SHA5121/1 통과; 공개 게시 없음 |
| j-groupware `npm run check` | build/typecheck·unit70/70·lint/format 통과 |
| j-groupware Node22.18/24.19 메일 BFF | 각각 실제8/8, fail/skip0 |
| j-groupware PostgreSQL 모드 전체 BFF | 실제122/122, fail/skip0; 아래 최종 결과 파일이 근거 |
| 두 저장소 npm ci | 명시적인 공용 캐시로 `--ignore-scripts --offline` 통과 |

실제 새 j-auth tenant/메일 구독·회원과 Authorization Code/PKCE로 세션을 만들고, **compiled j-mail 서버** 둘과 network-none Mailpit 컨테이너의 Unix socket을 loopback으로 연결했다. 혼합6 SMTP 메일/위조 To에서 각 tenant 목록3·페이지·단건404, foreign native Read 불변, 같은 tenant 두 회원 공유, JSON HTML와 토큰 비노출, 미인증401·무권한403·tenant/source injection400, actual Mailpit stop/restart503/복구, actual compiled mail stop/start503/복구, mail:read 회수 후 기존 세션401·재로그인403, 민감 로그 부재를 확인했다. Mailpit/native UI를 외부에 열거나 외부 SMTP로 연결하지 않았다.

메일 BFF 초기 check에서 짧은 fixture cookie가 공통 cookie validator에 거절되는 시험 오류와 새 fixture의 env/MeResponse 타입 오류를 수정했다. 미실행 통합을 통과로 계산하지 않았다. 코드/fixture 수정 후 check·실제8개·기존 전체 회귀를 실행했다. gateway/agent 코드는 변경하지 않았으며 이전 실제 각각13/14 검증 기록을 유지한다.

결과는 `/workspace/.suite-runtime/j-groupware/mail-check.log`, `mail-bff-results.json`, `mail-bff-node22-results.json`, `mail-full-bff-results.json`, `mail-npm-ci.log`이다. j-mail 결과/실패 이력은 위 선행 기록을 따른다. 기존 PG/Keycloak/registry·데이터·자격을 보존했고 각 테스트가 소유한 realm/DB 등록·메일 컨테이너·child만 정리했다. 원격 CI 실행 여부와 로컬 통합 성공은 구별한다.

## 남은 실제 차단

- `docs/ui-guidelines.md` 부재: 정식 메일 화면·sandbox·G14 Playwright와 다른 제품 UI는 후속이다.
- ML-20/E8: FS-U07 webhook 수신 전 누락/복구 허용 한계와 전체 SMTP envelope 수신자 보존 계약이 미정이다. 첫 Received는 첫 수신자만 있고 표시 Bcc로 모든 수신자를 보장할 수 없다. 임의 outbox/ingress/recovery 정책을 추가하지 않았다.
- imported sample-a의 당시403→503은 [후속 역할 소유자 호환 수정](cloud-imported-role-compatibility-2026-10-08.md)에서 해결했다. 기존 권한/catalog hash는 같으며 잘못된 alias는 계속403이다. 기존 alias/scope drift는 보존했고, 실제 정상 축소 JWT와 신규 import를 구별해 검증했다.
- ML-03/30/32: 외부 SMTP egress 방화벽·systemd·고객 VM 설치/해지·volume/DB 백업과 outbox는 아직 전체 인수가 아니다.
- 콘솔 desired/status/agent key 계약, 실제 설치기/probe·production key projection, 상담 guest/session 정책은 이전 미정 상태를 유지한다. 생산 자격·운영 설치·상시 접근·외부 이메일/SMS/제3자 송신을 하지 않았다.

PR·main 병합·배포·회사 노트북 설치는 수행하지 않았다. 전체172 기능의 코드는 implemented66/partial19/not_started87로 갱신했지만 `whole_suite_verified=false`를 유지한다.
