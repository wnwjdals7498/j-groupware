# 구독·알림 키 투영의 격리 검증 — 2026-10-08

상태: **코드·실제 격리 검증 완료; 운영 설치기/에이전트 연결 미완료**. 기존 [알림 수신·결재 송신 증거](cloud-notification-verification-2026-10-08.md)를 보존한다. 운영 구독이나 키를 조회/변경하지 않았으며 아래 실제 j-auth 가입·해지는 시험이 생성한 두 임시 realm만 대상으로 했다.

`AuthSubscriptionReader`는 설정된 HTTPS j-auth origin의 `GET /auth/tenants/:tenant/services`만 호출한다. 운영사 Bearer와 console service key는 외부 control-plane 소유자가 공급하며 브라우저/BFF 세션과 구별한다. j-auth 원본 DB/Keycloak 내부 API를 읽지 않는다. 5초 timeout·취소·JSON16KiB·등록된 tenant service/중복/tenant 검증·redirect 거절을 적용한다. operator 자격은 BFF env에 넣지 않는다.

`NotificationKeyManifest`는 설치기가 소유하는 `{tenantId,revision,keys}`다. revision은 양의 signed64 decimal 문자열이고 `keys`에는 설치가 완료된 j-approval/j-talk/j-mail의 SHA-256 `currentHash`와 선택적인 `previousHash`/`previousExpiresAt`만 들어간다. 원문 키는 받거나 저장하지 않는다. previous expiry는 정확한 UTC ISO 시각이고 두 해시는 달라야 한다. 서비스 설치/해지·키 교체 시 manifest revision을 증가시킨다. 이는 키 세대 번호이며 j-auth 가입 상태 버전으로 해석하지 않는다. 설치 여부를 추정하지 않고 key manifest와 현재 실제 가입 목록의 교집합만 active로 투영한다.

`NotificationProjector`는 자기 jgw_groupware DB에서 tenant별 transaction advisory lock을 잡은 뒤 source를 읽는다. 다중 인스턴스의 늦은 source 관찰을 직렬화하고 낮은 manifest revision 또는 같은 revision의 다른 digest는409로 거절한다. 모든3개 서비스·세대/digest·source 확인 시각을 같은 트랜잭션으로 확정한다. 키/가입 누락은 inactive다. 원본 알림은 삭제하지 않으며 비활성 서비스의 목록/unread도 숨긴다. 조회 실패는 같은 트랜잭션에서 기존 source를 inactive로 확정하고503으로 보고한다. SQL 실패는 원자적으로 rollback한다. 원래 수신 dedup/대상/role/tenant/30일 필터는 보존했다.

`NotificationProjectionWorker`는 소유자가 명시적으로 시작해야 한다. 기본10초마다 한 번씩 직렬 reconcile하고 실패 후 재시도한다. stop은 timer/진행 중 source를 취소하고 완료를 기다린다. source 관찰의 유효 시간은 기본60초이며 DB clock으로 수신/조회 시 검사한다. worker 강제 종료·갱신 실패에도 마지막 관찰의 유효 시간이 지나면 수신과 노출을 거절한다. 이전 키의 절대 만료도 매 수신 때 DB clock으로 검사하므로 worker가 없어도 만료된다. source GET과5초 안에 협조하지 않는 callback은 bounded wait로 끝낸다. 운영 load/장애 관측은 별도다.

새 immutable `007-notification-projection.sql`이 유효 시간과 private 세대 상태를 추가한다. 기존 static 모드는 기본값으로 보존한다. 투영 소유권이 생긴 tenant에는 static configure를 거절해 재시작으로 옛 키가 재활성화되는 것을 막는다. 투영 모드 BFF는 `JGW_NOTIFICATION_REGISTRY_MODE=projection`과 private listener port를 명시하고 `JGW_NOTIFICATION_SERVICE_KEY_HASHES`를 생략한다. 자기 tenant의 소유권/3개 source 행이 준비돼야 시작한다. BFF는 registry를 사용하기만 하며 operator credentials나 control-plane worker를 실행하지 않는다. 실제 설치기·외부 worker entrypoint·원문 키 발급/서비스 env 배치는 후속이다. 이 변경으로 운영 모드를 자동 전환하지 않았다.

- j-groupware 전체 `npm run check`: 단위 **65/65**(기존57+source 경계8), build/type/lint/format 통과. source 경계8개는 격리 transport 시험이며 실제 auth 성공으로 세지 않는다.
- 전체 실제 BFF **114/114**, 실패/skip0. 기존103개와 투영11개다. 두 임시 tenant의 실제 j-auth 구독 GET/해지/재가입·실제 PG registry·별도 loopback HTTP 수신기를 사용했다.
- 투영11개는 tenant별 서로 다른 키/다른 tenant 거절, 실제 가입 상태 반영과 기존 알림 보존, 새/이전 키 중첩·실제 만료, stale/tampered 세대 거절, 실제 auth HTTP 목적지 장애/복구, 두 projector의 source 직렬화, 실제 mid-SQL trigger 실패/원자 rollback, DB 시각 lease 만료, 부정 manifest/키 누락, 비협조 source 취소/DB 연결 해제, 자동 polling/재시도/stop, compiled 수신기 시작·재시작/SIGTERM0을 확인했다.
- compiled BFF의 실제 `/proc/:pid/environ`에서 console key와 static notification key 변수가 없음을 확인했다. 시험용 공개 CA 경로는 유지했고 비밀 문자열을 출력하지 않았다. 생산 빌드/실제 부하/고객 VM 시험이 아니다.

최초11개 포함 전체 실행은 공개 CA 경로를 과도하게 제거해 compiled 시작5건이 실패했다. 격리 DNS resolver가 해당 공개 인증서 경로를 요구하는 원인을 확인하고 운영사 비밀 변수만 제외하도록 수정한 뒤114개를 다시 실행했다. 최초 실패를 통과로 처리하지 않았다. 원본 결과는 체크아웃 밖 `projection-check.log`, `projection-full-results.json`, `projection-full.log`에 둔다.

G18/G21 전체 agent/desired-state/설치·해지·키 provisioning과 운영 console, 정식 알림 UI/Playwright, 실제 메일/상담 송신기, 고객 VM/gateway 인수는 미완료다. GW-40은 운영 설치기 연결이 남아 partial이다. 전체172개 구현 분류는 구현55·부분15·미착수102이고 `whole_suite_verified=false`다. Windows PMT 도구/상태 경로 부재는 기록만 차단했다. 회사 노트북·운영 자격/구독·PR/main·배포를 변경하지 않았다.
