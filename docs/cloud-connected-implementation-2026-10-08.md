# 호스팅·설치 어댑터·상담 연결 구현 결과

클라우드 `/workspace`의 독립 작업 브랜치에서 수행했다. 이후 승인된
브랜치 푸시만 실행했고 PR·main 병합·운영 설치/활성화·배포는 하지 않았다.
회사 노트북과 예약 port 3001은 사용하지 않았다. 전체 제품군 인수는 false다.

## 실제 실행 증거

| 범위                           | 실제 최종 결과                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| j-web 인증·PG·특권 helper HTTP | Node 22.18.0·24.19.0 각각 11/11, skip 0, exit 0                                     |
| j-web 격리 root 호스팅         | 각각 4/4, skip 0, exit 0; 실제 Nginx·SFTP·FTPS·TLS·chroot·ext4·usage·rollback·백업  |
| j-groupware agent              | 각각 18/18, skip 0, exit 0; 기존 process/file reconcile 14 + 새 준비/복구 4         |
| j-groupware 서비스 DB          | 각각 3/3, skip 0, exit 0; 실제 PostgreSQL 18.6·pg_dump/restore·NOLOGIN·다른 DB 보존 |
| j-talk 인증·PG·widget 파일     | 각각 14/14, skip 0, exit 0; 기존 설정 8 + 새 저장/권한·artifact 6                   |
| 전체 j-groupware BFF 회귀      | Node 24.19.0 133/133, skip 0, exit 0                                                |
| root check                     | j-web 2+helper 1, j-groupware 74, j-talk 1; build/typecheck/lint/format 통과        |

호스팅 fixture는 이 작업의 Docker 컨테이너 안에서 만든 64 MiB loop ext4다.
고객의 20 GB 분리 디스크·외부 방화벽·systemd·CA trust 설치를 검증한 것으로
처리하지 않는다. 호스팅 fixture 종료 시 전용 mount·daemon을 정리했다.
DB fixture도 자기 무작위 컨테이너만 제거했고 기존 인증·registry·PG는 보존했다.

위젯 파일은 단일 CSS 포함 Vite artifact 1,199 bytes, gzip 733 bytes였다.
실제 HTTPS의 max-age=300·ETag·304와 visitor transport 미준비 시 DOM을
생성하지 않는 fail-closed 동작을 확인했다. 실제 채팅/브라우저 인수는 아니다.

유효한 DB password를 명시적으로 전달하고 cross-DB 거절 code 42501을
확인했다. pg Pool.options password를 spread로 복사하면 빠질 수 있어
웹·상담 검사 모두 이를 수정했다. 실패한 최초 실행도 보존했고 통과로
계산하지 않았다. 이번 BFF 최종 133개도 실제 runner exit 0을 확인했다.

## 변경의 범위

- j-web: root-owned 고정 helper, JSON stdin, 제한된 sudo 권한, 실제 서비스
  계정/chroot·TLS·Nginx 검증/reload/rollback, 분리 파일시스템/사용량,
  site create/retry/password reset/delete, 백업 후 제거 및 durable 작업 상태.
  [구현·호스팅 증거](../../j-web/docs/cloud-hosting-implementation-2026-10-08.md).
- j-groupware: bootstrap archive digest 검증과 비밀 env/CA 준비, 서비스별
  DB/계정 소유권·재시도, 제거 단계와 dump/NOLOGIN/backup/env 보존,
  고정 systemd unit 렌더러 및 필수 readiness/notification/gateway 어댑터.
  [내부 어댑터 범위](../deploy/agent/provisioning.md).
- j-talk: widget workspace/파일 배포, tenant FK·열린 방 제약,
  회원 조회·본인 배정·원자 답장/outbox·dedup·순서·종료.
  [회원 저장·위젯 증거](../../j-talk/docs/cloud-member-room-widget-2026-10-08.md).

설치 lifecycle 순서 시험은 명시적 test port를 사용했다. 실제 서비스 설치나
Nginx 구성 적용 증거로 바꾸어 해석하지 않는다. native systemd는 syntax
검사만 실행했다. 실제 root 보호 preflight 및 고객 unit 활성화는 미실행이다.

## 남은 작업과 관문

GW-63/64/65는 내부 구현이 추가됐지만 부분 구현이다. 콘솔 bootstrap/agent
키·desired/status producer, 실제 bundle 생성/전개, 서비스별 env/readiness·
알림 키 등록·고유 cleanup 연결, 설치 CLI와 시스템 활성화가 남았다.
이는 구현자가 이어 할 기술 작업이며 사용자/외부 차단으로 취급하지 않는다.

TK-01 배포 파일과 TK-40 골격, TK-20 회원 조회를 소스 완료로 구분한다.
방문자 발급/방 생성, 다른 회원 배정, 손님 전달/WSS/signed sync cursor,
실제 알림과 BFF relay는 남았다. TK-21/22/23/14/24의 저장·제약 부분만
구현됐고 전체 기능 인수가 아니다. 새 문의 생성 정책을 seed 시험으로
구현했다고 주장하지 않는다.

실제 제품 정책 관문은 기존 T2의 방문자 token 수명·회전·회수, browser WSS
인증 운반, guestId 재연결/방 소유권 충돌이다. H7의 수동 파일과 template
재배포 경계, 기존 UI 기준 답변, E8 메일 envelope/수신 전 누락 기준도
대기한다. E8은 전체 SMTP envelope를 신뢰된 capture adapter에 보존해
Mailpit ID와 연결하고, FS-U07 최소 범위대로 webhook 수신 전 누락 허용·
수신 후 outbox 재시도를 보장하는 선택을 권장한다. 무손실이 필요하면
durable ingress/reconciliation의 범위 확대가 필요하다. 어떤 선택도 실행하지 않았다.

외부 VM 인수는 실제 격리 대상·권한을 정한 뒤 실행해야 한다. 원격 CI
실행 결과는 이 로컬 테스트 결과와 별도이며 CI 통과를 주장하지 않는다.
전체 진행/미완료 분류는 [감사 JSON](cloud-remaining-feature-audit-2026-10-08.json)
및 [진행 JSON](implementation-progress.json)에 기록한다.
