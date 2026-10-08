# 클라우드 알림 수신·배달·복구 — 2026-10-08

선행 결재 BFF `059b598543c4168b2e5b28f04bb30d4b4a6b1567`과 j-approval 송신기 `a29271fbc583e274b313103105b64d661b1a7afe`를 연결했다. 이 기록은 backend 실제 배달 증거이며 알림 화면/고객 VM/전체 제품군 인수 완료를 뜻하지 않는다.

## G22 수신·조회 계약

별도 Fastify 수신기는 `JGW_INTERNAL_NOTIFICATIONS_PORT`의 **127.0.0.1**에만 bind한다. 외부 BFF에는 `POST /internal/notifications`를 등록하지 않는다. Origin/Cookie/Authorization을 가진 요청은 거절하며 서비스별 별도 내부 키 `X-JGW-Internal-Key`를 검사한다. body는 최대 16 KiB다. 수신 payload는 `{tenant,service,type,members|usernames|role,title,body,link,dedupKey}`이고 대상 필드는 정확히 하나다. tenant는 설치된 서버 tenant와 같아야 하고 현재 등록/active 서비스와 일치해야 한다.

제목은 trim 후 1~200 UTF-16 code unit, 본문은 UTF-8 최대 1,024 byte, 사건 키는 1~256자다. 대상 배열은 중복 없이 1~100개, 각 값은 trim 후 1~128자다. control 문자·추가 필드·미등록 종류·서비스와 다른 종류·외부/상대 경로/query/fragment 링크를 거절한다. 키는 20~128자의 base64url 값이다. 알려진 종류는 `approval.turn`, `approval.done`, `talk.new`, `talk.assigned`, `mail.new`이며 private permissions catalog가 필요 role·아이콘·이름·허용 로컬 링크를 소유한다. 실제 업무 송신기는 이번에 결재만 연결했으며 상담/메일의 payload 검사를 실제 상담/메일 배달 성공으로 계산하지 않는다.

immutable `006-notifications.sql`은 알림/서비스별 키 해시/회원별 읽음과 unique `(tenant,service,dedupKey)`를 저장한다. 같은 사건·같은 내용을 동시에 재송신하면 같은 id와 duplicate=true를 반환하고, 같은 키의 내용 변경은 409다. 원문 내부 키는 저장하지 않는다. `JGW_NOTIFICATION_SERVICE_KEY_HASHES`의 JSON에는 서비스마다 SHA-256 hex 최대 두 개를 넣어 키 교체 기간의 중첩을 허용한다.

이 로컬 등록 표는 **설치자가 구독·설치 상태를 반영할 신뢰 경계**다. 시험은 실제 j-auth 가입 후 표를 구성하고 inactive 상태·키 회수를 확인했다. j-auth 구독 해지의 자동 투영/키 provisioning/운영 설치자가 잘못 등록한 상태 교정은 아직 G18/G21 후속이다. 따라서 GW-40은 부분 구현으로 유지한다.

쿠키 세션의 `GET /api/notifications`는 현재 role·회원 sub/username/role 대상·active 서비스·tenant·30일 보관 필터를 적용한 `{items,nextCursor,unread}`다. 50개씩 최신 생성 시각/UUID 내림차순이고 cursor는 tenant/회원과 DB microsecond에 묶인다. unread도 같은 필터이며 cursor 뒤 page에서도 전체 미읽음 수를 반환한다. `POST /api/notifications/:id/read`는 기존 Origin/CSRF 검사와 현재 조회 권한을 통과한 회원에게만 idempotent 읽음 시각을 기록한다. 다른 회원/tenant/권한 없는 id는 404이며 그 회원의 읽음 행을 만들지 않는다. target·내부 키·다른 회원 id는 응답하지 않는다.

30일 초과 알림은 조회/SSE에서 즉시 숨기고 startup와 60초 purge가 tenant별 1,000건씩 삭제한다. 읽음 상태는 FK cascade로 함께 제거한다. purge 실패는 다음 회차 재시도 대상이며 운영 retention 모니터링은 별도 후속이다.

## SSE와 배달 복구

`GET /api/notifications/stream`은 기존 세션 closure를 유지하고 `event: notifications`의 data에 위 필터의 **최신 목록 snapshot**을 보낸다. 접속 시 최초 snapshot, commit 뒤 PostgreSQL NOTIFY, 1초 reconciliation polling으로 현재 목록/unread를 갱신한다. 개별 사건 replay/Last-Event-ID 계약이 아니다. 최신 50건 밖의 이력은 목록 cursor로 읽는다. reconnect 초기 snapshot과 authoritative 목록 조회로 단절을 복구한다. snapshot이 같으면 중복 frame을 보내지 않으며 느린 연결은 64 KiB buffer 상한으로 닫는다. 세션/역할 회수·logout·만료·listener/DB 장애 때 종료한다.

결재 송신은 자기 DB outbox claim을 commit한 뒤 같은 사건을 보낸다. 20초 lease·SKIP LOCKED·5초 HTTP timeout·2~60초 backoff·동일 lease ACK로 조정한다. 수신 commit과 송신 delivered_at 확정이 분리되므로 재송신이 발생할 수 있으며 unique 수신으로 한 건을 유지한다. 자세한 [결재 송신 계약](../../j-approval/docs/cloud-notification-delivery-2026-10-08.md)을 따른다.

## 실제 실행 증거

- `npm run check`: build/typecheck·단위 48/48·lint/format 통과.
- 전체 `npm run test:integration`: **89/89**, 실패·skip 0. 기존 73개와 신규 알림 16개다.
- j-approval `npm run check`: 단위 17/17 포함 통과, 기존 실제 회귀 21/21, 공개 계약 registry 시험 1/1 통과.

실제 j-auth로 두 임시 realm과 회원/서비스 가입을 만들고 Keycloak Code/PKCE·single-audience exchange, 별도 그룹웨어/결재 PG와 actual compiled approval HTTP 서버를 사용했다. 외부 미등록 경로·loopback 분리·오류 키/서비스/tenant·브라우저 헤더 거절, 실제 상신/다음 차례/최종 승인/반려의 수신·목록·unread·SSE, 개인정보 본문 미복제, 같은 사건 동시 수신·내용 충돌, payload/UTF-8 한계, 회원별 읽음·현재 role·타 tenant 차단, 51건 paging/누락·중복/다른 회원 cursor 거절을 검사했다.

수신기를 실제 중단해 실패를 영속화한 뒤 실제 backoff를 기다려 복구했다. 격리 ACK trigger 실패로 수신만 commit한 뒤 재시도해 한 건을 유지했다. 두 송신기의 concurrent claim도 한 번이었다. compiled 송신기를 SIGKILL해 committed lease/수신 확정/미ACK 상태를 만들고 실제 20초 만료 전 재송신 거절·만료 후 같은 사건 한 건/ACK 복구를 확인했다. compiled 수신기와 자동 송신기 startup·실제 receipt·정상 SIGTERM exit 0도 통과했다. 키 중첩/제거·inactive 서비스·실제 역할 회수 SSE 종료·새 무권한 세션 차단·31일 알림/읽음 삭제를 확인했다. DB/수신기/업무 서버/token을 fake로 대체하지 않았고 fault injection과 직접 DB 관찰/정리는 격리 fixture에만 사용했다.

원본은 체크아웃 밖 `/workspace/.suite-runtime/j-groupware/notification-check.log`, `notification-full-results.json`, `notification-full.log`와 j-approval의 `sender-*` 기록이다. 앞선 targeted 15개 성공 후 51건 paging 시험을 추가해 전체 89개를 재실행했다. 실패/미실행 실행을 통과로 계산하지 않았다. j-approval 위 SHA의 GitHub Actions/check-runs/combined status는 조회 시 0건이며 원격 CI 통과로 표시하지 않는다.

정식 알림 화면(아이콘/클릭 이동)/Playwright, 구독 상태 자동 투영·서비스 키 운영 provisioning, 실제 상담/메일 송신기, 메신저 PostgreSQL/BFF 업무 인수, 고객 VM/Nginx 설치/해지는 미실행이다. `whole_suite_verified=false`를 유지한다. 기존 사용자 변경/회사 노트북 제한을 보존하며 작업 브랜치만 사용한다.
