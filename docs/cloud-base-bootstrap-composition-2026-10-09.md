# 21차 기본 bootstrap 연결

봉인된 입력과 준비된 OS 기반에서 기본 BFF 설치를 연결했다.
[BaseBootstrap](../deploy/agent/base-bootstrap.mjs)는 전체 번들 검증·해제 →
전용 PG 기반 → 같은 private BFF 자격 → DB → native unit/start/readiness →
gateway를 연결한다. 기본 BFF와 CA/Messenger 설치자가 같은 native control,
state/lock/PG/gateway를 사용한다. 번들 계획 hash 변경·잘못된 전제·취소는
변경 전에 거절하고, 중간 실패와 gateway 실패는 원래 자격을 보존해 재시도한다.

[고정 CLI](../deploy/agent/bootstrap-runtime.mjs)는 argv 없이
`/etc/jgw/bootstrap/control.json`을 읽는다. root private canonical JSON은
`installerControlFile`, `baseProfileFile`, `bundleInstallFile`만 받는다.
installer control은 [기존 native 계약](../deploy/agent/native-installer.md)이다.
base profile은 `port,publicOrigin,authApiOrigin,certificate,key`이고,
bundle install은 `npmConfig,cache,npmCli`다. 신뢰 입력을 쓰기 root/cache에 두지
않고 root 소유 준비된 번들/unit 경로와 고정 PG18/Nginx/systemctl을 확인한다.
gateway의 실제 HTTPS origin/BFF port와 기본 profile 불일치를 거절한다.
runtime 생성/import는 inert다. 성공 결과는 `base_ready,agentActivation:pending`이다.

Node22.18/24.19 각각 coordinator4, 최종 agent25, root storage/native5,
fresh unpack19, Web 연결을 포함한 최종 check80이 exit0이다. root 검사는 실제 private control loader와
factory/CLI 거절 경계이며 실제 systemd 설치 성공을 뜻하지 않는다.
coordinator4는 durable 파일·잠금·자격·재시작 순서의 adapter contract 검사다.
cold19는 새 모듈을 실제 새 npm 의존성 설치에서 import하고 위험 archive 회귀를 확인한다.
원래 BFF cold 로그인/PG 시나리오를 이 coordinator로 실행한 것은 아니며
전체 BFF 최종 회귀184와 하위 Node PATH까지 고정한 로그는
[21차 최종 기록](cloud-web-bff-verification-2026-10-09.md)에 정리했다.
초기 check77의 parent Node만 지정한 실행은 두 버전의 최종 증거로 사용하지 않는다.

최초 root 실행의 시험 URL 기본443 오류, 두 번째 실행의 readonly bootstrap
TLS source까지 쓰기 root로 잘못 분류한 오류를 수정했다. readonly 봉인 root를
실제 출력 경로와 구분했으며 출력 root/cache 중첩 거절은 유지한다.
초기 check의 formatting 실패도 보존했다. 최종 성공 로그로 이전 실패를 덮지 않는다.

OS 패키지 설치·PG 서버 설치·OS CA trust·agent config/timer 등록은 이 코드가
수행하지 않는다. 준비된 kit/입력·OS 전제에서 기본 BFF를 연결하는 소스 단계다.
실제 systemd PID1 기본/CA/Messenger 전체 설치와 운영 알림 owner/topology,
나머지 제품 OS binding은 미완료다. GW-63/64/66을 전체 완료로 바꾸지 않았다.
로그는 `/workspace/.suite-runtime/j-groupware/base-*.log`와 대응 `.exit`다.
최종 root는 `base-root-final2`, 최종 check는 `web-bff-check-final`이다.

최종 검토에서 전제 검사 전에 state/lock 디렉터리가 생성될 수 있는 순서를
수정했다. preflight·초기 취소는 잠금/state 접근 전에 검사하며 실제 두 경로가
ENOENT로 유지되는 것을 두 Node의 coordinator4로 확인했다.
로그는 `base-preflight-final-node{22,24}`다. OS 설치 성공 주장은 추가하지 않는다.
