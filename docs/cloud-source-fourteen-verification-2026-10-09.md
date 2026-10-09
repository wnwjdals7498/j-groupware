# Task 25 미착수 소스 14개 구현과 클라우드 검증

소스 14개와 실제 클라우드 Groupware BFF 전체 회귀 196개를 Node 22/24에서 검증했다. 실제 고객 Hyper-V VM 8개 인수는 환경 위치와 실행 승인 대기이며 미실행이다. `whole_suite_verified=false`를 유지한다.

## 구현 묶음

| 기능 | 구현과 검증 기록 |
| --- | --- |
| AU-09 | Keycloak jgw 테마·읽기 전용 mount·실제 Chromium 렌더링. [Auth 기록](../../j-auth/docs/cloud-login-theme-verification-2026-10-09.md) |
| GW-71 | [UI 기준](ui-guidelines.md), `packages/ui`의 React 공통 컴포넌트·CSS 토큰, 360px/1440px 실제 Chromium. |
| MS-07 | 공개 client-react 0.2.2의 토큰·CSS와 실제 설치 패키지 화면. [Messenger 기록](../../j-messenger/docs/cloud-ui-token-verification-2026-10-09.md) |
| TK-04·05·06·07·08·10·11·12 | 출처별 credential 보관·회전, signed guest 연결, 익명/서명 예제, visitor 메시지·outbox, WSS와 signed cursor 복구, 429 안내. [Talk 기록](../../j-talk/docs/cloud-visitor-transport-verification-2026-10-09.md) |
| ML-20 | 전체 SMTP RCPT capture와 Mailpit ID 연결, 동일 PG transaction의 outbox, GWA receiver 중단 뒤 재시도. [Mail 기록](../../j-mail/docs/cloud-mail-notification-implementation-2026-10-09.md) |
| WB-12 | revision 검사·수동 파일 보존·원자 index 배포·중단 journal 복구. [Web 기록](../../j-web/docs/cloud-template-deployment-verification-2026-10-09.md) |
| GW-38 | Web 배포 성공과 Talk Origin 후속 결과를 분리하고 권한이 없을 때 `pending_permission`, 실패 시 `failed`, 성공/중복 등록 시 `registered`를 반환한다. 배포 성공은 유지한다. |

## Groupware 연결

`@j-talk/contracts`와 `@j-web/contracts`는 immutable 0.2.1, `@j-messenger/client-react`는 0.2.2를 정확하게 설치한다. 중간 게시 버전은 덮어쓰지 않았다. 공통 UI의 Button·TextField·Card·AppShell·DataTable·Dialog·EmptyState·Alert는 semantic markup·키보드 focus·label/error association을 제공한다. Messenger 공개 CSS는 공통 `--jgw-*` 변수를 사용한다. 실제 설치한 CSS와 소스 build CSS의 SHA-256은 `68e59cbc80e052fb1b322243cbd772036ac24193754f30807d8e8932dba8617a`로 일치했다.

회원 `/api/talk/ws`는 정확한 Origin·쿠키 세션·현재 `talk:read`를 검사하고 서버에서 교환한 Bearer로 내부 Talk WSS를 연결한다. query token은 거절한다. 기존 Messenger relay와 같은 세션 허브를 사용하고 실제 권한 회수는 이미 연결된 소켓도 닫는다. `/api/talk/sync`는 bounded typed DTO와 서명 cursor를 중계한다. 메시지 작성자 member/visitor는 둘 중 하나만 허용한다. 정상 사이트 guestId는 UUID가 아니어도 읽을 수 있지만 customer-auth 이름 조회는 UUID만 사용한다. 허용 문자를 어긴 저장 값은 503으로 거절하고 customer-auth 경로로 보내지 않는다.

Web 배포 후 Origin 등록은 회원 현재 `talk:write`가 있을 때만 수행한다. 실제 Web/Talk/PG fixture에서 `web:write`만 있는 회원의 배포 성공·미등록과, `talk:write`까지 있는 회원의 동일 revision 재시도·Origin 한 건 등록을 확인한다. upstream 오류 본문이나 토큰을 사용자 응답에 넣지 않는다.

## 실행 결과와 환경 한계

Auth 통합 74개, Mail 통합 19개, Talk 최종 통합 25개, Web PG/HTTPS 15개와 hosting journal 5개가 Node 22.18.0/24.19.0에서 각각 통과했다. 각 모듈 전체 `check`, Messenger client-react 13개와 공통 UI unit·실제 Chromium도 실행했다. Groupware 전체 BFF는 두 런타임 모두 15개 파일·196개 시험·실패/skip 0·exit 0이다. 최종 로그는 `task25-gwa-bff-final-r3-node22.log/.exit`와 `task25-gwa-bff-final24.log/.exit`다.

Talk/Web 계약 0.2.1의 새 registry 소비자는 두 런타임 모두 source pack SHA-512와 불변 게시 integrity 일치·정확 버전 설치를 확인했다. Messenger 소비자는 client-react 0.2.2의 공개 타입·브라우저 build·CSS 토큰·React 단일 인스턴스와 중복 게시 거절도 확인했다. 최종 로그는 `task25-talk-registry-final22/24`, `task25-web-registry-final22/24`, `task25-ms-registry-owned-final22/24`의 `.log/.exit`이며 모두 exit 0이다.

Groupware 최종 `check`는 Node 22/24에서 각 서버 unit 83개·UI unit 3개와 build/typecheck/lint/format을 통과했다. 로그는 `task25-gwa-check-final4-node22`와 `task25-gwa-check-final-r2-node24`다. 의존성 보존 이동 뒤 `task25-ui-post-preserve22/24`에서 설치한 공개 CSS를 사용하는 실제 Chromium 시험을 각각 1개 다시 통과했다. 선택 제품 6개의 cold archive·정확 dependency lock·신규 `npm ci`·실제 Talk/Web PG/TLS 부팅은 `task25-gwa-bundles-final22/24`에서 각 4개 시험·exit 0이다. 고객 VM 설치가 아니라 owned fixture 결과다.

초기 BFF 실행에서 `/tmp`의 sandbox UID 65534가 private-file ancestry 검사에 걸렸다. 보안 검사를 변경하지 않고 앱 fixture를 UID 1000 소유 workspace 임시 경로로 돌렸다. 다음 실행은 customer-auth cold bundle의 ENOSPC와 Messenger 1GiB reserve 부족으로 188/196 통과·8 실패였다. 이번 작업의 node_modules 5개를 여유 있는 `/tmp`로 보존 이동했으며 49,365개 파일의 SHA-256이 모두 같고 외부 workspace symlink만 실제 대상으로 보정했다. 기록은 `/tmp/jgw-task25-preserved-ndfnh4uv/post-final-install/preservation.json`에 있다. 캐시·다른 사용자 자료·실패 로그를 삭제하지 않았다.

다음 전체 실행의 customer-auth 두 번째 child startup 실패로 19개가 skip됐고, 해당 run은 실패로 기록했다. 분리 재현은 18개가 통과하고 정상 opaque guestId와 악성 경로 문자의 기존 계약 불일치 한 건을 발견했다. BFF decoder가 Talk의 기존 허용 문자 규칙을 같이 검사하도록 수정했으며 malformed 값 거절·무조회 assertion은 유지하고 권한 없는 경로도 503으로 강화했다. 정상 opaque 구분자 이름은 null이다. 실패·skip·미실행은 통과로 집계하지 않는다.

한 차례 발생한 두 번째 child startup 실패의 상세 원인은 미확정이다. 이후 양쪽 런타임 전체 회귀에서 customer-auth 19개가 모두 실제 실행·통과했으며 초기 skip 결과는 보존했다. 연결 끊김 안내 후에도 환경·로그·exit 파일에 접근할 수 있음을 다시 확인했다. 사라진 실행 결과를 성공으로 계산하지 않았다. [최종 실행 증거 JSON](cloud-task25-test-results.json)은 실제 exit 0·관찰된 시험 수·로그 SHA-256과 네 번의 실패 기록을 구분한다. runtime 첫 줄이 없는 이전 로그는 해당 메타데이터 한계도 표시한다.

마지막 연결 review에서 Talk가 gateway 뒤의 발급 IP를 loopback 하나로 묶는 문제를 고쳤다. 즉시 IPv4 loopback 첫 hop만 신뢰하고 기존 gateway의 전달 IP 덮어쓰기와 맞췄다. 실제 HTTPS·PG에서 IP별 10회/11회, 다른 IP의 독립 발급, 위조된 앞쪽 chain과 다른 peer의 전달 header 우회 거절을 검증했다. 추가된 하나를 포함한 최종 Talk 25개와 package check는 `task25-talk-gateway-check22/24`, `task25-talk-gateway-integration22/24`에서 각각 exit 0이다. 이는 OS/VM 보안 설정 변경이 아니다.

회사 노트북·운영 계정·새 영구 credential·CA trust·방화벽·systemd/timer·PR/main 병합·운영 배포는 변경하지 않았다. Windows PMT 상태 경로와 해당 start/note/verify/end 도구는 이 클라우드에서 없어 그 기록만 미실행이다. 저장소 지침과 실제 소스·시험 증거는 저장소 문서에 남긴다.

실제 VM AU-51·GW-73·MS-09·ML-32·CA-32·AP-32·TK-42·WB-33은 모두 `not_run`이다. [collector 준비 기록](cloud-acceptance-collector-verification-2026-10-09.md)의 11개 HTTPS fixture 시험은 VM 인수 통과를 뜻하지 않는다. 정식 업무 화면·운영 notification owner/회전/topology와 첫 고객 bootstrap 인수도 별도다.
