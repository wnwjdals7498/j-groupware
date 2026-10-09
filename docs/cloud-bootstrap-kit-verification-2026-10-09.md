# 23차 OS kit·native 제품·agent 연결과 실제 검증

2026-10-09, 클라우드 `/workspace`와 `codex/cloud-auth-foundation-20261008` 작업이다.
체크아웃·Node·Docker·기존 테스트 PG/Keycloak/registry 접근을 확인했다.
연결 끊김 알림 이후에도 파일/명령 접근과 시험 exit를 다시 확인했다.
새 계정·package·서비스 변경은 이 작업이 만든 owned fixture 컨테이너 안에서만 했다.
운영 호스트/회사 노트북 설치·3001 사용·운영 timer/새 영구 자격·외부 발송·
PR/main 병합/배포는 실행하지 않았다. `whole_suite_verified=false`다.

## 구현한 연결

- GW-63: [kit builder/검증](../deploy/agent/bootstrap-kit.mjs)은 실제 archive 7개,
  ready 기본 runtime, digest 고정 Node/npm과 offline package를 묶는다.
  inventory/lock·SHA·권한·추가 파일·symlink/dependency escape·size 상한을 검사하고
  npm credential/private key를 포함하지 않는다. [OS adapter](../deploy/agent/os-bootstrap.mjs)는
  Debian12의 정확한 package metadata/arch/version/hash를 검사하고 inactive
  receipt/unit을 준비한다. 실제 PG는 S13의 pinned Docker Compose이며 OS PG
  server를 설치하지 않는다. [전체 entry](../deploy/agent/full-bootstrap.mjs)는
  기존 private 입력을 대조해 package→PG→기본 BFF/gateway→agent 순서를 연결했다.
- GW-64: [native 제품 조합](../deploy/agent/native-products.mjs)이
  [Web](../deploy/agent/native-web.mjs)의 기존 CA·FTPS/SSH key, 실제 별도 disk,
  hash 검증 helper/sudoers/config, 소유 group receipt와 inactive SFTP/FTPS unit을
  연결한다. 실제 visudo/sshd 검사를 수행한다. 활성화 소스는 자신의 nft table과
  unit FragmentPath만 관리한다. Mail은 pinned Mailpit Compose/data/port와 기존
  prepared notification control, Approval/Talk도 그 control을 명시적으로 받는다.
  새 operating owner/refresh 자격을 만들지 않고 없는 입력은 변경 전에 거절한다.
- GW-65: 실제 helper의 readonly `retained-state`를 통해 삭제 완료된 backup ID만
  조회한다. [Web 보존 검증](../deploy/agent/web-cleanup.mjs)은 중지 확인 전후에
  topology·UID/GID/mode·파일/PG archive hash를 반복 검사하고 immutable private
  receipt를 남긴다. retry/변조/예산/symlink/hardlink를 검사하고 자동 purge하지 않는다.
- GW-66: [agent 준비](../deploy/agent/agent-install.mjs)가 기존 입력의 private
  control과 one-shot service/1분 timer를 비활성으로 기록한다. agent/installer lock을
  분리했다. 실제 활성화는 고정 경로와 root/PID1 기반의 전체 bootstrap 단계에 있다.
- [소유 gateway](../deploy/agent/native-gateway.mjs)는 렌더러의 PID 경로와 unit을
  맞추고 최초 start/이후 reload를 구분한다. 기존 distribution Nginx 인수를 거절한다.
  [시험 runner](../scripts/run-isolated-tests.mjs)는 build부터 teardown까지 단일
  실행 lease, 전용 TMPDIR/compile-cache 비활성화, 용량 확인, 자기 child process
  group 정리와 실패 파일 보존을 적용한다. stale lease를 자동 탈취하지 않는다.

입력 형식과 prepare/activate 범위는 [kit 설명](../deploy/agent/bootstrap-kit.md),
[native installer](../deploy/agent/native-installer.md)를 따른다. public immutable
contracts 버전/내용은 바꾸거나 재게시하지 않았다.

## 실제 시험 결과

각 시험의 parent/child PATH를 Node22.18.0 또는24.19.0으로 고정하고 큰 시험은
순차 실행했다. 수는 버전별이며 focused 결과를 전체 통합에 중복 합산하지 않는다.

| 시험 | Node22 | Node24 | 종료/skip |
|---|---:|---:|---|
| Groupware build/type/unit/lint/format | 80 | 80 | 각각 exit0 |
| 전체 실제 BFF integration | 191 /15 files | 191 /15 files | 각각 exit0/skip0 |
| agent·durable state·lock/process·resource lease | 27 | 27 | 각각 exit0/skip0 |
| native 입력/renderer/activation 경계 | 3 | 3 | 각각 exit0/skip0 |
| owned root account/storage·OS/agent prepare·Mailpit Compose | 7 | 7 | 각각 exit0/skip0 |
| Web root 준비·실제 SFTP/FTPS·retained backup | 4 | 4 | 각각 exit0/skip0 |
| fresh real archive/npm-ci/해제·전체 kit/digest | 20 | 20 | 각각 exit0/skip0 |
| 실제 Nginx HTTPS/WSS·subscription·reload rollback | 15 | 15 | 각각 exit0/skip0 |
| JWeb build/type/unit/helper/lint/format | 6+1 | 6+1 | 각각 exit0/skip0 |

kit 시험은 실제 제품 archive 7개, 실제 Node/npm 및 fresh dependency 해제를
사용한다. offline OS 입력 18종의 `.deb`는 0.0.1 **metadata 검증 fixture**다.
이 package를 설치하지 않았고 신뢰한 실제 package dependency closure의 OS
설치 성공으로 계산하지 않는다. 준비 시험은 owned root 컨테이너에서
umask0077의 정확한 private 파일/unit 권한과 retry/drift를 검사했다.

Mailpit Compose 시험은 실제 cached pinned image를 pull 없이 만들고 동일
container ID의 재시도/중지/재기동·retained data·변조 거절을 검사했다.
Web fixture는 자신만의 실제64MB ext4 mount에서 helper/group/config를 준비하고
실제 SFTP/FTPS 계정 삭제/backup 보존을 검사했다. 20GB 고객 disk 인수가 아니다.
systemd PID1 또는 실제 nft apply를 실행하지 않았다. 이 root fixture는 host
network controller에서 firewall을 변경하지 않았다. nft package는 Web fixture
컨테이너에만 설치했다.

최종 로그/exit와 [기계 결과](/workspace/.suite-runtime/j-groupware/task23-final-tests.json)는
`/workspace/.suite-runtime/j-groupware/`에 보존한다. 파일명은
`native23-{check,bff,native,web,gateway,jweb-check}-final-node{22,24}`,
`native23-unpack-final2-node{22,24}`,
`native23-agent-final2-node22`, `native23-agent-final-node24`,
`native23-storage-sixth-node22`, `native23-storage-final-node24`다.

## 보존한 실패와 수정

최초 agent 실행에서 명시적 isolated-runtime env가 빠져 hook 단계가 실패했다.
통과/skip으로 계산하지 않았다. root fixture가 복사한 실행 파일/assets의
UID/mode 및 최소 dependency import가 잘못돼 실패한 로그도 보존했다. fixture
복사본만 root 소유/정확한 권한으로 준비하고 unit 관찰/private-file 모듈을
PG dependency와 분리했다. 새 Web group receipt가 무표시 기존 group 인수를
거절하므로 fixture 자신이 만든 빈 group만 지운 뒤 prepare했다.

Node24 kit 최초 최종 검사는 관리 runtime binary가 nobody 소유라 신뢰 입력
guard에서 실패했다. 호스트 binary는 변경하지 않고 fixture 소유 복사본의
바이트/SHA와 실제 실행 버전을 대조했다. Node22/24 kit 검사를 모두 다시 실행했다.

kit의 공백 경로·shipped npmrc 제외·Deb control 디렉터리 권한·umask 아래
launcher 실행 권한 오류를 고쳤다. 성공 파일 권한은 새 파일에만 정확하게
설정하고 기존 파일/foreign 경로는 인수하지 않는다. 실패 tmp/log는 보존했다.

Mailpit Compose 최초 실행은 config-hash 라벨 차이를 거절했다. Compose
[config 명령](https://github.com/docker/compose/blob/v2.40.3/cmd/compose/config.go)의
env-file 처리와 실제 create 경로를 대조해 비밀이 없는 기존 capture 설정을
explicit environment로 고정했다. image/config/전체 라벨 검증을 완화하지 않았다.
실패했던 자기 container는 정확한 tenant/project/단일 owned data bind/ID를
확인해 정리했다. foreign container/data·기존 장기 fixture는 보존했다.

23차 최종 큰 검사에서 ENOSPC나 연결 끊김 실패가 확인된 것은 아니다.
22차 ENOSPC/receiver 관련 과거 실패를 이번 성공으로 덮어쓰거나 원인 확정하지 않았다.

## 완료 경계와 다음 작업

기능 집계는 **구현114·부분36·미착수22 /총172**, 남은58을 유지한다.
GW-63/64/65/66은 독립 소스와 component 증거를 추가했지만 실제 OS/PID1 전체
인수가 없어 부분 구현이다. 남은 항목의 첫 다음 단계 분류는 독립 source0·
서비스 선행0·제품 정책28·UI17·실제 VM13이다. 분류 이동을 기능 완료로 계산하지 않는다.

실제 trusted offline package/dependency closure·OS CA trust·PG Compose PID1
첫 기동·전체 native 제품 설치/해지/retry·agent timer·firewall traffic·20GB
고객 VM 인수가 남았다. full-bootstrap activation 순서 자체도 실제 PID1에서
미실행이다. 운영 알림 refresh owner/key rotation/control-plane/local PG/receiver
topology, GW-51 업무 상태 계약, TK-21 배정 후보 권한/대상 자격/신뢰 전달,
T2/E8/H7과 기존 UI 기준 관문을 유지한다. 임의 상태·권한·자격·보관 정책을 만들지 않았다.

진행표172기능·code 경로 참조1195개·감사58분류와 변경 문서의 로컬 링크32개를
검증했다. 명세 검사172기능·서비스 인수 정의60·제품군 정의9·로컬 링크141개
성공은 문서 검증이다. 그 인수
60/9이나 전체 제품군 브라우저/고객 VM 시험을 실행한 뜻이 아니다.

## 커밋과 원격 보존

기존 승인에 따라 검증한 source commit을 작업 브랜치에 즉시 push했다.
`git ls-remote`와 GitHub commit 조회에서 full SHA와 URL을 확인했다.
마지막 진행표/감사/보고서 기록은 별도 문서 커밋이다.

- Groupware kit/native/agent/회귀: [894ddc1a2c81adbca9c9a6c1463506f5751f6ad0](https://github.com/wnwjdals7498/j-groupware/commit/894ddc1a2c81adbca9c9a6c1463506f5751f6ad0)
- JWeb readonly retained-state helper: [746c6b21c7b9534dd08de5e76d32e349b62e9531](https://github.com/wnwjdals7498/j-web/commit/746c6b21c7b9534dd08de5e76d32e349b62e9531)

다른6개 저장소의 source는22차와 같다. 모든 변경은 지정 workbranch이며
PR 게시/main 병합/배포는 실행하지 않았다.

Groupware source 변경25개 파일은 OS/kit/full entry·agent/private 설치 파일,
native Web/products/gateway/unit observation, Mailpit/제품 env/installer/보존,
gateway 실행, package scripts/resource runner 및 해당 root/kit/resource/native
시험이다. JWeb source 변경은 `deploy/jweb-helper.mjs` 한 파일이다.
문서 변경7개는 README, native-installer/kit 설명, 본 기록, 진행표와 감사 JSON/MD다.
