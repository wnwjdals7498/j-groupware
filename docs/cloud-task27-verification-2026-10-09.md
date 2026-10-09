# Task27 고객 업무 화면·운영 준비 소스 검증

클라우드 `/workspace`의 기존 작업 브랜치 `codex/cloud-auth-foundation-20261008`에서 수행했다. Task27 시작 HEAD는 `5d3b98aa818aacb6aa740a2e4f8b015ad982f2c0`이고, 이번 소스 커밋은 `1d8e1a53092a004edd2353feb9f61a17696db2fe`다. 기존 브랜치 푸시 승인에 따라 소스 커밋을 푸시했고 git 원격 ref와 GitHub commit API에서 같은 SHA를 확인했다. 다른 7개 저장소의 소스 HEAD는 변경하지 않았다. 회사 노트북 설치·실제 VM·운영 계정/영구 credential·CA trust·systemd timer·방화벽 활성화는 수행하지 않았다.

## 첫 분류와 완료 범위

시작 상태는 전체172 중 implemented130/partial34/not_started8이었다. partial34를 고객 UI·Auth16, 명세/소스 연결11, 설치·운영 설정7로 분류했다. 실제 VM8은 별도로 남겼다. ID별 기존 명세/소스와 새 연결 근거는 [source review](cloud-task27-source-review.json)에 기록했다.

- UI/Auth16: AU-02, AU-05, GW-12, GW-13, GW-14, GW-20, GW-21, GW-30, GW-31, GW-32, GW-33, GW-34, GW-35, GW-36, GW-37, GW-44.
- 명세·연결11: TK-02, TK-03, TK-13, TK-14, TK-22, TK-23, TK-24, TK-27, TK-41, WB-13, WB-31.
- 설치·운영 설정7: GW-40, GW-63, GW-64, GW-65, GW-66, ML-03, ML-30.
- 실제 VM8 미실행: AU-51, GW-73, MS-09, ML-32, CA-32, AP-32, TK-42, WB-33.

React 고객 앱의 회원/권한·부분 실패 복구·조직·게시판·결재·메일·손님/API 키·상담/설정·웹 관리·알림·공개 메신저 컴포넌트를 실제 cookie BFF에 연결했다. 로그인 Code/PKCE, 권한별 메뉴/서버 접근 거절, 역할 회수 후 세션 종료, 비밀값 일회 표시/닫기/명시적 복사, WSS/SSE, sandbox 메일/preview, responsive 화면을 실제 서비스·Chromium과 검증했다. 서버는 검증된 정적 파일 inventory만 읽고 production 시작 시 앱 자산을 요구한다. 새 앱 자산은 native 실행 묶음에도 포함한다.

기존 Talk/Web producer와 contracts는 이전 구현 근거를 유지하면서 새 고객 consumer와 기능 명세를 대조했고 이번 actual Talk25/Web15 통합 시험을 각각 재실행했다. 과거 realm/registry 실행 증거는 [Task25](cloud-source-fourteen-verification-2026-10-09.md) 및 [Task26](cloud-task26-web-image-verification-2026-10-09.md)의 inherited evidence로 구별한다. 이번 변경을 문서 갱신만으로 구현 승격한 것은 아니다.

알림 owner/executor/customer-local private profile을 명시적으로 검증해 control/service/timer를 비활성 상태로 render하는 CLI와 Mailpit host-network용 SMTP egress 정책의 native install/start/ready 연결을 구현했다. 소유권 receipt 없이 기존 nft 표를 인수하지 않고 다른 표를 flush하지 않으며 메일 해지 뒤에도 차단 정책을 유지한다. 실제 운영 입력과 OS 적용 절차는 [운영 준비](cloud-task27-operating-preparation-2026-10-09.md)에 기록했다.

소스 기준 추적표는 **implemented164/partial0/not_started8**이다. `whole_suite_verified=false`, `acceptance_complete=false`를 유지한다. 이 숫자는 고객 운영 인수 통과 수가 아니다.

## 실제 실행 결과

아래는 Node **22.18.0과 24.19.0 각각**의 최종 exit0·skip0 실행이다. 상세 명령, 로그 경로·SHA256·exit 파일은 [test results](cloud-task27-test-results.json)에 기록했다. 겹치는 suite/부분 시험은 서로 다른 기능 수로 합산하지 않는다.

| 검사 | 각 runtime 결과 | 범위 |
|---|---:|---|
| check | unit83 + 공유 UI unit3 통과 | build·TS·lint·format 포함 |
| 전체 BFF | 209/209, 16 files | 실제 Keycloak/HTTPS/PG/Chromium/WSS/SSE |
| agent | 38/38 | notification plan6·mail egress source5 포함 |
| native guard | 3/3 | 활성화 guard·unit 텍스트, 실제 OS 적용 아님 |
| product lifecycle | 5/5 | 실제 compiled Talk/Web·PG·HTTPS probe |
| retained storage | 7/7 | 실제 PG/Mailpit·snapshot/restore·owned container 계정 |
| fresh unpack | 20/20 | 실제7개 archive·ready runtime·UI 자산 hash·drift 거절 |
| 공유 UI browser | 1/1 | 실제 Chromium |
| Talk integration | 25/25, 4 files | 실제 PG/HTTPS/WSS/widget Chromium |
| Web integration | 15/15, 2 files | 실제 PG/hosting·Task26 exact-source image |

customer-ui의6개 실제 browser 사례는 전체209에 포함된다. 조직 실패 PG trigger를 시험에서 만들고 제거하여 실제 계정 생성 성공/조직 등록 실패를 확인한 후 UI 복구·삭제까지 검증했다. 승인 문서와 답장, 메신저 두 browser 수신, 알림 header SSE count, 웹 저장/preview/deploy 및 손님/API 키 생성·수정·회수를 실제 상태와 대조했다.

## 실패 보존과 검증 한계

초기 UI socket factory·웹 reload race·browser wait·시험 selector/type/lint 오류를 교정하고 최종 전체 검사로 재검증했다. 첫 Node22 storage 실패는 보존 node_modules symlink의 container bind 해석 오류였으며 실제 dependency realpath를 readonly mount하여 Node22/24 모두 성공했다. 기존 dependency를 재설치·삭제하지 않았다.

첫 Node24 전체 BFF 실행은 compiled Approval fixture startup 실패로198 pass/11 skip/1 suite fail이었다. 원인은 아직 확정하지 않았다. 비밀값을 출력하지 않는 phase/code 진단을 추가한 뒤 별도 Approval11과 최종 전체209가 통과했다. 첫 실패·11 skip은 성공 수에 포함하지 않고 실패 로그/exit를 보존했다. raw private 로그는 커밋하지 않는다.

- 실제 Hyper-V/customer VM 인수8: VM 위치·명시적 실행 승인 미공급.
- 실제 systemd PID1 native bootstrap/install/unsubscribe/reboot/timer 활성화.
- 실제 nft --check/적용·외부 IPv4/IPv6 SMTP 차단·loopback capture·기존 방화벽 공존.
- 실제 고객 OS 패키지·20GB 디스크·CA 신뢰·외부 브라우저/네트워크 인수.
- 실제 운영 owner/execution account·credential 발급/refresh/회전·private file 접근 및 projection 활성화.
- 전체 서비스/장시간/고객 운영 인수; cloud Chromium ignoreHTTPSErrors는 fixture 전용이며 OS CA 신뢰 증거가 아님.

Chromium의 `ignoreHTTPSErrors`는 폐기 가능한 격리 fixture에만 사용했다. 서버 간 서비스 probe/계약 시험의 TLS 검증과 실제 OS CA trust 인수는 별도다. 실제 VM8과 운영 활성화 단계는 위치·실행 승인 및 실제 계정/credential 입력이 공급될 때까지 미실행으로 유지한다.

소스 파일은 `apps/web`, `apps/server/src/web-assets.ts`, 정적 경로/권한·로그아웃 연결, `deploy/agent/notification-plan.mjs`, `deploy/agent/mail-egress.mjs`, native/bundle 연결 및 실제 browser/agent 시험에 있다. [implementation progress](implementation-progress.json)와 [remaining audit](cloud-remaining-feature-audit-2026-10-08.json)에 소스 완료와 인수 미실행 경계를 반영했다.
