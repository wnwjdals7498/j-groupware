# 21차 기본 bootstrap·Web 계약/BFF 구현

클라우드 작업 브랜치에서 기존 변경을 보존하고 세 연결 묶음을 구현했다.
회사 노트북·PR/main·운영 배포/계정/영구 자격/timer 등록은 수행하지 않았다.
계정·파일·호스팅 작업은 owned 임시 컨테이너만 사용한다.

## 실제 변경

- [기본 bootstrap](cloud-base-bootstrap-composition-2026-10-09.md): 준비된
  봉인 입력/번들 전체 → 전용 PG → 동일 private BFF env → native
  platform/readiness → gateway. 실패 재시도·불일치 계획 거절과 초기
  preflight 이전 bookkeeping 쓰기 방지를 구현했다. CA/Messenger와 같은
  native control/state/lock/PG/gateway를 사용한다. 결과는 `base_ready`이며
  실제 OS 기반 설치/신뢰·agent config/timer·systemd 인수는 남는다.
- [Web backend](../../j-web/docs/cloud-content-contract-verification-2026-10-09.md):
  tenant PG 콘텐츠/revision·동시/stale409, bounded 정적 PNG·텍스트 검증,
  escape된 readonly preview, 고정 익명 widget 한 줄, 실제 용량/저장 상태/
  실패 단계 목록과 DNS A/hosts 안내. 저장/preview는 public root를 쓰지 않는다.
- [BFF 공개 route](../apps/server/src/web-routes.ts): 최초 immutable 게시한
  `@j-web/contracts@0.1.0`을 exact registry dependency/lock으로 소비한다.
  목록/상태/호스팅/DNS·사이트/계정·콘텐츠/preview를 실제 세션·CSRF·Web aud
  token exchange와 read/write 권한에 연결했다. 응답은2MiB 상한, 고정 필드,
  ID/tenant 도메인/상태를 검사하고 secret/임의 경로/하위 오류 원문을 중계하지 않는다.
  H7 deploy/origin 등록 route는 만들지 않았다.

## 실행 증거

| 검사 | Node22.18 | Node24.19 | 범위 |
|---|---:|---:|---|
| Groupware check | 80 pass·exit0 | 80 pass·exit0 | build/type/unit/lint/format; 기존77+Web 응답/입력3 |
| 실제 Web BFF focused | 5 pass·exit0 | 5 pass·exit0 | 실제 auth/PG/owned hosting·회귀 전체에 포함되므로 중복 합산하지 않음 |
| Web check | 6 unit+1 helper·exit0 | 6 unit+1 helper·exit0 | build/type/lint/format 포함 |
| Web 실제 integration | 14 pass·2files·exit0 | 14 pass·2files·exit0 | 실제 Keycloak/j-auth·PG·Nginx/OpenSSH/FTPS |
| Web registry | 1 pass·exit0 | 1 pass·exit0 | 최초 게시 pack SHA512·fresh exact consumer/lock |
| 기본 coordinator | 4 pass·exit0 | 4 pass·exit0 | durable retry/lock/plan/preflight; 실제 OS 설치와 구별 |
| root storage/native | 5 pass·exit0 | 5 pass·exit0 | loader/factory inert·CLI guard와 기존 실제 snapshot/restore |
| 전체 BFF | 184 pass·14files·exit0 | 184 pass·14files·exit0 | 두 버전 skip0; 미실행 인수와 구별 |
| agent 최종 | 25 pass·exit0 | 25 pass·exit0 | 기존21+coordinator4 |
| fresh unpack 최종 | 19 pass·exit0 | 19 pass·exit0 | 실제 새 archive/npm ci·새 모듈 inert import·위험 archive 회귀 |

npm 하위 명령도 각각 Node bin PATH로 고정했고 최종 로그에 실제 버전을 기록했다.
hosting helper 컨테이너의 내부 Node는 기존 고정22.18이다. 두 orchestration/API
런타임의 Node22/24 검증과 구별한다. 고객 실제20GB 디스크/VM·OS(systemd)
설치를 대신하는 fixture로 계산하지 않는다.

새 Web14와 BFF5는 실제 사이트/계정을 만들고 SFTP로 index를 올렸다.
콘텐츠 PG 저장·preview 뒤 같은 파일을 HTTPS로 읽어 보존을 확인했고, 새 API
instance에서도 같은 revision을 읽었다. 실제 동시 저장200/409와 stale409,
다른 tenant404·read/no-role403·CSRF403·잘못된 PNG/필드400을 확인했다.
계정 재설정·제거는 기존 fixed helper를 사용하고 PG 비밀번호/로그 비노출과
콘텐츠 FK cascade를 확인했다. DNS 안내는 제공 IPv4만 사용하며 DNS 변경이나
실제 외부 연결 성공을 주장하지 않는다. preview HTML escape/CSP를 검사했고
정식 브라우저 UI 인수는 실행하지 않았다.

## 진행표와 미완료

소스 집계는109/32/31 → **113 implemented·35 partial·24 not_started**다.
독립 backend/API WB-01·WB-02·WB-10·WB-11의 신규 코드를 구현해 남은63→59다.
WB-13은 preview에 고정 snippet이 있으나 모든 실제 공개 배포 페이지 적용은
H7 뒤이므로 partial이다. WB-31의 deployment request/state 계약, GW-37의
공개 배포·출처 연결/정식 화면도 partial이다. 이3개는 기존 H7 관문에 도달했으며
새 정책을 결정하거나 fixture 반복으로 기능 완료를 늘리지 않았다.

남은59의 첫 다음 단계는 독립9·정책24·UI17·실제 VM9다.
독립9: GW-40·GW-51·GW-63·GW-64·GW-65·GW-66·TK-21·TK-30·TK-41.
다음 유한 묶음은 Talk 관리/회원 DTO와 tenant 배정 대상·occurrence outbox이다.
visitor producer/WSS(T2), Mail envelope/outbox(E8), 수동 파일 공개 배포(H7)는
미승인이다. [ID별 감사](cloud-remaining-feature-audit-2026-10-08.md)를 따른다.
전체 OS 기반 bootstrap kit·나머지 native binding·OS account 제거 재시도는
독립 코드 미완료다. 운영 알림 refresh/key owner 및 control-plane/customer
PG/private receiver 토폴로지와 실제 systemd/CA trust/timer/VM/방화벽/UI 인수는
별도다. `whole_suite_verified=false`, 전체 인수 미완료를 유지한다.

## 커밋·실패 기록

- bootstrap: [90e2c46683040954b831edd60ce90475b36a1c4c](https://github.com/wnwjdals7498/j-groupware/commit/90e2c46683040954b831edd60ce90475b36a1c4c)
- Web: [2a1753fa4dffa048deadfa261014c8cb24e316b2](https://github.com/wnwjdals7498/j-web/commit/2a1753fa4dffa048deadfa261014c8cb24e316b2)
- bootstrap preflight 수정: [d2239666535bc2c6b00bd5e1aa5d47d6a8779d07](https://github.com/wnwjdals7498/j-groupware/commit/d2239666535bc2c6b00bd5e1aa5d47d6a8779d07)
- BFF: [6b33637c096414c6031067ba168616aeb0e35b83](https://github.com/wnwjdals7498/j-groupware/commit/6b33637c096414c6031067ba168616aeb0e35b83)

각 source를 커밋/푸시하고 ls-remote·GitHub exact SHA를 확인했다.
초기 root fixture443 URL·readonly bootstrap TLS source 분류·formatting 실패와
BFF unit fixture의 기본 AJV 추가 필드 제거 오류는 수정하고 exit1 로그를 보존했다.
unit fixture를 실제 BFF처럼 removeAdditional:false로 맞췄으며 입력 거절을
완화하지 않았다. 초기 npm의 parent Node만 지정한 실행은 최종 버전 증거로
사용하지 않고 하위 PATH까지 고정한 최종 실행을 사용한다. 이전 receiver
startup 실패 원인은 여전히 미확정이며 이번 성공으로 해결됐다고 주장하지 않는다.

모든 로그/exit는 `/workspace/.suite-runtime/j-groupware`다.
최종 `web-{full-bff,agent-final,unpack-final,bff-check-final,bff-focused}-node{22,24}`,
`web-content-{check,integration}-final-node{22,24}`, `web-content-registry-node{22,24}`,
`base-root-final2-node{22,24}`, `base-preflight-final-node{22,24}`를 사용한다.
preflight 수정 뒤 Node22 fresh unpack을 다시 실행한 최종 로그는
`web-unpack-final2-node22.log/.exit`이며 19 pass·skip0·exit0이다.

문서 정합성 검사는172개 기능·60개 인수 정의·9개 suite 인수 정의와139개 명세 링크를 확인한다. 기능 인수 시험을60/9개 실행한 결과가 아니다.
