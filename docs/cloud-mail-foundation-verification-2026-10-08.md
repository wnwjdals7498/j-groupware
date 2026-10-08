# 메일 기반 진행 근거 (2026-10-08)

j-mail E1/E2는 [기반 커밋 21aaf1638e5cc66c7650388fdf20186ae0e9db82](https://github.com/wnwjdals7498/j-mail/commit/21aaf1638e5cc66c7650388fdf20186ae0e9db82)으로 승인된 작업 브랜치에 게시했고 원격 SHA 일치를 확인했다. [실행·한계 기록](https://github.com/wnwjdals7498/j-mail/blob/21aaf1638e5cc66c7650388fdf20186ae0e9db82/docs/cloud-foundation-verification-2026-10-08.md)을 따른다.

ML-01·02 구현과 실제 Mailpit SMTP/전용 PostgreSQL 6개를 Node22·24 각각 확인했다. j-mail 전체 check는 unit2·deploy3·build/typecheck/lint/format 통과다. 최초 PG mount 읽기 권한 실패로 각 실행 6개가 skip된 결과를 보존했고 이후 실제 재실행 통과와 구별했다. 컨테이너 network none의 private Unix socket을 loopback으로 연결하여 외부 이메일 송신 없이 수신·거절·보관·재기동·DB 권한을 시험했다.

ML-03은 relay 없음/격리 수신만, ML-30은 DB/Compose/migration 골격만 구현하여 partial이다. VM egress 방화벽·systemd·outbox는 아직 없다. Mailpit To/Cc/Bcc 표시 필드는 SMTP 권한 근거가 아니며 E3에서 실제 수신 근거를 확인한다. 첫 Received가 전체 SMTP 수신자를 보존하지 않으므로 E8의 모든 수신자 알림 및 FS-U07 누락/복구 기준은 미정으로 남긴다. 전체 제품군 verified=false를 유지한다.
