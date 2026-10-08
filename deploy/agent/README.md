# GW-66 독립 조정 엔진

설치기의 OS/DB 단계와 콘솔 HTTP 계약을 추측하지 않고, 결정 8의 상태 비교·직렬 실행·멱등·잠금·보고 수명을 먼저 구현했다. **부분 구현이다.** 운영 콘솔/agent 키/실제 설치기/probe가 연결되지 않았고 이 코드를 활성화하는 entrypoint와 systemd service는 아직 제공하지 않는다. `jgw-provision-agent.timer.example`은 1분 비활성 템플릿이다. 호스트에 복사하거나 enable하지 않았다.

## 내부 어댑터

`AgentReconciler`는 고정 tenant, `lock.acquire()`, 읽기 전용 `desired(signal)`·`inventory(signal)`, `provision(action, signal)`, `report(result, signal)`를 받는다. 내부 desired는 `{tenant, services}`, inventory는 `{tenant, installed}`다. **이 형태는 `/console/api/agent/desired-state` 또는 `/console/api/agent/status`의 공개 wire 계약이 아니다.** 서비스는 j-auth 카탈로그의 선택 서비스만, 다른 tenant·기본 서비스·알 수 없는 값·중복은 거부한다.

현재 사실에서 부족한 설치와 불필요한 해지를 계산하며 카탈로그 순서로 설치→해지를 한 번에 하나씩 수행한다. 업그레이드·purge·운영 등록·자격 발급은 제공하지 않는다. 설치기 성공 이후에도 실제 inventory를 다시 읽고 기대 변화가 있는지 확인한다. exit0만으로 동기화 성공을 보고하지 않는다. 한 단계 실패하면 다음 변경을 멈추고 다음 실행에서 처음부터 사실을 다시 조회한다. 성공했지만 보고가 실패한 경우 `reported:false`를 별도로 반환하여 다음 실행에서 설치를 반복하지 않고 다시 보고할 수 있다. 자동 실행 entrypoint는 `outcome:synchronized`와 `reported:true`를 모두 확인해야 한다.

inventory는 **전 단계가 반영된 완전 설치**만 `installed`에 포함해야 한다. 이 probe 본체와 불완전 설치 복구는 G18에서 구현할 사항이다. 변경 후 관찰 실패는 현재 설치 사실을 미확정으로 남기며 이전 배열로 덮어쓰지 않는다. 결과·오류는 서비스 이름과 안전한 코드만 포함한다. 외부 오류 message·stderr·비밀값을 넣지 않는다. reporter에 복사본을 보내 결과를 변조하지 못하게 한다.

읽기 전용 source는 기본5초 bounded cancellation을 적용하고 늦은 reject를 소비한다. 변경 어댑터는 **실제 정지·종료가 확인될 때까지 기다리며 Promise.race로 unlock하지 않는다.** 보고도 settle할 때까지 잠금을 잡아 오래된 보고가 다음 실행을 앞지를 수 없게 한다. 커스텀 변경/reporter는 AbortSignal을 존중하고 반드시 settle해야 한다. 정해지지 않은 콘솔 status 세대 정책을 대신 만들지 않았다.

## 실제 명령 실행 포트

`provisionCommand(binary, {timeout, grace})`는 체크아웃 밖의 절대 경로에 있는 신뢰한 일반 executable만 받는다. symlink, 다른 소유자(현재 uid/root 외), group/world writable 파일을 거부한다. Linux 전용이며 shell 없이 다음 argv만 만든다.

- 설치: `<binary> <service>`
- 해지: `<binary> <service> --remove`

stdin·stdout·stderr를 무시하고 PATH/LANG만 넘긴다. 기본180초(설정50ms~600초), 취소/timeout 시 프로세스 그룹 TERM→grace→KILL을 수행한다. parent가 먼저 끝나도 TERM을 무시하는 descendant를 정지할 때까지 기다린다. 정상 종료에도 명령이 남긴 같은 그룹 child를 정리한다. systemd가 관리하는 서비스는 다른 그룹에서 수명을 가져야 한다. 본 시험에서는 실제 설치 binary 대신 전용 임시 파일만 바꾸는 fixture executable을 사용했다.

`DirectoryLock`은 소유한 외부 디렉터리의 atomic mkdir·owner token으로 다른 프로세스와 직렬화한다. active/stale lock 모두 훔치지 않고 busy로 반환한다. 임의 TTL로 지우지 않는다. 장애 뒤 lock 복구는 실행 프로세스/자식이 없음을 확인한 운영 절차가 필요하다. 잠금은 변경과 최종 보고가 모두 끝난 뒤 자신의 token을 확인하고 해제한다.

## 재현과 남은 연결

```sh
JGW_AGENT_TEST_RUNTIME=isolated-cloud npm run test:agent
```

Node22/24에서 각각14개를 실제 임시 파일·설치 fixture 프로세스·서로 다른 agent 프로세스로 확인했다. marker가 없으면 실패하며 skip하지 않는다. Docker/DB/systemd·실제 서버 등록·키 발급·메일/SMS/외부 송신은 이 시험에서 하지 않는다. [전체 증거와 남은 계약](../../docs/cloud-agent-verification-2026-10-08.md)을 따른다.
