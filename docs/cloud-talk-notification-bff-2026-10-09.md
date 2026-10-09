# 22차 Talk 계약 소비·실제 알림 연결

`@j-talk/contracts@0.1.0` 최초 immutable registry 게시물을 exact dependency와
lock으로 소비한다. 기존 회원 HTTP schema·상태·UTF-8 상한을 BFF와 Talk 서버가
공유하며 자기 배정 응답의 occurrenceId를 검증·반환한다. 허용 출처/키 관리,
방문자 preflight의 기존 의미를 유지하고 T2 방문자/WSS 정책을 추가하지 않는다.
ProductEnvironment는 명시적 기존 notificationOrigin이 있을 때 Talk의
JT_NOTIFICATION_URL/KEY를 생성한다. native CLI의 operating owner 거절은 유지한다.

Talk 소스: [ff6d4eb706ff366e0c3babb4c8726cfed1793581](https://github.com/wnwjdals7498/j-talk/commit/ff6d4eb706ff366e0c3babb4c8726cfed1793581).
[backend 상세 기록](../../j-talk/docs/cloud-notification-contract-verification-2026-10-09.md)을 따른다.

Node22.18/24.19 실제 G22 통합6개 exit0·skip0: rooms INSERT와 같은 transaction의
새 문의 trigger, 실제 두 자기 배정의 서로 다른 occurrence/원래 담당자,
role/read 목록과 SSE, room/assignment rollback, 실제 receiver 중단 재시도,
ACK PG 오류 중복 제거, 다중 sender lease/다른 tenant 제외와 compiled Talk main을
강제 종료한 뒤 실제20초 lease 만료·모호한 수신 복구다. 테스트는 실제
j-auth/Keycloak 회원·BFF token exchange·전용 Talk/Groupware PG와 G22 receiver를 쓴다.
초기 테스트의 PG 방 INSERT는 공개 visitor issuer/ownership 구현을 대신하지 않는다.

Groupware check의 BFF 단위80은 두 Node에서 exit0이다. 두 final focused 로그는
`/workspace/.suite-runtime/j-groupware/talk22-notifications-final-node{22,24}.log/.exit`다.
전체 회귀와 account/storage 변경의 최종 결과는 22차 최종 감사 기록에 추가한다.

동일 tenant의 임의 담당자 배정은 현재 j-auth profile(member:manage/org:manage)
조회 권한 및 BFF가 검증한 대상의 Talk 전달 계약이 없는 관문이다. talk:write에
회원 관리 권한을 임의 추가하거나 Talk가 다른 서비스 DB/API를 직접 조회하지 않는다.
T2/E8/H7·UI·운영 자격/배치와 실제 VM 인수는 미완료다.
