# 고정 네이티브 설치 진입점과 저장소 보존

2026-10-09. 소스 조합과 격리 검증 범위이며 실제 고객 OS 설치·전체 인수 시험 미완료다.

`deploy/provision-service`는 `/usr/bin/node`와 설치된 기본 번들의 고정
`provision-service.mjs`를 사용한다. 허용 argv는 서비스 이름 한 개 또는
서비스 이름과 `--remove`뿐이다. control 경로는 `/etc/jgw/provision/control.json`이다.
환경 변수·argv로 자격이나 설치 코드를 교체하지 않는다. import와 runtime 생성은
파일 생성·DB 연결·계정/서비스/타이머 등록을 하지 않는다.

현재 concrete runtime은 `j-customer-auth-db`와 `j-messenger`를 연결한다.
Approval/Talk/Mail은 `notification_operating_owner_unbound`, Web은
`web_native_installation_unbound`로 state/DB/OS 변경 전에 거절한다.
이 거절을 설치 성공이나 해당 서비스 구현 완료로 취급하지 않는다.

## 입력과 선행 조건

control은 root 소유 mode-600 canonical JSON 한 줄과 마지막 개행이어야 한다.
symlink·쓰기 가능한 ancestry·추가 필드·중복/비정규 JSON을 거부한다.
정확한 필드는 `bootstrapRoot`, `productProfileFile`, `postgresFile`,
`gatewayProfileFile`, `roots`, `storageProfiles`다.

- bootstrap은 기존 봉인 자격과 현재 유효한 공개 CA다. 재발급하지 않는다.
- product profile은 기존 ProductEnvironment의 `databasePort`, `profiles`,
  선택 `notificationOrigin` 형식이다.
- postgres 파일은 정확히 `host`, `port`, `database`, `user`, `password`,
  `passFile`을 가진다. 127.0.0.1, profile과 같은 port, postgres DB/관리자,
  기존 43자 base64url 비밀번호와 private pgpass 파일만 받는다.
  pgpass 내용은 `127.0.0.1:<port>:*:postgres:<password>` 한 줄이다.
- roots는 `bundleRoot`, `environmentRoot`, `unitRoot`, `stateRoot`, `lockRoot`,
  `databaseBackupRoot`, `storageStateRoot`, `storageBackupRoot`, `gatewayRoot`다.
  서로 겹치지 않고 입력 파일을 쓰기 대상 안에 두지 않는다.
- gateway profile은 기존 gateway 계약이다. DB·gateway·제품 port 충돌과
  customer-auth upstream port/HTTPS/CA 불일치를 설치 전에 거절한다.
- storageProfiles는 현재 Messenger의 `{root,maxBytes,maxEntries}`를 받는다.
  root는 product profile의 dataRoot와 같아야 한다. 백업 상한은 운영자가
  명시하고 자동 보관 주기·자동 purge 정책을 만들지 않는다.

데이터 allocation 부모는 미리 준비된 root 소유 traversal 경로여야 하며
private state/backup 경로와 분리한다. 이미 검증·해제된 root 소유 제품 번들, 준비된 전용 PostgreSQL 기반과
`/usr/lib/postgresql/18/bin/pg_dump`, Nginx, systemd가 선행 조건이다.
이 진입점은 OS 패키지 설치·PG 설치·OS CA trust·기본 BFF bootstrap을
완료하는 전체 설치기가 아니다. 현재 CLI 검증은 inert 조합과 거절 경계다.
실제 systemd PID1에서 CA/Messenger 설치·해지 전체 흐름은 미실행이다.

## 저장소 준비·해지

ProductStorage는 root 소유 allocation 루트와 고정 서비스 계정의 mode-700
하위 디렉터리를 준비한다. Messenger는 files/tmp/web-dist/backups, Mail은
data다. 상위 루트의 0711은 전용 계정이 자신의 하위 디렉터리에 접근하게
하며 임의 형제 디렉터리나 root 제어 파일을 쓰게 하지 않는다.
기존 미표시 경로·UID/GID 변경·symlink·다른 소유자를 인수하지 않는다.

S14 순서는 서비스 중지 → PG dump → DB NOLOGIN/세션 종료 → 제품 정리다.
Mailpit 중지와 볼륨 백업은 제품 정리 단계에 있다. 준비/소유권 preflight는
DB 할당 또는 서비스 정지 전이며, 계정 생성 뒤 저장소 준비가 서비스 기동보다 앞선다.

백업은 실제 중지 확인 전·후에 소유 파일을 읽고 해시와 topology를 검증한다.
Mailpit이 다시 실행되면 본 서비스 stopped callback과 별개로 거절한다.
Messenger files 전체와 Mailpit data 전체, 이미 커밋된 PG custom archive를
private snapshot에 묶는다. hardlink/symlink·변경된 파일·예산 초과·변조·
추가 파일을 거절하고 실패 시 기존 데이터와 커밋된 백업을 보존한다.
검증 후 allocation 루트를 0700으로 보존하고 snapshot 경로를 durable state에 기록한다.
재시도는 같은 백업을 검증하며 재설치·삭제/purge는 자동 수행하지 않는다.
Messenger tmp/web-dist/backups는 원본 allocation 안에 보존하고 제거 snapshot에 복사하지 않는다.

Messenger private 테이블을 직접 조회하지 않는다. 이 백업의 PG/file bytes
복원 검증은 Messenger 공개 모듈의 file-reference/session purge 의미적 복원
인수와 구별한다. 전용 OS 계정 삭제·별도 재해 복구 보관·고객 VM 인수도 미실행이다.

## Mailpit owner

MailpitPlatform은 `@j-mail/contracts@0.1.1`의 고정 이미지 digest와 기존 capture
환경을 사용한다. 자동 pull·relay/forward/webhook·자격 발급을 하지 않는다.
테넌트 이름, image/config/user/labels, 한 개의 owned data bind, read-only root,
cap drop과 no-new-privileges를 확인한 뒤 자기 컨테이너만 시작/정지한다.
daemon 실패를 없는 컨테이너로 취급하지 않고 다른 이름/설정/볼륨은 거절한다.
HTTP/SMTP는 명시적 loopback 포트이며 3001은 금지다. 준비 확인은 공식
[Mailpit healthcheck](https://mailpit.axllent.org/docs/integration/healthcheck/)의
`/readyz`를 사용한다. 이 owner는 독립 격리 검증됐으며 운영 Mail installer
조합은 알림 owner 계약이 없어 연결하지 않았다. 고객 VM의 SMTP egress 방화벽은 미실행이다.

기본 번들은 세 모듈과 고정 wrapper를 포함한다. 안전 해제는 검증된 기본
번들의 wrapper에만 0755를 복원하고, 재시도 때 실행 권한 변조를 거절한다.
다른 archive script에 실행 권한을 추가하지 않는다.

## 운영 알림 계약과 완료 경계

기존 worker는 `GET /auth/tenants/<tenant>/services`를 실제 operator Bearer와
console service key로 조회하고 로컬 127.0.0.1의 jgw_groupware DB에 투영한다.
입력 토큰은 최대 15분·만료 5초 전 거절이며 서명/issuer/audience/역할/key는
j-auth가 검사한다. private 파일 교체·만료 비활성화·동일 manifest 복구는 검증됐다.

운영 연결 전에는 다음 계약이 필요하다.

1. refresh 자격을 소유하고 access token을 공급할 실제 operator/클라이언트와
   발급·갱신·회수 권한, console key 회전 책임, 비밀 보관/교체 경로.
2. control-plane 자격 소유자와 고객의 로컬 PG/private receiver 사이의 실제
   배치·통신 경계. 현재 로컬 PG worker를 control plane에 놓는 것으로 가정하지 않는다.
3. 고객 측 manifest와 운영 projection의 전달/실패/lease 책임 및 활성화 승인.

일반 회원 세션이나 임의의 영구 service account/token으로 대신하지 않는다.
새 grant·긴 TTL·비밀번호 보관·운영 갱신/timer를 임의 도입하지 않는다.
전체 기본 bootstrap과 나머지 서비스 조합의 독립 소스 작업, T2/E8/H7·UI
정책 대기와 실제 OS/고객 VM 인수는 각각 다른 미완료 단계다.

격리 재현: `JGW_AGENT_TEST_RUNTIME=isolated-cloud npm run test:agent:storage`.
root/account/파일 권한 시험은 owned 임시 컨테이너에서만 실행한다.
[20차 실행 기록](../../docs/cloud-native-storage-verification-2026-10-09.md)과
[남은 기능 감사](../../docs/cloud-remaining-feature-audit-2026-10-08.md)를 함께 본다.
