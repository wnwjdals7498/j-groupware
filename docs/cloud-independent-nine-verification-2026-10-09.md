# 22차 독립 9개 기능 연결과 검증

2026-10-09, 클라우드 `/workspace` 작업이다. 모든 저장소는
`codex/cloud-auth-foundation-20261008` 브랜치다. 회사 노트북·3001 포트·운영
OS 계정/패키지/trust/timer·새 영구 자격·외부 발송·PR/main 병합/배포는 수행하지 않았다.
시험에서 실제로 변경한 계정과 서비스는 이 작업이 만든 격리 컨테이너/fixture뿐이다.
`whole_suite_verified=false`를 유지한다.

## 기능과 연결

- TK-30: 방 INSERT와 같은 transaction의 `talk.new` trigger, 자기 배정마다
  새 occurrence UUID와 원래 담당자를 보존하는 `talk.assigned` outbox를 구현했다.
  PG SKIP LOCKED/20초 lease·lease token ACK, bounded HTTP·retry/backoff와
  실제 G22의 안정된 `room:occurrence` dedupKey를 연결했다. `talk.message`는
  이 sender가 소비하지 않는다. 새 공개 visitor producer는 구현하지 않았다.
- TK-41: 이전 registry 404를 확인한 뒤 최초 immutable
  `@j-talk/contracts@0.1.0`을 게시했다. 확정된 member/settings DTO·UUID schema·
  UTF-8 한계·occurrence 계약을 Talk와 BFF가 exact dependency/lock으로 소비한다.
  fresh 소비자의 pack SHA512를 비교했다. visitor/WSS/signed cursor 계약은 T2 뒤다.
- GW-65: [관리 계정 receipt](../deploy/agent/native-accounts.mjs)로 신규 생성/
  자기 소유 계정만 삭제한다. 살아 있는 UID process, 공유 UID/primary GID,
  속성 drift, 무표시·재사용 계정을 거절한다. `userdel -r` 없이 원본/백업을
  보존하고 이미 계정이 삭제된 뒤 실패한 해지를 재시도한다. durable
  `cleanupComplete` 이후는 account 조회를 반복하지 않고 보존 root/topology/
  numeric UID와 원본·backup·PG archive hash를 재검증한다.
- GW-40/64/66: [명시적 prepared binding](../deploy/agent/notification-binding.mjs)이
  기존 private worker/control·짧은 외부 자격과 실제 기본 BFF env를 연결한다.
  같은 tenant·auth origin·PG port/DB/user/password, 고정 env 경로와 readonly
  입력/manifest/native 출력 겹침을 검사한다. 실제 j-auth 구독 preflight가
  설치 bookkeeping/DB 변경보다 앞선다. factory에서 Approval/Talk를 연결할
  수 있으나 고정 CLI는 운영 owner 관문을 유지하고 Mail/Web도 미연결이다.
  자격 발급/refresh·운영 owner·timer를 추가하지 않았다. 실제 PID1 factory 전체
  설치 시험은 실행하지 않았다.
- GW-63/64/66: 고정 [bootstrap wrapper](../deploy/bootstrap), account/binding
  모듈을 기본 archive에 포함했다. hash 검증한 두 wrapper만 0755로 복원하고
  재시도 때 권한 변조를 거절한다. cold npm ci/import와 argv 거절을 시험했다.
  준비된 조합의 진입점이며 OS package/PG 서버/trust/full kit 완료는 아니다.

[Talk backend 기록](../../j-talk/docs/cloud-notification-contract-verification-2026-10-09.md),
[BFF 연결 기록](cloud-talk-notification-bff-2026-10-09.md),
[native 계약](../deploy/agent/native-installer.md)을 함께 본다.

## 실제 시험 결과

두 버전의 parent/child PATH를 각각 Node22.18.0/24.19.0으로 고정했다.
아래 수는 버전별 결과다. focused 시험을 전체 회귀에 중복 합산하지 않는다.

| 시험 | Node 22 | Node 24 | 종료 코드 |
|---|---:|---:|---|
| Groupware check: unit/build/type/lint/format | 80 | 80 | 각각 0 |
| 전체 실제 BFF 통합 | 191 / 15 files | 191 / 15 files | 각각 0, skip 0 |
| agent 파일/잠금/process/coordinator | 26 | 26 | 각각 0, skip 0 |
| 새 archive/npm ci/해제/import 회귀 | 19 | 19 | 각각 0, skip 0 |
| owned root account/storage/native guard | 6 | 6 | 각각 0, skip 0 |
| Talk check: unit/build/type/lint/format | 2 | 2 | 각각 0 |
| Talk 실제 PG/JWKS/회원 통합 | 14 / 2 files | 14 / 2 files | 각각 0, skip 0 |
| immutable registry/fresh consumer integrity | 1 | 1 | 각각 0, skip 0 |

전체191에는 Talk/G22 알림6과 prepared worker/binding7이 포함된다. 실제
j-auth/Keycloak 회원·token exchange·전용 PG·G22 list/SSE, 원래 담당자와
서로 다른 occurrence, 방/배정 rollback, receiver 중단·ACK PG 오류·중복 제거,
다중 sender lease와 tenant 격리, compiled Talk main SIGKILL 후 실제20초
lease 만료/모호한 수신 복구를 확인했다. 최초 방은 명시적 PG fixture다.
계정 시험은 owned root 컨테이너에서 실제 useradd/userdel/groupdel을 실행했다.
coordinator retry는 실제 durable 파일과 adapter 실패 경계의 시험이다.
root guard/import 및 prepared binding 시험을 실제 PID1 설치 성공으로 계산하지 않는다.

최종 로그와 exit 파일은 `/workspace/.suite-runtime/j-groupware/`에 보존했다.
`native22-bff-final3-node{22,24}`, `native22-check-final5-node{22,24}`,
`native22-agent-final2-node{22,24}`, `native22-storage-final2-node{22,24}`,
`native22-unpack-final-node{22,24}`, `talk22-{check,integration,registry}-node{22,24}`다.

실패도 보존했다. 최초 전체 BFF는 기존 customer-auth fixture의 방 삭제가
새 outbox FK 때문에3개 실패했다. fixture의 자기 사건을 먼저 정리하도록 고쳤고
운영 FK는 유지했다. 다음 실행은 receiver 고정54260 포트 충돌로7개 미실행이었다.
fixture receiver를 OS가 선택한 loopback port로 바꿨다. 충돌의 기존 listener
주체/이전16차 receiver startup 원인은 단정하지 않는다. 이후 동시 검사에서
ENOSPC/fixture 초기화 실패가 있었으며 통과로 계산하지 않았다. 작업 전용
재생성 compile/transform cache만 정리하고 최종 큰 검사는 순차 실행했다.
초기 type declaration/import·fixture process reaping·formatting 오류와 이전
실패 로그도 남겼다. 연결 끊김 알림 뒤 파일/명령 접근 및 최종 종료 코드를
다시 확인했다. 종료 코드가 사라지거나 실행되지 않은 검사를 성공으로 합산하지 않았다.

## 기능 현황과 남은 작업

직전 구현113/부분35/미착수24 → 구현114/부분36/미착수22, 총172다.
TK-30만 독립 backend source 완료로 올렸고 TK-41은 부분 구현으로 올렸다.
남은59 → 58이며 9개 전체 완료를 주장하지 않는다.

첫 다음 단계는 독립 소스3, 서비스 선행1, 제품 정책28, UI17, 실제 VM9다.
분류 변경은 기능 구현 완료가 아니다.

| 독립 소스 ID | 남은 내용 |
|---|---|
| GW-63 | OS package/전용 PG/CA trust/full bootstrap kit의 소스와 준비 입력 |
| GW-64 | Web privileged native helper/SFTP·FTPS·gateway 및 나머지 제품 설치 조합 |
| GW-66 | full kit/one-shot agent와 남은 native installer 연결 |

GW-65의 관리 계정 해지/retry는 구현했지만 전체 해지는 GW-64 native 조합이
선행이다. 실제 고객 OS 설치·PID1 전체 native 흐름·CA trust/agent config/timer,
VM/20GB disk/firewall/정식 UI·Playwright 인수는 미실행이다.

새로 확인한 결정은 다음 두 가지다.

1. GW-51: 업무 계약 status enum·초기 상태·허용 전이·변경 권한·서비스 구독 영향.
   [G7 명세](feature-specifications.md)는 계약 조회/변경만 요구한다. 기존
   `registration`/`authState`는 bootstrap/인증 반영 상태다. 이를 업무 계약으로
   해석하거나 임의 상태값을 만들지 않았다.
2. TK-21: talk:write 담당자의 최소 같은-tenant 후보 조회 권한·대상 자격/가용성,
   BFF가 검증한 대상의 Talk 전달 계약.
   [현재 j-auth 권한 검사](../../j-auth/apps/server/src/security/authorize.ts)는
   member-read에 member:manage/org:manage를 요구한다. [S7](architecture.md#s7)은
   서비스 직접 호출/다른 DB 조회 대안을 허용하지 않는다. 과도한 회원 관리
   권한·새 assertion/token·최근 로그인 명단·검증하지 않은 UUID로 대신하지 않았다.

GW-40 운영 refresh owner/key 회전/control-plane·customer 로컬 PG/private receiver
배치, TK-41의 T2, E8/H7 및 기존 UI 기준은 기존 미승인 관문을 유지한다.

## 소스 커밋과 원격 확인

승인된 workbranch에 검증 후 즉시 푸시했다. `git ls-remote`와 GitHub commit
조회에서 정확한 SHA를 확인한다. 마지막 진행표/감사 문서 커밋은 별도다.

- Talk: [ff6d4eb706ff366e0c3babb4c8726cfed1793581](https://github.com/wnwjdals7498/j-talk/commit/ff6d4eb706ff366e0c3babb4c8726cfed1793581)
- Talk BFF: [95b4967a30012dfa7fbdcf20974e54c70d1606ff](https://github.com/wnwjdals7498/j-groupware/commit/95b4967a30012dfa7fbdcf20974e54c70d1606ff)
- native/account/binding/bootstrap 및 실제 회귀 수정: [a1f9d0be005ed2c0bc7af9d5e6b59c0a610d2d36](https://github.com/wnwjdals7498/j-groupware/commit/a1f9d0be005ed2c0bc7af9d5e6b59c0a610d2d36)

[진행표](implementation-progress.json)와 [남은 기능 감사](cloud-remaining-feature-audit-2026-10-08.md)의
집계/ID/code 경로/문서 링크를 검사했다. 명세 검사172기능·서비스 인수 정의60·
제품군 정의9·링크139의 성공은 문서 검증이며 인수 시험60/9을 실행한 뜻이 아니다.
