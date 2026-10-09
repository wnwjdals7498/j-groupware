# 20차 네이티브 진입점·저장소 검증

2026-10-09. 클라우드 체크아웃의 `codex/cloud-auth-foundation-20261008`에서
기존 변경을 보존하고 진행했다. 구현 소스·격리 시험·운영 설치와 인수는 구별한다.

## 구현

groupware 소스는 [b4e4310919edd2189c6f45e8768c7aa19dc29821](https://github.com/wnwjdals7498/j-groupware/commit/b4e4310919edd2189c6f45e8768c7aa19dc29821)로 커밋·푸시하고 `ls-remote`와 GitHub exact SHA를 확인했다.

- [ProductStorage](../deploy/agent/product-storage.mjs): 고정 서비스 계정과
  root 소유 allocation/state, Messenger 파일 및 Mailpit 볼륨 준비, 정지 확인,
  실제 PG custom archive와 파일의 private snapshot/hash/topology 검증, 재시도,
  변조·hardlink·symlink·예산 초과 거절과 보존 정리.
- [MailpitPlatform](../deploy/agent/mailpit-platform.mjs): 기존 capture profile의
  이미지 digest·테넌트·loopback·UID/GID·bind·실행 설정 소유권을 확인하고
  자기 컨테이너만 제어한다. daemon 실패/외부 설정을 absent로 취급하지 않는다.
- [고정 진입점](../deploy/provision-service)과
  [native 조합](../deploy/agent/provision-service.mjs): 기존 봉인 자격·private
  profile·고정 PG/서비스/저장소/gateway 어댑터를 연결한다. 현재 CA/Messenger
  source binding이며 다른 제품은 운영 owner 미연결을 변경 전에 거절한다.
- [lifecycle](../deploy/agent/service-lifecycle.mjs): storage preflight를 DB 할당/
  서비스 정지보다 먼저, 실제 계정 설치 뒤 storage prepare를 기동보다 먼저
  수행한다. S14의 stop→PG dump→NOLOGIN→제품 정리 순서와 durable storage
  backup 경로를 유지한다.
- [안전 unpack](../deploy/agent/bundle-install.mjs): 검증된 기본 번들의 고정
  wrapper만 0755로 복원하고 재시도 때 권한 변조를 거절한다. 임의 script의
  실행 권한을 복원하거나 위험 archive 검사를 완화하지 않는다.
- j-mail [92809bc96ca75e1ccfd552f7247d989f6e8f28a2](https://github.com/wnwjdals7498/j-mail/commit/92809bc96ca75e1ccfd552f7247d989f6e8f28a2):
  기존 Mailpit profile을 contracts 0.1.1로 공유했다.
  [2e0a6555a015cc43679332c3028148ce2fe1ae11](https://github.com/wnwjdals7498/j-mail/commit/2e0a6555a015cc43679332c3028148ce2fe1ae11):
  실제 레지스트리 소비와 0.1.0 integrity 불변을 검증한다.

## 완료된 실행과 현재 경계

| 검사 | Node22.18 | Node24.19 | 실제 범위 |
| --- | ---: | ---: | --- |
| root storage/native 격리 | 5 pass·exit0 | 5 pass·exit0 | 실제 nologin 계정, 파일 권한, PG dump/restore, SMTP capture/SQLite restore, native control/factory/wrapper의 inert/거절 경계 |
| agent core | 21 pass·exit0 | 21 pass·exit0 | 기존 20 + 미연결/foreign storage의 allocation/stop 이전 거절 |
| fresh cold unpack | 19 pass·exit0 | 19 pass·exit0 | 새 모듈의 실제 fresh install/inert import, wrapper 0755와 변조 거절, 기존 archive/취소/보존 회귀 |
| groupware check | 77 pass·exit0 | 77 pass·exit0 | build/type/unit/lint/format |
| mail check | 9 unit+3 deploy·exit0 | 9 unit+3 deploy·exit0 | build/type/lint/format 포함 |
| mail registry | 1 pass·exit0 | 1 pass·exit0 | 실제 0.1.1 소비·pack integrity와 0.1.0 불변 |
| 전체 BFF 최종 회귀 | 179 pass·exit0 | 179 pass·exit0 | 각각13개 파일·skip0; focused 검사를 중복 합산하지 않음 |

전체 BFF179의 최종 재검증은 두 Node에서 완료했다. 첫 실행은 175 pass·4 skip·exit1이며
새 wrapper의 허용 경로 누락으로 bootstrap beforeAll이 실패했다. 4개를 통과로
합산하지 않는다. 정확한 경로를 추가한 뒤 cold19는 두 Node에서 통과했다.

root/account/권한 시험은 owned 임시 컨테이너만 사용했다. 실제 PG 데이터의
custom dump를 복원해 fixture 행을 확인했고, 정지된 Mailpit data를 다른 owned
볼륨에 복원해 같은 수신 ID·제목·본문을 조회했다. Messenger 파일 바이트도
복원했고 아직 실행 중인 파일 writer, 중지 뒤 재시작한 Mailpit, 변조·추가
파일·hardlink/symlink·무표시 컨테이너를 거절했다. 컨테이너·임시 파일만 정리했다.

native 검증은 control loader/factory/argv와 실제 wrapper 거절 경계다. 실제
systemd PID1로 서비스를 설치한 시험이 아니다. PG 복원 테이블은 독립 fixture이며
Messenger private 테이블을 직접 조회하지 않았다. Messenger 공개 모듈의
file-reference/session purge 의미적 복원 인수는 미실행이다.

## 실패 보존

초기 격리 실행은 fixture 의존 pg-int8 누락, PG parent 0700의 계정 traversal
거절, 초기화 임시 PG의 readiness 오인, public test code 접근 mode, 종료된
fixture PID의 proc ESRCH로 실패했다. 이후 소유 Mailpit 검사에서 image/container
healthcheck 객체의 동일 필드가 다른 순서인 것을 잘못 비교해 실패했다.
필드·값을 그대로 검증하면서 순서에 영향받지 않게 수정했다.
실패 로그와 exit1은 보존하고 성공에 합산하지 않는다. 이전 묶음 receiver
startup 실패 원인은 여전히 미확정이며 이번 검증으로 해결됐다고 주장하지 않는다.

## 실제 미완료

전체 기본 bootstrap/나머지 native 제품 조합, operating notification 자격 갱신
소유자와 control-plane→고객 로컬 PG/private receiver 토폴로지, OS 계정 삭제와
실제 systemd/OS CA trust/20GB 디스크/고객 VM/방화벽/UI 인수는 미완료다.
T2/E8/H7/UI 답변 대기를 독립 소스 작업 전체의 차단으로 확대하지 않는다.
운영 자격 발급/갱신·timer 등록·외부 송신·회사 노트북 설치·PR/main/배포를
수행하지 않았다. 구체 계약은 [native 문서](../deploy/agent/native-installer.md)를 따른다.

현재 source 집계는 구현109·부분32·미착수31/총172, 남은63이다.
`whole_suite_verified=false`와 부분 구현 표시를 유지한다.
전체179·cold19·root5·core21·check77의 실제 로그와 exit0을 확인한 뒤 재감사를 갱신했다.
남은63의 첫 다음 단계는 독립 소스16·T2/E8/H7 정책21·UI 기준17·실제 VM9다.
[전체 63개 감사](cloud-remaining-feature-audit-2026-10-08.md)에 ID별 다음 단계와
전체 완료 관문을 적었다. 독립16 중 다음 유한 묶음은 Web H2 contracts/readonly
조회·입력 검증·미리보기·고정 snippet과 BFF 계약(7개 ID)까지다. H7 수동 파일
교체·T2 visitor 엔진·정식 UI·VM 인수로 확장하지 않는다. 전체 bootstrap/나머지
제품 조합과 콘솔/Talk 회원 계약도 남은 소스 작업이며 환경 차단으로 숨기지 않는다.
원격 SHA 확인 후 작업 브랜치가 원격과 일치하며 PR/main/배포는 수행하지 않았다.

실행 로그는 `/workspace/.suite-runtime/j-groupware/storage-*.log`와 대응 `.exit`다.
최종 root/core/cold/check는 `storage-{root,core,unpack,check}-node{22,24}` 이름이며
root/unpack/check에는 `-final`을 붙인다. 첫 실패 BFF는 `storage-full-bff-node22`,
최종 회귀는 `storage-full-bff-node{22,24}-final`이다. mail 로그는
`storage-mail-{check,registry}-node{22,24}`와 대응 `.exit`다.
