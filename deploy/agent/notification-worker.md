# 명시적인 알림 투영 1회 실행

`notification-worker.mjs`는 별도 control-plane 소유자가 제공한 짧은 수명의
operator access token과 console service key를 읽어 실제 j-auth 구독을 조회한다.
NotificationProjector와 private hash manifest를 연결하며 BFF에 자격을 전달하지
않는다. import/생성만으로 작업을 시작하지 않고, 비밀번호 저장·token 발급/갱신·
영구 자격 생성·운영 timer 등록도 수행하지 않는다.

외부 파일은 실행 사용자 또는 root 소유 regular file이어야 하며 mode-600
비밀 파일과 안전한 ancestry를 요구한다. symlink, 쓰기 가능한 경로, 과도한
파일 크기, 추가 필드와 중복/비정규 JSON을 거부한다. JSON은 `JSON.stringify`
한 줄과 마지막 개행으로 작성한다. 읽기 실패는 없는 부모 디렉터리를 만들지
않는다. 토큰은 매번 읽고 만료 5초 전 또는 15분 초과의 exp를 거부한다.
로컬 exp 검사는 signature 검증의 대체가 아니다. 실제 issuer/audience/서명,
operator 역할과 console key는 j-auth가 검사한다.

비밀을 placeholder에 넣지 않은 구성 예시:

```json
{"tenant":"example","authOrigin":"https://jauth.jgw.test","caFile":"/etc/jgw/notification/auth-ca.crt","credentialsFile":"/etc/jgw/notification/credentials.json","databaseFile":"/etc/jgw/notification/database.json","manifestRoot":"/var/lib/jgw/provision/notification"}
```

credentials 파일의 정확한 필드는 `bearer`, `serviceKey`다. database 파일은
`tenant`, `port`, `password`다. tenant는 config와 같아야 하고 PG 접속은
127.0.0.1의 고정 jgw_groupware DB/role로 제한한다. 자격/DB 원문은 출력과
manifest에 기록하지 않는다. CA는 외부 파일에서 읽고 현재 유효한 X509 CA와
실제 HTTPS TLS 검증을 사용한다.

```sh
node /opt/jgw/bundles/j-groupware/deploy/agent/notification-worker.mjs \
  --config /etc/jgw/notification/control.json --once
```

CLI는 자기 DB의 immutable migration을 적용한 뒤 한 번만 갱신하고 종료한다.
성공 출력은 tenant/revision뿐이다. 전체 실행/요청/SQL에 제한 시간을 두고,
실패하면 안전한 오류 코드와 실패 종료 코드를 반환한다. 자격 만료/조회 실패는
기존 투영을 즉시 inactive로 확정하고 기존 manifest 세대를 보존한다. 파일
교체 후 재실행하면 같은 세대로 복구한다. 가입하지 않은 source는 활성화하지 않는다.

`jgw-notification-refresh.service.example`과 `.timer.example`은 60초 lease 전에
20초 간격으로 1회 CLI를 호출하는 비활성 source 예시다. 실제 systemd 실행,
영구 자격/갱신 주체 배치, control-plane과 고객 PG의 실제 토폴로지, 전용
서비스 계정의 CA/TLS credential 전달, 고객 VM 인수는 별도 작업이다. 이
클라우드에서는 operating unit/timer를 생성하거나 등록하지 않았다.

격리 검사 6개는 실제 인증 구독·PG·private HTTP 수신, 만료 시 비활성화와
파일 교체 복구, 비밀 argv/env 없는 실제 CLI, private 파일 거부와 read-only
systemd 문법 검사를 포함한다. 시험 DNS preload는 tests에만 있고 runtime
번들에 포함하지 않는다. 실제 외부 메일/사용자 알림 전송 인수는 미실행이다.
