# 클라우드 회원 관리 BFF 검증 — 2026-10-08

G23 `07ac057afd89339c3746b7fb80004d7ee6f6e9d5` 이후 G6의 서버 연결을 구현했다. 별도 작업 브랜치 `codex/cloud-auth-foundation-20261008`, `/workspace`의 격리 Keycloak 26.8.0·j-auth·전용 PostgreSQL 18.6을 사용한다. 회사 노트북·운영 데이터·실제 운영 자격 증명은 변경하지 않았다.

## 구현·API 계약

| 경로 | 동작 |
| --- | --- |
| `GET /api/members` | 현재 tenant의 j-auth 회원 목록·cursor. offset 문자열은 j-auth 계약의 0~999999다. |
| `GET /api/members/grantable-roles` | 실제 가입 서비스의 grantable 역할과 catalog `implies`를 반환한다. 읽기 포함 관계를 화면에서 사용할 수 있다. |
| `POST /api/members` | 관리자 지정 영구 초기 비밀번호·roles로 생성하고, 확인된 회원 id를 미배치 저장에 등록한다. 응답에는 비밀번호가 없다. |
| `PUT /api/members/:id/roles/:role` | 역할 부여·effective roles 반환, 대상 회원의 로컬 세션/cache 종료. |
| `DELETE /api/members/:id/roles/:role` | 직접 역할 회수·effective roles 반환, 대상 회원의 로컬 세션/cache 종료. 복합 쓰기 역할의 읽기 포함은 j-auth가 결정한다. |
| `DELETE /api/members/:id` | j-auth 확인 뒤 대상 로컬 세션·미배치 데이터를 정리한다. 자기/관리자 삭제 제한은 j-auth와 실제 검증한다. |

모든 경로는 `member:manage`, 변경은 기존 Origin·CSRF 검사를 요구한다. j-auth에는 원래 관리자 access token과 서버 env의 해당 tenant `JGW_SERVICE_KEY`만 전달한다. G23 축소 token·브라우저 cookie·사용자가 지정한 tenant는 전달하지 않는다. API 경로는 설치된 `@j-auth/contracts@0.1.0`의 함수로 만들고, contracts 패키지에서도 회원 I/O 타입을 재사용한다.

`JAUTH_PUBLIC_URL`은 고정 HTTPS origin이며 redirect를 따라가지 않는다. timeout·응답 크기 제한과 안전한 응답 필드 검사를 적용한다. upstream 메시지·비밀값·임의 필드는 반환하지 않는다. 잘못된 tenant 서비스 키 등 upstream 401은 구성/인증 서비스 503으로 처리하고 정상 BFF 세션을 지우지 않는다. 400·403·404·409는 안전한 메시지로 구별한다.

`member_session_ends`와 회원별 advisory lock으로 대상 세션 생성/종료를 직렬화한다. 이미 시작된 로그인 flow가 권한 변경 이후 늦게 돌아오면 session을 만들지 않는다. 정상 신규 로그인은 허용한다. 기존 SID backchannel tombstone도 유지한다. 대상 로컬 세션 삭제는 서비스 token cache를 cascade 삭제하고 종료 hook을 호출한다. 네트워크 backchannel이 빠져도 BFF가 확인된 변경 뒤 직접 정리한다. 실제 WSS/SSE 연결은 아직 없다.

생성 성공 뒤 미배치 저장 실패, 역할 변경/회원 삭제 뒤 로컬 정리 실패는 503과 완료된 단계의 안전한 메시지를 반환한다. 외부 변경을 rollback했다고 표시하지 않는다. 확인된 삭제의 로컬 정리가 실패하면 재시도의 실제 j-auth 404와 자기 tenant의 남은 로컬 자료를 근거로 정리를 마무리한다. 다른 tenant의 알려지지 않은 404 대상에는 로컬 자료를 만들지 않는다.

브라우저가 완전한 변경 요청을 보내기 전에 취소하면 변경을 시작하지 않는다. 완전한 요청이 받아들여진 뒤 연결이 끊어져도 확인·로컬 후속 처리를 마무리한다. 응답 유실을 성공으로 알리지 않으며 목록으로 실제 상태를 확인한다. 생성 재시도는 같은 username의 409이고 비밀번호를 복원하거나 재반환하지 않는다.

## 실행 결과

- `npm run check`: build·테스트 타입 검사·단위 **48/48**·lint·format 통과.
- `npm run test:integration -- --reporter=json --outputFile=…`: 전체 **32/32**, 실패 0·미실행 0. 기존 BFF 16개·G23 7개·새 회원 BFF 9개를 함께 실행했다.
- j-auth `npm run test:integration -- --reporter=json --outputFile=…`: 기존 실제 **61/61**, 실패 0·미실행 0. j-auth 소스는 `0fd0eb5bdf2bd012672f6701c2be8d6b14aa0e62` 그대로다.
- 변경된 workspace lockfile로 `npm ci --ignore-scripts --offline --no-audit --no-fund`: 종료 0. 기존 고정 registry package를 캐시에서 설치했다.

원본은 체크아웃 밖 `j-groupware/members-integration-results.json`, `j-groupware/members-check.log`, `j-auth/integration-results-phase4.json`이며 모두 `/workspace/.suite-runtime` 아래다. 단위·문서 검사와 실제 통합, 제품군 전체 인수를 구별한다.

실제 회원 생성·로그인·미배치 저장·원래 Bearer/서비스 키 전달, 역할 없는 호출과 CSRF/tenant/외국 id/서비스 키 경계, concurrent 생성 4개 중 1개만 생성·중복 재시도 409, 두 대상 세션과 cache 종료·다른 회원/tenant 유지, 읽기 포함·grant/revoke 반복, 백채널을 끈 격리 realm에서 실제 교환 응답을 받은 오래된 callback 차단, 동시 grant/revoke·삭제·반복을 확인했다. 응답 받은 생성의 브라우저 취소 뒤 PG 후속 저장과 재생성 거절도 실제 네트워크로 시험했다.

격리 PG의 임시 trigger로 미배치 insert/delete 실패를 주입하고 부분 완료·재시도 정리를 확인했다. trigger는 시험 뒤 삭제한다. 실제 compiled loopback HTTPS 서버에서도 생성·삭제·잘못된 입력, 재시작 세션 유지, 비밀번호·token·서비스 키의 응답/로그 비노출을 확인했다.

첫 31개 실행의 마지막 compiled 시작은 새 `JAUTH_PUBLIC_URL`이 테스트 env에 빠져 실패했다. env 생성 코드를 보완해 31개가 통과했고, 확인된 삭제의 복구 경계와 compiled 회원 API 검사를 추가한 최종 32개도 통과했다. 실패를 통과로 대체하지 않았다.

## 남은 실제 범위

회원 관리 화면·체크박스 읽기 잠금 UI·Playwright는 미구현이다. canonical `ui-guidelines.md`가 없어 정식 화면/테마를 확정하지 않았다. 미배치 저장은 조직도 연결을 위한 최소 상태이며 부서 트리·기존 회원 수동 배치·생성 부분 실패의 조직도 재등록 API는 G15에 남아 있다. 생성이 확인된 뒤 미배치 저장만 실패한 경우 목록 확인과 별도 복구가 필요하다. 현재 생성 재전송으로 이를 성공 처리하지 않는다.

종료 hook과 실제 세션/cache 제거를 실제 WSS/SSE 연결 종료로 표시하지 않는다. 제품별 업무 controller·하위 서버 통합, WSS/SSE 중계, gateway/Nginx·VM·설치/해지 인수, 운영 콘솔은 후속이다. PR·main 병합·배포를 하지 않았으며 `whole_suite_verified=false`를 유지한다.
