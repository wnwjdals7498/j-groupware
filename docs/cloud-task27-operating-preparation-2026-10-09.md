# Task27 운영 설정 준비

이 문서는 소스 연결과 아직 실행하지 않은 운영 절차를 구별한다. 클라우드 작업에서는 운영 계정·영구 자격증명·서비스 키 grant를 만들거나 systemd timer·CA 신뢰·방화벽을 활성화하지 않았다.

## 알림 credential refresh 담당과 topology

`deploy/agent/notification-plan.mjs`는 명시적인 입력을 검증하고 기존 notification worker용 control JSON과 service/timer 텍스트를 렌더링한다. 운영 담당자 `ownerId`, 실행 계정 `executionUser`/`executionGroup`, tenant, auth HTTPS origin, 외부 control/CA/credential/DB/manifest 경로를 모두 공급해야 한다. 값이 없으면 추측하지 않고 거절한다. 기존 customer-local PG와 private receiver에 맞는 `topology="customer-local"`만 지원하며 원격 control-plane DB topology로 자동 변경하지 않는다.

예시 필드의 `replace_with_*`는 실제 담당자·계정을 선택하기 위한 자리표시자다. 선택한 담당자는 refresh credential 및 서비스 키 교체 책임을 가진다. 이 설정은 계정이나 권한을 생성하지 않는다. 기존 native installer의 명시적인 `notificationControlFile` 연결을 그대로 사용한다.

입력은 저장소 밖의 신뢰할 수 있는 디렉터리에 둔 mode 0600의 canonical JSON(`JSON.stringify(profile) + "\n"`)이어야 한다. 읽기/경로 검증은 기존 control-file guard를 따른다. 실제 실행 계정이 입력 파일을 읽을 수 있고 manifest 디렉터리를 쓸 수 있도록 운영자가 소유권·접근을 준비해야 한다. worker의 private-file 규칙 때문에 group/world 권한을 넓혀 해결하지 않는다.

```sh
node deploy/agent/notification-plan.mjs --profile /etc/jgw-input/notification-plan.json --validate-only
node deploy/agent/notification-plan.mjs --profile /etc/jgw-input/notification-plan.json --print-plan
```

첫 명령은 검증 결과, 두 번째는 검토 가능한 control/service/timer 텍스트를 출력한다. 두 명령 모두 network·DB 변경·파일 출력·서비스 활성화를 수행하지 않는다. 출력의 `activation="pending"`, `acceptance_complete=false`, `not_run_list`를 완료로 바꾸지 않는다.

렌더링한 timer는 기존 60초 lease보다 짧은 20초 재실행을 사용한다. 실제 계정 접근, credential 발급·회전·refresh, auth→고객 PG projection, private receiver 연결, PID1 systemd 활성화와 장애 복구는 공급된 운영 환경에서 별도로 확인해야 한다. 테스트 fixture credential 성공을 운영 credential 준비 성공으로 취급하지 않는다.

## 메일 외부 발신 차단의 native 연결

`deploy/agent/mail-egress.mjs`가 `inet jgw_mail_egress`의 output 규칙을 렌더링한다. 지원하는 Mailpit Compose는 host networking과 loopback SMTP를 사용한다. IPv4/IPv6에서 loopback을 제외한 TCP 25/465/587을 거절하며 다른 표를 flush하지 않는다. bridge 기반 Mailpit으로 확대하지 않는다. 문법은 [공식 nft 설명](https://www.netfilter.org/projects/nftables/manpage.html)을 기준으로 작성했다.

native 설치는 고정 root-owned `firewall.nft`와 `jgw-mail-egress.service`를 준비하고 메일 시작 전에 해당 unit을 활성화·확인한다. 메일 unit은 이 unit을 Requires/After로 연결한다. 부팅 시 network-pre/Docker/메일보다 먼저 규칙을 준비한다. 기존 동일 이름 표는 정확한 root-owned 관찰 receipt가 없거나 내용이 다르면 인수·덮어쓰지 않는다. kernel handle을 제외한 규칙 구조를 비교한다.

고객 서버 전체의 외부 SMTP 차단 정책이므로 메일 해지 뒤에도 차단을 유지한다. 다른 방화벽 규칙을 재설정하거나 자동으로 포트를 다시 열지 않는다. 변경·해제는 별도의 운영 판단이다.

생성자와 렌더러는 비활성이다. native 준비/적용/기동/관찰은 root와 systemd PID1, 신뢰할 수 있는 고정 binary·bundle·unit 경로를 요구한다. 이번 검증의 guard·규칙/receipt 단위 시험과 새 실행 묶음 import는 소스 준비 증거다. 실제 nft --check/적용, IPv4/IPv6 외부 차단·loopback capture·재부팅 순서·기존 고객 방화벽 공존은 VM 미실행 항목이다.
