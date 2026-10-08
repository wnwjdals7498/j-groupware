# 콘솔·상담 BFF·설치 제품 연결 검증

클라우드 체크아웃과 인증/DB 시험 환경을 유지한 채 작업 브랜치
`codex/cloud-auth-foundation-20261008`에서 구현했다. 사용자 회사 노트북 설치,
PR·main 병합·운영 배포·영구 운영 자격 발급·실제 외부 송신은 실행하지 않았다.
포트 3001에 접속·바인딩·종료하지 않았다. 원격 푸시는 부모 스레드의 별도 승인
범위에서 검증된 묶음만 수행했다.

소스 기준 진행은 **구현 94 / 부분 30 / 미착수 48, 총 172**다.
GW-52/53/54의 서버 producer를 구현으로, GW-35/36/51을 부분 구현으로 갱신했다.
전체 제품군 통합 인수와 고객 VM 설치 인수는 **미완료**다. 초기 66/19/87 감사
baseline과 이전 checkpoint는 보존했다. 남은 기능은 78개이며 ready=0이
기술 구현 소진을 뜻하지 않는다.

## 구현 묶음과 실제 범위

- [Talk BFF bc949abd](https://github.com/wnwjdals7498/j-groupware/commit/bc949abd081477cac26e3c41a4e0311bd377c091):
  쿠키 세션→서비스별 단일 audience 교환으로 room 목록·상세·메시지,
  자기 배정·답장·종료와 Origin/page/widget key 설정을 중계했다. role·CSRF·tenant,
  경로/본문 검증과 최대 1MiB 응답 및 필드 projection을 적용했다. 실제 방문자
  room 생성·WSS 전달·손님 이름 조회·정식 화면은 구현으로 표시하지 않았다.
- [콘솔 producer 998a48ab](https://github.com/wnwjdals7498/j-groupware/commit/998a48abe1e66f2aefd88d28fa6adda07627107c):
  실제 j-auth 고객 realm 생성·bootstrap1회 반환, 키 hash만 저장, secret 유실
  durable 상태와 명시 reset, 가입 desired revision→실제 인증 반영·비교·재시도,
  agent Bearer key의 tenant/epoch/revision/report sequence·재전송·회전·회수를
  구현했다. 고객 목록/상세는 안전한 저장 snapshot을 반환하며 업무 계약 상태
  enum·변경 정책을 만들지 않았다. desired/인증 상태/설치 보고는 구분된다.
- [제품 연결 39afec80](https://github.com/wnwjdals7498/j-groupware/commit/39afec80ce10be358dde94b395821903bfb7eb99):
  5개 제품의 정확한 env·DB/role·TLS/loopback 설정, 별도 Messenger cursor key,
  기존 env 재사용/변조 거부, 실제 HTTPS 준비 probe와 durable active 기반
  설치 목록, 부분 설치 재시도/해제, actual Nginx worker 확인·rollback을 연결했다.
  모순된 installed/incomplete와 거짓 synchronized 보고를 거부한다.
  native privileged 명령의 환경에서 상속 loader hook을 제거했다.
- [내부 번들 a6816a1b](https://github.com/wnwjdals7498/j-groupware/commit/a6816a1bd1051b35a4d81a3248897dd2aaa41b10):
  compiled server/contracts·고정 migration·Talk widget·Web helper 구성만 포장하고
  native preflight metadata·파일 digest·정확한 lockfile을 만든다. local contracts를
  cold workspace로 연결하고 install scripts·registry publish를 실행하지 않는다.
  symlink·비관리/과도한 입력·unpinned 직접 의존성·출력 덮어쓰기를 거부한다.
  준비되지 않은 customer-auth와 기본 groupware bootstrap bundle은 거부한다.
- [알림·Web 해지 연결 2b960e2b](https://github.com/wnwjdals7498/j-groupware/commit/2b960e2b33a045499b66c9b48b832e22c18793d3):
  설치기 key hash manifest를 기존 실제 가입 투영기에 연결했다. 준비 probe 뒤
  등록하며 upstream 장애 시 파일/세대를 보존해 같은 키로 재시도하고 해지 시
  수신 키를 제거한다. 키 원문이나 임의 자동 회전은 manifest에 넣지 않는다.
  Web 해지는 root 소유 고정 helper의 remove-all만 호출하며 업로드 파일을
  백업으로 보존한다. native stop/ready도 관리 unit 내용·소유권이 다르면 거부한다.

## 실행한 검사

모든 아래 최종 명령은 exit0이다. 실패한 최초 시도나 미실행 인수는 포함하지 않는다.
Node 버전은 22.18.0 / 24.19.0이며 통합 검사에는 실제 Keycloak·j-auth·PG18.6과
각 제품의 이미 준비된 격리 자원을 사용했다. 제품마다 cold 전체 기동 범위는 다르다.

| 검사 | Node22 | Node24 | 관찰 범위 |
|---|---:|---:|---|
| 전체 BFF 통합 | 148 | 148 | 10개 파일, 실제 인증·서비스 연결·콘솔 producer·Talk relay·manifest, skip0 |
| 콘솔 단독 최종 | 16 | 16 | 실제 realm/가입·실패 복구·agent transport; 전체 BFF에서도 재검사 |
| Talk BFF 단독 최종 | 5 | 5 | 실제 compiled Talk+PG, role/tenant/CSRF·업무·설정; 전체 BFF에서도 재검사 |
| agent 준비/조정 | 20 | 20 | 실제 private 파일·fixture 설치 프로세스·잠금·부분 할당 repair/remove, skip0 |
| 제품 env/probe | 5 | 5 | 5제품 compiled config loader, 실제 Talk/Web HTTPS+PG, 실패 probe·inventory |
| cold 번들 | 4 | 4 | 5제품 archive/lock/실제 npm ci/import, extracted Talk/Web 기동·widget 바이트 |
| 실제 Nginx | 15 | 15 | Docker Nginx TLS/WSS·limits·정상/실패 worker 교체·installer gateway, skip0 |
| installer 알림 투영 | 13 | 13 | 전체 BFF 중 해당 파일 13개; 실제 j-auth·PG·수신기와 hash manifest 장애/복구/제거 |
| 실제 Web 해지 | 2 | 2 | root helper·계정/경로 정리·업로드 백업·gateway 보존·재실행·loader hook 거부 |
| 실제 agent DB 재검사 | 3 | 3 | PG18.6 DB/role 격리·덤프 복원·NOLOGIN·타 DB 보존, 순차 실행 |
| 전체 check | — | 76 | build·typecheck·단위 검사·lint·format 모두 통과 |

콘솔 customer:read 제한 검사는 신뢰한 저장 세션 role을 축소한 fixture도 사용했다.
그 부분을 별도 read-only 실제 발급 JWT로 검증했다고 주장하지 않는다. 회선 장애는
실제로 닫힌 격리 loopback 대상으로 연결을 실패시켜 desired 보존·auth 실패와
실제 j-auth 재시도를 확인했다. secret 유실은 실제 PG trigger로 완료 저장을
거부하고 생성된 realm을 확인한 뒤 명시 secret reset으로 복구했다.

상담 room은 회원 workflow 검사 목적의 PG 저장 fixture로 심었다. 이는 방문자 인증과
room 생성 성공 증거가 아니다. 제품 readiness는 실제 TLS와 DB migration 조회를
확인하며 통합 업무 전체 성공을 뜻하지 않는다. cold Approval/Mail/Messenger는
의존성 설치와 compiled config import까지만 검사했다. root systemd 명령은 기동하지
않았으며 read-only unit syntax 검사와 root 거부 검사를 유지한다.

Web root fixture 내부 런타임은 고정 Node22.18 이미지이고 Node22/24 숫자는
검사를 실행한 orchestrator 버전이다. 실제 systemd unit stop/start는 실행하지
않았다. unit/DB 생성 전에 실패한 부분 할당의 단계별 해지에는 추가 기술 작업과
실제 객체 확인이 필요하며 자동 완료/purge로 처리하지 않는다.

최종 로그는 Git 밖 `/workspace/.suite-runtime/j-groupware/`에 보관한다:
`connected-producers-bff-node{22,24}-final.log`,
`console-producers-node{22,24}-final.log`, `talk-relay-node22-final.log`,
`talk-relay-node24-attempt3.log`, `agent-partial-node22-final.log`,
`agent-partial-node24-attempt1.log`, `agent-products-node{22,24}-final.log`,
`agent-gateway-node22-final.log`, `agent-gateway-node24-attempt1.log`,
`agent-bundles-node22-final.log`, `agent-bundles-node24-attempt2.log`,
`agent-products-check.log`, `agent-bundles-check-final.log`,
`installer-notification-bff-node{22,24}-final.log`, `agent-cleanup-node{22,24}-final.log`,
`agent-database-cleanup-node{22,24}-serial-final.log`, `agent-web-cleanup-node24-final.log`,
`agent-web-cleanup-node22-post-review-final.log`, `installer-cleanup-check-post-review-final.log`.

최초 Talk fixture의 optional DB env 검증 오류, 이전 콘솔 route 기대값,
제품 시험의 Keycloak 설정 누락/불필요한 resolver import와 최초 bundle registry
설정 누락·시간 초과는 수정 후 재검사했다. 해당 실패 로그도 유지하며 통과로
계산하지 않았다. 테스트가 소유한 임시 파일·cold 설치·컨테이너만 정리했다.
알림 manifest 제거 후 수신기 기대 상태는 key가 삭제된 401로 수정해 실제
부정 인증을 확인했다. 큰 컨테이너 동시 검사로 발생한 PG ENOSPC 실패는
통과에 포함하지 않았고 owned 임시 자원 정리 후 Node22/24 각각 순차 3개를
다시 실행해 exit0을 확인했다.

## 남은 기술 작업과 실제 결정

설치기에는 기본 groupware bootstrap bundle·안전한 unpack/dependency 설치·root
권한/helper 고정 설치, 제품별 쓰기 저장소 준비 및 Web 외 backup/cleanup,
알림 projection의 실제 자격 source/주기 worker 활성화, CLI/agent entrypoint·timer
연결과 생성 전 실패의 단계별 teardown이 남았다. customer-auth backend와
손님 API/API-key도 남은 독립 기술 작업이다. 이들은 테스트 환경 전체가 막아서
미구현인 기능으로 표현하지 않는다. G18/G21의 전체 install/remove는 partial이다.

제품 결정/인수 경계:

- T2: 방문자 토큰 수명·회전/회수·브라우저 WSS 인증 방식 및 guest/room 소유 충돌.
- E8: 전체 SMTP envelope 보존 방식과 FS-U07의 webhook 전 누락 허용 범위.
  기존 권고/대안은 [감사 기록](cloud-remaining-feature-audit-2026-10-08.md)에 있으며
  선택 없이 durable ingress나 Mailpit fork 범위를 확대하지 않았다.
- H7: 수동 SFTP/FTPS 파일과 템플릿 재배포의 덮어쓰기 기준.
- 정식 UI 기준 문서가 없으며 업무 계약 상태 enum·전이도 확정된 근거가 없다.
- 실제 고객 VM 대상·20GB 별도 데이터 디스크·firewall/systemd·OS CA 신뢰와
  자동 timer/실제 browser·visitor 상담 인수는 미실행이다.

[진행표](implementation-progress.json), [남은 기능 감사](cloud-remaining-feature-audit-2026-10-08.md),
[제품 adapter 안내](../deploy/agent/provisioning.md), [번들 안내](../deploy/agent/bundles.md)를 따른다.
