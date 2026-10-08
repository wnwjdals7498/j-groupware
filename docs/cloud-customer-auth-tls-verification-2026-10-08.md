# 고객 인증 backend·전용 서비스 계정 TLS 검증

저장된 클라우드 체크아웃·인증/PG·사설 registry 준비를 확인하고 계속 구현했다.
고객 인증 저장소는 최신 origin/main의 docs-only `9d239d2`에서 별도 작업
브랜치 `codex/cloud-auth-foundation-20261008`를 만들었다. 같은 브랜치의
j-groupware 기존 변경은 보존했다. 회사 노트북 설치와 포트 3001의 접속·바인딩·
종료를 수행하지 않았다. 검증한 소스 묶음은 별도 승인된 작업 브랜치 푸시 범위에서
푸시하고 ls-remote·GitHub commit API의 정확한 SHA를 확인했다. PR·main 병합·
운영 배포·영구 자격 발급·운영 timer 등록·실제 외부 전송은 수행하지 않았다.

진척도는 **구현 108 / 부분 31 / 미착수 33, 총 172**이며 남은 항목은 64개다.
고객 인증의 14개 소스 범위를 구현으로 옮기고 CA-31은 contracts 게시/소비가
남아 부분으로 표시한다. 이 14개 중 CA-21은 명세의 현재 스코프 계약만이며
향후 외부 CRUD 구현 완료를 뜻하지 않는다. CA-32 실제 고객 인수는 미착수다.
GW-40/63/64/65/66은 부분 상태를 유지한다. 초기 66/19/87 baseline과 checkpoint를
보존하며 전체 제품군 인수는 미완료다. 소스 구현과 UI·VM 인수를 구분한다.

## 구현과 커밋

- 고객 인증 [64dc8099f2ff65754e232553c6edcb8114af0f48](https://github.com/wnwjdals7498/j-customer-auth-db/commit/64dc8099f2ff65754e232553c6edcb8114af0f48):
  server/contracts workspace, 전용 jgw_customer_auth DB·nonsuperuser 계정·checksum
  migration, 회원 Bearer 기반 손님 CRUD·검색·tenant/query-bound HMAC cursor,
  Argon2id 영구 초기 비밀번호, SHA256 해시 API 키·scope·회수, 사이트 서버
  로그인·독립 RS256 손님 JWT/JWKS, PG 지속 rate limit과 실제 route schema의
  외부 OpenAPI를 구현했다. 외부 관리 CRUD는 제공하지 않는다.
- 고객 인증 [4692b36db98c2cb2043cb76514bc350256ccaaf7](https://github.com/wnwjdals7498/j-customer-auth-db/commit/4692b36db98c2cb2043cb76514bc350256ccaaf7):
  JS 정규식 `$`의 마지막 newline 허용을 차단하고 목록 검색 제어문자를
  PG 호출 전에 400으로 거부했다. 키·ID와 실제 NUL 검색의 회귀를 검증했다.
- groupware [ba4d9d7214228209c703503ad56966d0cdb5c903](https://github.com/wnwjdals7498/j-groupware/commit/ba4d9d7214228209c703503ad56966d0cdb5c903) 및
  [93816d75b358e731267ce126ba3b10eaa76e2ebd](https://github.com/wnwjdals7498/j-groupware/commit/93816d75b358e731267ce126ba3b10eaa76e2ebd):
  실제 j-auth/Keycloak 회원 생성·코드 로그인·단일 aud 교환을 고객 인증 compiled
  HTTPS 서버·실제 PostgreSQL18.6에 연결한 9개 통합 검사다. 서비스 DB 타입
  선언도 실제 ensure/disable 반환 및 absent 관측 옵션과 맞췄다.
- groupware [64b1d89702e4641f34ed6b24ee7b6254c270b81d](https://github.com/wnwjdals7498/j-groupware/commit/64b1d89702e4641f34ed6b24ee7b6254c270b81d):
  `NativeTlsCredentials`·고정 LoadCredential·non-root launcher를 연결했다.
  source는 root-only로 유지하고 서비스별 immutable credential을 준비한다.
  CA private key의 TLS 사용과 CA/TLS 키의 손님 JWT 재사용을 거부한다. fresh
  Node의 CA trust와 같은 PID를 유지하며 기본 cold 번들에 두 모듈을 넣었다.
  customer-auth는 별도 파일 저장소가 없어 backup/NOLOGIN 후 PG·번들·서명 키를
  보존하는 cleanup descriptor를 추가했다. 기존 Messenger/Mailpit 별도 storage
  cleanup은 여전히 전용 구현을 요구한다.
- groupware [66e41b2070ed2aa7c0efcb5e684891b3926db0b6](https://github.com/wnwjdals7498/j-groupware/commit/66e41b2070ed2aa7c0efcb5e684891b3926db0b6):
  고객 인증의 독립 RSA 서명 키를 성공적으로 stage하고 실제 전용 nologin 계정이
  private credential을 읽어 서명/공개키 검증을 수행한다. 다른 서비스 계정은
  읽지 못하며 CA/TLS 키 재사용은 거부한다. 두 실제 Node 버전의 추가 검증과
  `test:agent:tls` 실행 명령을 포함한다.

규칙과 고정 패키지는 [고객 인증 API 계약](../../j-customer-auth-db/docs/api-contract.md),
운영 source 계약은 [provisioning.md](../deploy/agent/provisioning.md) 및
[bundles.md](../deploy/agent/bundles.md)에 있다. guest JWT의 300초 수명은
T2 방문자 token 정책과 별개다. 회수는 기존 API-key 인증 transaction 완료까지
대기하고 반환 뒤 새 인증을 거부한다. 이미 발급된 JWT는 기존 5분 만료를 따른다.
영구 비밀번호 변경/재설정·서명 키 자동 교체는 이번 명세 범위에 없다.

## 실제 실행 범위

| 검사 | Node22.18 | Node24.19 | 실제 증거 |
|---|---:|---:|---|
| 고객 인증 full check | 7 | 7 | 단위 검사·build/type/lint/format |
| 고객 인증 통합 | 9 | 9 | 실제 auth/member exchange·PG·compiled HTTPS·키·JWT/JWKS·제한·장애 |
| 전체 BFF | 167 | 167 | 신규 고객 인증9 포함; 하위 검사를 중복 합산하지 않음 |
| TLS credential | 3 | 3 | 실제 root/nologin 계정·private credential·같은 PID fresh Node HTTPS |
| safe unpack | 19 | 19 | base/Talk cold npm ci·inert TLS/launcher import·hash/권한·위험 tar·실패/취소 |
| agent core | 20 | 20 | LoadCredential unit 문법과 customer-auth PG 보존 descriptor 포함 |
| root full check | 미실행 | 76 | build/type/lint/format 포함 |

최종 실행은 모두 exit0·skip0이다. 추가한 credential 검사 이후 전체 lint와
format도 다시 통과했다. 문서 validator는 172 기능·60 인수 시험 **정의**·9 suite
시험 **정의**·137 local links를 검증했으며 기능 시험을 실행한 것은 아니다.

고객 인증9는 회원 read/write·tenant·Cookie·다중 aud·서명·JWKS503의 기본 거부,
정상 CRUD·literal 검색·query-bound cursor·필드 whitelist·중복 ID와 Argon2id
DB 저장을 실제로 확인했다. 키 원문 1회와 hash-only 저장·scope·회수, OpenAPI의
내부 경로 비노출·외부 쓰기 route 미제공을 확인했다. guest JWT의 서명/만료/잘못된
서명과 없는 ID/틀린 암호 동일401, actual PG auth lock과 revoke 대기, 서버 재시작
뒤 rate limit 유지·forwarded IP 위조 거부·실제 DB 중단503도 검증했다. 전용 DB
역할의 유효 비밀번호로 다른 DB 접속을 시도해 실제 42501 거부를 확인했다.

TLS 검사는 격리 컨테이너 안에서만 root 계정/권한 작업을 한다. systemd credential
directory를 구성해 unit 사용자별 접근·root CA key 비접근과 실제 HTTPS trust를
검증한다. 고객 인증 전용 계정의 독립 RSA 키 읽기·실제 서명/검증과 다른 계정의
접근 거부도 포함한다. 실제 systemd PID1의 LoadCredential 전달·OS 계정 설치/활성화를
실행한 것은 아니다. 사용한 [Node process.execve](https://nodejs.org/docs/latest-v22.x/api/process.html#processexecvefile-args-env)는
Linux의 experimental API이며 두 실제 Node 버전으로 같은 PID 교체를 확인했다.
cloud host의 OS 계정·CA 신뢰·root 파일 권한·systemd 서비스를 변경하지 않았다.

고객 인증의 별도 fresh `npm ci --omit=dev --ignore-scripts --offline`과 native
Argon2·local contracts·server cold import도 Node22에서 통과했다. 이는 사설
registry의 immutable contracts 게시/외부 소비 성공을 뜻하지 않는다. 실제 제품
bundle/profile에는 현재 여섯 서비스만 있으며 customer-auth 추가 연결은 남았다.
이전 묶음의 실제 PG6·제품5·cold 제품4·Nginx15·Web cleanup2 증거는 유지하고
이번에 다시 실행했다고 주장하지 않는다.

## 실패 기록과 정리

초기 설치의 npm10 workspace resolver와 node_modules relocation 경로 문제를
수정했으며 최종 normal npm ci는 legacy-peer-deps 없이 통과했다. 비공개 파일
ancestry guard에서 sandbox의 uid65534 kernel `/`를 기존 정책대로 제외하고
그 아래 실제 디렉터리 검사는 유지했다. 처음 교차 DB 검사는 pg Pool options의
비열거 password 누락으로 SCRAM 오류가 났고, 실제 password 전달 뒤 42501을
확인했다. private workspace source를 다른 UID가 읽지 못한 TLS fixture는
컨테이너 내부에 공개 코드만 stage했다. 읽기 전용 bind된 Node의 execve EACCES는
동일 실제 runner binary를 컨테이너 내부에 복사한 뒤 검증했다.

병행 TLS/unpack은 workspace ENOSPC로 한 번 실패했다. large Docker/cold 검사를
순차 실행해 최종 unpack19 두 버전이 통과했다. 신규 전체 BFF의 최초 직접 Vitest
호출에는 필수 JGW_TEST_ENV가 빠져 compiled 기동 검사가 실패했고 용량도
소진되어 중단했다(exit130). 뒤의 runner는 중단이 남긴 자기 auth process 및
fixture 때문에 각각 hook 실패/167 skipped로 종료했다. 이 skipped 실행은
통과에 합산하지 않는다. 정확한 command/UID와 생성시각 22:01:22/23이 확인된
자기 process/두 fixture만 정리한 뒤 공식 runner로 Node22/24 전체167을 재실행해
exit0·skip0으로 확인했다. npm cache는
내용을 보존해 `/tmp`로 옮기고 원래 경로를 연결해 1.5GB를 확보했다. registry와
다른 작업자의 파일·컨테이너는 보존한다.

이전 묶음의 별도 compiled receiver 재시작1 초기 실패 원인은 여전히 미확정이다.
이번 invocation/용량/fixture 실패와 혼동하지 않는다. 실패 로그는 모두 보존한다.
Git/GitHub 연결 오류는 이 과정에서 관측되지 않았으며 실제 command 실패를
connection 알림과 구분한다.

외부 증거: `/workspace/.suite-runtime/j-groupware/`. 최종 로그는
`customer-auth-check-node22-final.log`, `customer-auth-check-node24-final.log`,
`customer-auth-integration-node22-final.log`, `customer-auth-integration-node24-final.log`,
`tls-customer-credentials-node22-final.log`, `tls-customer-credentials-node24-final.log`,
`tls-unpack-node22-serial-final.log`, `tls-unpack-node24-serial-final.log`,
`tls-agent-node22-final.log`, `tls-agent-node24-final.log`,
`customer-tls-groupware-check-node24-final.log`,
`customer-tls-full-bff-node22-runner-final.log`,
`customer-tls-full-bff-node24-runner-final.log`이다. 중단/실패는
`customer-tls-full-bff-node22-direct-interrupted.log`,
`customer-tls-full-bff-node22-orphan-process-failed.log`,
`customer-tls-full-bff-node22-stale-fixture-failed.log`에 보존했다. 자기 fixture 정리의
시각/범위는 `customer-tls-owned-fixture-recovery.log`에 있다. 문서 validator
결과는 기능 시험이 아니다.

## 남은 연결 작업과 인수

- 고객 인증 contracts registry 게시/소비, G13 BFF 관리 relay·권한별 상담 손님
  이름 조합, 일곱 번째 bundle/profile/readiness/gateway와 설치 연결은 독립적으로
  계속 구현할 수 있다. standalone backend 완료를 이 연결 완료로 취급하지 않는다.
- 전체 bootstrap/installer/agent entrypoint, Messenger 파일·Mailpit storage
  cleanup, Web helper/storage 초기 설치와 실제 systemd credential 전달이 남았다.
- 운영 notification 자격 갱신/토폴로지·timer, 지정 고객 VM/20GB 데이터 디스크·
  firewall·OS CA 신뢰·브라우저/전체 인수는 미실행이다.
- [T2/E8/H7 선택 묶음](cloud-policy-choice-bundle-2026-10-08.md)은 권고와 확정
  명세를 구분한다. 사용자 선택 전에는 정책을 채택하거나 해당 작업을 실행하지 않는다.
  정식 UI 기준 질의도 응답 대기 상태를 유지한다.
