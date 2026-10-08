# 고객 인증 BFF·contracts·cold 번들·gateway 연결

2026-10-08. 회사 노트북 설치 없이 저장된 클라우드 체크아웃과
`codex/cloud-auth-foundation-20261008` 작업 브랜치에서 진행했다.
구현과 실행한 검증을 기록하며 전체 제품군 인수 완료를 뜻하지 않는다.

## 구현

- 고객 인증 [6cbfdc8b4ec6b104f9cf6cc0e96eb73d7229db35](https://github.com/wnwjdals7498/j-customer-auth-db/commit/6cbfdc8b4ec6b104f9cf6cc0e96eb73d7229db35):
  손님 생성/수정·API 키의 공용 `MANAGEMENT_SCHEMAS`와 DTO를 contracts에
  모으고 실제 서버가 소비한다. 기존 외부 scope 계약은 유지한다.
- groupware [4acce86650d3ccc8f0e8f5f6bb68558e4a455739](https://github.com/wnwjdals7498/j-groupware/commit/4acce86650d3ccc8f0e8f5f6bb68558e4a455739):
  `/api/customer-auth/guests`와 `/api/customer-auth/api-keys`에 손님 CRUD·목록
  페이지·키 1회 발급/회수를 연결했다. 세션·role·CSRF 검사를 거치고 실제
  member-token exchange의 Bearer만 전달한다. tenant/서비스 키/Cookie를
  전달하지 않는다. UUID를 정규화하고 1MiB 이내 upstream JSON을 whitelist로
  검증하며 private fields·Set-Cookie·내부 오류 문구를 전달하지 않는다.
- groupware [b15b53bb32942eee832413729940af02c1950edf](https://github.com/wnwjdals7498/j-groupware/commit/b15b53bb32942eee832413729940af02c1950edf):
  기본 BFF와 여섯 선택 제품 중 일곱 번째인 고객 인증을 bundle/profile에
  추가했다. tenant에 맞는 HTTPS origin·독립 guest signing key·지속 cursor
  secret, 실제 `{ready:true}` 응답의 TLS probe와 inventory를 연결했다.
  설치 재시도는 같은 secret을 유지한다. BFF JSON 타입 자동 변환도 사전
  차단해 숫자 ID/이름/비밀번호와 문자열 scopes를 400으로 거부한다.
  compiled BFF 검사에서 모든 제품 endpoint의 정확한 env binding을 사용한다.

`@j-customer-auth-db/contracts@0.1.0`은 격리 클라우드의 loopback registry
`http://127.0.0.1:4873/`에 게시했다. 기존 private npmrc만 사용하고 다른 registry에
게시하지 않았다. 동일 버전 재게시를 사전 거부했고, groupware server가 exact
0.1.0 dependency와 lockfile integrity로 소비한다. 실제 cold 고객 인증의
contracts JS와 registry 소비본의 바이트 일치도 assertion했다.
integrity는 `sha512-CprrZ5kuwmaC5sfXpGO+UdWESgmw+MjpxOZe7ZMOJHJYbFT+jDsWziYIDRPTzGIJJHgkNW3hlot54iWU6jZ5TQ==`이다.

CA-21은 API-key scope 구현이다. **외부 관리 CRUD를 제공하지 않는다.**
외부에는 기존 읽기·서버 로그인·공개 JWKS/OpenAPI만 제공한다. 손님 JWT
300초 만료는 T2 방문자 token 수명 정책과 별개다.

## 실제 실행

| 검사                     | Node22.18 | Node24.19 | 범위                                                                      |
| ------------------------ | --------: | --------: | ------------------------------------------------------------------------- |
| 고객 인증 check          |         7 |         7 | build/type/lint/format 포함                                               |
| 독립 고객 인증 통합      |         9 |         9 | 이번 BFF 확장 전 재실행한 기존 실제 auth·PG 검사                          |
| 고객 인증 연결 중간 검사 |        15 |        15 | 실제 BFF·cold CA·Nginx·JWT/JWKS; 아래 전체 회귀에 중복 합산하지 않음      |
| 전체 BFF 최종 회귀       |       174 |       174 | 고객 인증16 포함, actual compiled BFF CRUD/키 회수까지                    |
| agent core               |        20 |        20 | 실제 private env 재시도·cursor 유지, 상태에 secret 미저장                 |
| 여섯 선택 제품 cold 번들 |         4 |         4 | 제품별 archive·pinned lock·scripts-disabled fresh npm ci; exit0·skip0     |
| groupware check          |    미실행 |        76 | build/type/lint/format; 이후 추가 test harness의 types/lint/format도 확인 |

cold CA는 새로운 외부 runtime root에서 archive digest와 USTAR inventory를
검증한 뒤 scripts-disabled npm ci를 수행했다. 기존 checkout node_modules로
되돌아가지 않고 compiled main을 실행했다. 실제 PG 전용 DB/role, native
Argon2 비밀번호 검증, 독립 RSA guest JWT·안정된 kid와 TLS readiness를 확인했다.
다른 CA에서는 readiness=false, 정지 뒤 active record는 installed가 아닌
incomplete로 관찰한다. 격리된 auth.jgw.test의 DNS만 외부 native test resolver로
연결했으며 OS hosts/CA 신뢰를 설치하지 않았다.

실제 고정 digest의 Nginx 컨테이너는 기존 BFF와 CA 서버의 HTTPS upstream을
검증한다. 새 API 키를 BFF로 발급하고 gateway의 외부 로그인·목록·JWKS로
JWT를 검증했다. 내부 `/customer-auth/guests`와 외부 POST CRUD는 404다.
`ProductGateway`의 실제 worker revision 확인과 기존 keepalive 클라이언트의
5초 이내 404 관찰을 함께 검사했다. graceful reload 중 기존 요청/연결의
즉시 중단을 보장한다는 주장은 하지 않는다. 설정 해제 뒤 BFF의 내부 관리
중계는 계속 동작한다. Nginx access log에 키·JWT·비밀번호가 없는 것도 확인했다.
이 fixture는 외부 인터넷 송신이나 실제 고객 설치/해지가 아니다.

## 실패와 제약

실패 로그를 보존했다. malformed upstream의 첫 BFF fixture는 undici가 Host
override를 적용하지 않아 400이었으며 실제 raw HTTPS 요청으로 수정했다.
cold runtime root는 mkdir 누락, 이어서 umask로 0755가 되지 않아 실패했다.
자기 fixture만 생성/권한 조정하고 installer guard는 유지했다.
실제 cold 부팅으로 준비 응답 형식 불일치를 찾아 제품 adapter를 수정했다.
그 다음 member 조회 503은 격리 auth 도메인의 DNS 입력이 빠진 fixture였고,
native-only 외부 test resolver를 사용한 뒤 통과했다.
첫 gateway 해제 직후 기존 keepalive 요청이 200을 받아 실패했으며 실제
같은 클라이언트의 bounded withdrawal 관찰로 검사를 수정하고 두 Node에서
404까지 확인했다. registry metadata 재조회는 npm cache 설정 누락의 ENOENT였고,
기존 외부 cache를 지정한 재조회는 exit0이다. Git/GitHub 연결 실패가 아니다.

이전 묶음의 compiled receiver 재시작 초기 실패 원인은 여전히 미확정이다.
이번 수정이나 최종 통과로 그 원인이 해결됐다고 주장하지 않는다.
고객 VM·20GB 디스크·OS CA 신뢰·실제 systemd PID1 credential 전달/활성화·
운영 자격 발급·timer·메일/SMS/외부 송신·정식 UI/Playwright 인수는 미실행이다.
전체 installer/agent entrypoint, Messenger/Mailpit 저장소 준비·정리와 production
notification 자격 갱신/토폴로지는 독립 구현을 계속할 수 있는 남은 작업이다.
T2·E8·H7은 사용자 답변 없이 채택하지 않았으며 UI 기존 질의도 대기한다.

## 재현 증거

실제 로그는 `/workspace/.suite-runtime/j-groupware/`의
`customer-relay-ca-check-node{22,24}-final.log`, `customer-relay-ca9-node{22,24}.log`,
`customer-contracts-publish.log`, `customer-contracts-consume.log`,
`customer-contracts-duplicate-rejected.log`, `customer-contracts-registry-after.json`,
`customer-gateway-15-node{22,24}-final.log`,
`customer-relay-full-bff-node{22,24}-final.log`,
`customer-product-agent-node{22,24}-final.log`,
`customer-six-bundles-node{22,24}-final.log`와 대응 `.exit`,
`customer-product-check-node24-final.log`에 있다. 실패한 실행은 통과로 합산하지 않는다.

환경이 starting→ready로 재연결될 때 이전 실행 session ID 조회가 사라졌다.
최종 Node24 로그에는 13 test files·174 tests passed가 보존돼 있으나 해당
세션의 종료 코드 조회는 재연결 뒤 수행하지 못했다. Node22 전체174는 도구의
exit0도 확인했다. 이후 검사는 `.exit` 파일에 실제 종료 코드를 함께 기록한다.

보고된 source SHA는 push 후 `git ls-remote`와 GitHub commit API로 각각 확인했다.
PR 게시·main 병합·배포는 수행하지 않았다. source 구현 집계와 전체 제품군
인수는 계속 구분하며 `whole_suite_verified=false`를 유지한다.
