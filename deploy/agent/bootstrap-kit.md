# OS bootstrap kit와 명시적 native 준비

2026-10-09. 고객 서버용 소스와 owned cloud fixture 검증이다. 실제 OS 패키지
설치·CA trust·systemd PID1 전체 기동·timer 활성화·고객 VM 인수는 미실행이다.
현재 OS adapter의 지원 대상은 Debian 12이다. OS 종류를 제품 정책으로 새로
확정한 것이 아니며 다른 배포판은 준비 전에 거절한다.

## Kit 생성과 입력

`buildBootstrapKit()`는 새 출력 디렉터리에 검증·해제 완료된 기본 runtime,
실제 제품 archive 7개, digest로 고정한 Node 실행 파일과 npm, 정확한 버전의
offline Debian package 파일을 묶는다. archive·runtime source inventory와
package-lock hash, `.deb`의 Package/Version/Architecture 및 SHA256을 검사한다.
중복 package, 빠진 기반 package, symlink escape/cycle, 기존 출력 덮어쓰기,
크기/파일 수 상한 초과를 거절한다. 기본 runtime 내부 dependency link만 해제한다.

`archives`는 각 `{service,archive,digest}`, `osPackages`는 각
`{name,version,architecture,sha256,file}`이다. 필수 package 이름은
`OS_REQUIRED_PACKAGES`를 따른다. 운영자가 신뢰한 정확한 버전의 package와
그 dependency closure를 함께 제공해야 한다. 자동 apt repository 변경이나
network pull로 빠진 package를 채우지 않는다. test의 0.0.1 metadata `.deb`는
형식 검증용이며 실제 기반 package로 설치한 증거가 아니다.

manifest와 `SHA256SUMS`는 모든 파일의 경로·hash·크기·권한을 고정한다.
읽기 전용 파일은 0444, 실행 파일은 0555다. `verifyBootstrapKit()`는 변조,
누락·추가 파일·symlink를 거절한다. `.npmrc`는 읽거나 복사하지 않으며
`.env`, `.aws`, `.git`, private TLS key 파일을 kit에 포함하지 않는다.
kit에 들어가지 않는 기존 봉인 자격·private control·CA/key는 별도 준비한다.

root 실행 launcher는 kit와 ancestry의 root 소유권·쓰기 권한·symlink 및
전체 checksum을 검사한 뒤 kit의 고정 Node로 `full-bootstrap.mjs`를 실행한다.
cloud 검증에서 호스트 kit를 chown하거나 호스트 launcher를 실행하지 않았다.

## 전체 bootstrap 제어

고정 입력 `/etc/jgw/bootstrap/full-control.json`은 root 소유 0600 canonical
JSON이다. 정확한 필드는 `bootstrapControlFile`, `kitManifestSha256`,
`osProfileFile`이다. 기존 기본 bootstrap control과 installer control 형식은
[native installer](native-installer.md), [기본 bootstrap](../../docs/cloud-base-bootstrap-composition-2026-10-09.md)을 따른다.

OS profile의 필드는 `packages`, `node`, `caFile`, `postgres`다. `node`는
`file,sha256,version`, `postgres`는 `image,dataRoot,port,passwordFile`이다.
Node는 22.18 이상인 22.x 또는 24.x를 명시한다. PostgreSQL은
`postgres:18.6-bookworm@sha256:<digest>`와 기존 43자 비밀번호 파일을 명시한다.
Node·package 파일은 kit inventory와, PG port/password·공개 CA fingerprint는
기존 봉인 bootstrap 입력과 일치해야 한다. 자격 발급·refresh를 수행하지 않는다.

기본 실행은 검증만 한다. `--prepare`는 OS receipt, PG Compose, 비활성 unit과
agent control/receipt를 준비한다. package 설치·서비스 시작·timer enable은 하지 않는다.
별도 승인된 고객 VM에서 사용하는 `--activate` 소스 경로는 다음 순서다.

1. 기존 입력과 kit 재검증, systemd PID1 및 고정 설치 경로 확인, 전체 bootstrap lock.
2. offline package 정확한 버전 설치, 고정 Node와 기존 공개 CA trust 적용.
3. 고정 PG Compose·소유 data inode/receipt 확인, PG 기동/준비 확인.
4. 기존 safe archive/npm-ci 설치와 기본 DB·BFF·gateway bootstrap.
5. agent control/unit 준비와 명시적 timer 활성화.

이 activation 순서는 소스이며 실제 PID1 첫 설치를 실행한 결과가 아니다.
foreign `policy-rc.d`를 덮어쓰지 않는다. 자신의 임시 policy만 package 자동
daemon 기동을 막고 제거한다. 기존 enabled distribution Nginx는 인수하지 않는다.
기존 conffile은 유지하며 같은 파일이라도 권한·소유권이 다르면 거절한다.

## PG·gateway·agent

S13에 따라 고객 PG는 OS PostgreSQL server가 아닌 pinned Docker Compose다.
127.0.0.1의 명시적 port와 password secret file, 별도 data bind를 사용한다.
자동 pull·volume 삭제·`compose down`을 하지 않는다. PG18 data 하위는 제품
이미지가 관리하며 root allocation과 private inode receipt로 다른 data 인수를 막는다.
Keycloak은 기존 j-auth control-plane Compose 소유이며 고객 kit에서 추가로 띄우지 않는다.

`jgw-gateway.service`는 렌더러의 `/etc/nginx/nginx.pid`와 같은 PIDFile과 고정
config를 사용한다. 초기 start와 후속 reload를 구분하고 다른 FragmentPath를
거절한다. 배포판 Nginx와 같은 포트를 놓고 경합하는 구성을 활성화하지 않는다.

agent는 기존 bootstrap/product profile을 읽고 private control과 one-shot
service/1분 timer를 준비한다. installer와 agent의 lock을 분리해 nested lock을
피한다. import·factory 생성·prepare는 기동하지 않는다. 운영 알림 refresh
owner나 key rotation/topology를 지정하지 않으며 해당 계약은 여전히 미확정이다.

## 연결된 제품과 보존

선택 `nativeBindingsFile`은 정확한 `web`, `mailpit`,
`notificationControlFile` 필드만 받는다. Web은 기존 CA/FTPS cert/key와 SSH
host key, SFTP/FTPS/passive port, backup 상한을 명시한다. Mail은 명시적
loopback SMTP/HTTP port와 기존 prepared notification binding을 필요로 한다.
Approval/Talk도 기존 binding을 사용한다. 운영 owner가 없으면 변경 전에 거절한다.

Web은 hash 검증된 privileged helper·sudoers·sshd/vsftpd·compiled disk probe,
실제 별도 `/srv/jweb` filesystem, 기존 cert/key, 소유 group receipt와 고정
unit을 준비한다. helper 0555·sudoers 0440·private key/control 0600을 유지한다.
실제 visudo와 sshd config 검사를 실행한다. 활성화 경로는 자신의 `jgw_web`
nft table만 관리하고 전역 flush나 관리 SSH 변경을 하지 않는다. 실제 firewall
apply·PID1 SFTP/FTPS 기동은 미실행이다.

Mailpit은 native factory에서 pinned Compose로 생성하고 소유 container ID만
시작/중지한다. 이미지·전체 config·Compose hash/labels·단일 data bind가 맞지
않으면 거절한다. 기존 capture 계약을 유지하고 relay/forward/webhook을 추가하지 않는다.

Web 해지는 실제 helper의 remove-all 이후 readonly retained-state로 남은
backup ID를 읽는다. 중지 상태에서 topology/UID/GID/mode/hash와 PG archive를
두 번 대조해 private receipt에 남긴다. retry는 같은 보존 데이터를 재검증한다.
변조·예산 초과·symlink/hardlink를 거절하고 자동 purge를 수행하지 않는다.

## 실행 증거

[23차 검증 기록](../../docs/cloud-bootstrap-kit-verification-2026-10-09.md)에
실행한 Node 버전·시험 수·exit와 미실행 경계를 기록한다. 실제 OS installation,
CA trust, PID1 전체 native lifecycle, 운영 timer와 20GB 고객 VM/firewall 인수는
그 기록의 cloud fixture 성공으로 대체하지 않는다.

Docker Compose의 [준비 순서](https://docs.docker.com/compose/how-tos/startup-order/)와
Debian의 [CA trust 명령](https://manpages.debian.org/bookworm/ca-certificates/update-ca-certificates.8.en.html)을 따른다.
