# 기본 BFF·안전 설치·부분 해지·알림 작업자 검증

클라우드의 준비된 체크아웃과 실제 인증/PG 환경을 확인하고 작업 브랜치
`codex/cloud-auth-foundation-20261008`에서 구현했다. 회사 노트북 설치와
포트 3001 접속·바인딩·종료를 수행하지 않았다. 아래 소스 묶음은 검증 후
별도 승인 범위에서 푸시했으며, ls-remote와 GitHub commit API의 SHA가
일치했다. PR·main 병합·운영 배포·영구 자격 발급·operating timer 등록·실제
외부 전송은 실행하지 않았다.

진행은 **구현 94 / 부분 30 / 미착수 48, 총 172**로 유지한다. 이번 변경은
GW-40/63/64/65/66의 부분 구현 범위를 늘렸다. 고객 VM과 전체 제품군 통합
인수는 미완료이며, 초기 66/19/87 baseline과 기존 checkpoint는 보존했다.

## 소스 묶음

- [aa2a2f13e88fa1e6959ccb08c276434a8e7c831f](https://github.com/wnwjdals7498/j-groupware/commit/aa2a2f13e88fa1e6959ccb08c276434a8e7c831f):
  기본 BFF의 server/contracts/permissions/bff-auth 번들, 봉인된 bootstrap
  읽기와 실제 BFF env 변환, 제한 USTAR 스트림 해제·digest/inventory/lock 검증,
  scripts-disabled npm ci와 독점 목적지/완료 marker를 구현했다. 기존
  비관리 디렉터리와 변경 파일을 보존하며 실패한다. 준비 상태는 실제 TLS와
  등록 Host/SNI를 검사한다.
- [e00000f9f2d0b8f2f7ec1ecaac5c12dce41deaa5](https://github.com/wnwjdals7498/j-groupware/commit/e00000f9f2d0b8f2f7ec1ecaac5c12dce41deaa5):
  실제 PG 소유 표시와 DB/role 유무를 확인해 pre-DB와 role-only 실패를
  해지한다. 없는 DB에 백업 성공을 만들어내지 않고, 표시된 역할은 NOLOGIN으로
  전환한다. 다른 소유자와 관측 후 생긴 DB는 거부한다. Approval/Talk은
  별도 파일 저장소가 없어 백업/NOLOGIN 뒤 PG와 번들을 보존한다. 없는 unit은
  systemctl의 not-found/inactive/빈 fragment 관측을 요구한다. 이 unit 경로는
  [공식 systemd 소스](https://github.com/systemd/systemd/blob/v257/src/systemctl/systemctl-show.c)와
  parser/문법 검사까지 확인했으며 실제 systemd 해지는 미실행이다.
- [ea24dd34636bcfebbf89ec26d87c79831a577ece](https://github.com/wnwjdals7498/j-groupware/commit/ea24dd34636bcfebbf89ec26d87c79831a577ece):
  private 외부 short-lived operator 자격 파일→실제 구독 조회→PG 투영/
  hash manifest를 연결했다. 토큰을 발급·갱신하거나 BFF에 배치하지 않는다.
  실제 1회 CLI와 비활성 service/timer source 예시를 추가했다. cold worker
  import에 필요한 undici를 런타임 의존성으로 고정했고 의존성 실패/취소의
  프로세스·stage·lock 정리도 검증했다.

주요 코드와 실행 계약은 [bundles.md](../deploy/agent/bundles.md),
[provisioning.md](../deploy/agent/provisioning.md),
[notification-worker.md](../deploy/agent/notification-worker.md)에 있다.

## 실제 검사

| 검사 | Node22.18 | Node24.19 | 실제 범위 |
|---|---:|---:|---|
| 전체 BFF | 158 | 158 | 실제 j-auth/Keycloak/PG와 기존 업무 API·투영·cold BFF·worker |
| safe unpack | 19 | 19 | 기본 BFF/Talk 실제 npm ci·cold import·hash/권한·14종 위험 tar·기존 파일·실패/취소 |
| 기본 bootstrap BFF | 4 | 4 | 봉인→안전 설치→실제 로그인·PG 게시판·tenant/CSRF/Host/로그아웃; 전체158에 포함 |
| notification worker | 6 | 6 | 실제 auth/PG/private 수신·만료 비활성화·같은 세대 복구·CLI·private 파일·unit 문법; 전체158에 포함 |
| 실제 PG 설치/해지 | 6 | 6 | 실제 role/DB 생성·dump 복원·NOLOGIN·생성 실패 role-only·외국 소유 거부·관측 변화 |
| agent core | 20 | 20 | 실제 private 파일/프로세스/잠금과 명시적인 내부 lifecycle ports |
| 제품 환경/준비 | 5 | 5 | 실제 compiled 환경과 Talk/Web PG·TLS |
| 제품 cold 번들 | 4 | 4 | 기존 다섯 제품 실제 npm ci, Talk/Web cold 기동/widget |

모두 exit0, skip0이다. Node24 전체 `npm run check`는 **76개 단위 검사와
build/type/lint/format**을 통과했다. 기존 실제 Nginx15와 Web cleanup2는
이전 보고서의 통과 기록을 유지하며 이번 묶음에서 다시 실행했다고 주장하지
않는다. PG 부분 해지 검사에서 unit·gateway·notification은 명시적인 내부
component ports를 사용했다. 실제 PG 결과를 customer systemd/전체 해지
성공으로 취급하지 않는다. Node22/24 worker CLI는 각 버전의 실제 Node
프로세스다. 운영 타이머는 생성하지 않고 read-only 문법만 검사했다.

실패도 보존했다. 초기 unpack은 실행 사용자 umask와, 뒤의 cold worker
import는 개발 의존성에만 있던 undici 때문에 실패했다. 권한 정규화와
런타임 의존성 보완 후 최종19가 통과했다. 첫 신규 전체 BFF 검사에서는
compiled 수신기 재시작1이 실패했다. 이후 단독 projection13 및 단독 전체
Node22/24 158개가 통과했지만 초기 기동 실패 원인은 특정되지 않았다.
해당 로그는 실패로 남기며 전체 인수가 안정적이라고 판정하지 않는다.

외부 증거 디렉터리: `/workspace/.suite-runtime/j-groupware/`.
최종 로그는 `notification-worker-full-bff-node22-serial-final.log`,
`notification-worker-full-bff-node24-serial-final.log`,
`notification-worker-unpack-node22-final.log`,
`notification-worker-unpack-node24-attempt2.log`,
`notification-worker-check-node24-post-review-final.log`,
`agent-partial-teardown-db-node22-final.log`,
`agent-partial-teardown-db-node24-final.log`이다. 임시 archive/추출 디렉터리와
자신의 PG fixture 컨테이너만 정리했다. 다른 작업자의 파일/컨테이너는 보존했다.

## 남은 연결 작업과 실제 인수

- 전용 systemd 서비스 사용자가 private CA/TLS 키에 접근하도록 OS credential/
  권한을 준비하고 전체 base bootstrap·installer·agent 실행 진입점을 연결해야 한다.
  현재 cold 기동은 클라우드의 동일 실행 사용자 범위다.
- Messenger 파일 저장소, Mailpit 저장소, customer-auth의 정리/백업과 Web OS
  storage/helper 초기 설치가 남았다. 제공되지 않은 cleanup은 실패한다.
- 운영 notification 자격 갱신 주체/토폴로지와 worker/timer 활성화, 고객 VM의
  20GB 디스크·systemd·firewall·CA 신뢰·브라우저/전체 설치·해지 인수는 미실행이다.
- customer-auth DB/member/API-key backend는 다음 독립 구현 경로다. ready=0은
  안전한 기술 구현이 모두 소진되었다는 뜻이 아니다.
- T2 visitor/WSS, E8 full envelope/FS-U07 수신 전 누락, H7 수동 업로드 재배포,
  정식 UI 기준/브라우저 인수의 기존 경계는 유지한다.
