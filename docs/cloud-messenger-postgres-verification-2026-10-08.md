# 메신저 M5 PostgreSQL 연결 검증 — 2026-10-08

상태: **M5 backend·실제 PostgreSQL/Keycloak 검증 완료; 전체 인수 시험 미완료**. 기존 [M1 SQLite 증거](cloud-messenger-auth-verification-2026-10-08.md)는 당시 실행 기록으로 보존한다. 새로운 [메신저 저장·이관·복구 범위](../../j-messenger/docs/cloud-postgres-verification-2026-10-08.md)를 함께 읽는다.

메신저 구현 커밋: `8bb23dd99bf294e1b1c6fc46ee34c3590ac89428`.

`tests/bff/messenger.integration.test.ts`의 DB 관찰을 async 저장 port에 맞추고 명시적 격리 PostgreSQL profile을 추가했다. SQLite profile도 유지한다. PG env는 체크아웃 밖이고 `isolated-cloud-messenger-pg` marker·jgw_messenger 계정/DB·127.0.0.1:54240을 요구한다. 각 시험이 만든 새 test_ms schema만 정리하며 서비스 운영 DB/자격/구독은 변경하지 않았다.

실제 j-auth가 생성한 두 임시 realm/회원의 Code/PKCE·단일 audience exchange로 compiled 메신저 두 인스턴스의 PostgreSQL 업무 HTTP/WSS를 검증했다. 같은 username의 tenant별 내부 ID·session 미저장·401/403/JWKS503·cookie/query/Origin 거절·두 회원 메시지/중복/충돌/다른 tenant404·단절 cursor sync·재시작 보존·compiled main/SIGTERM을 확인했다. BFF의 실제 WSS relay는 로그아웃과 실제 role 회수로 종료된다.

- 메신저 실제 PG 시험 **15/15**, Node22.18, 실패/skip0. 이관 원본 SHA-256·첨부 byte·커서·sequence·atomic rollback·두 실제 HTTP 서버 동시 재시도·pg_dump/pg_restore를 포함한다.
- 실제 Keycloak PG 메신저/BFF 시험 **11/11**, 실패/skip0.
- 전체 실제 BFF **100/100**, 실패/skip0. 기존/결재73·알림16·메신저11. `JGW_TEST_ENV=/external/messenger-pg.env npm run test:integration`으로 실행했다.
- j-groupware 전체 check의 단위48·build/type/lint/format, 메신저 SQLite 서버94와 계약/core/React/web/배포 회귀, j-auth18+30와 j-approval17의 전체 check를 통과했다.

M5의 저장 기반을 구현했으며 **BFF 업무 HTTP route·client/UI·M2 패키지 공유·고객 VM/설치·부하·전체 제품군 인수는 미완료**다. SQLite 새 자료가 있다면 명시적 offline 이관이 필요하고 실제 고객 이관은 실행하지 않았다. PG 새 쓰기 이후 SQLite 역이관은 지원하지 않는다. Windows PMT 경로/도구 부재는 해당 기록만 차단한다. 정식 UI 기준·구독/키 자동 투영·메일/상담 업무 연결도 후속이다. `whole_suite_verified=false`를 유지한다. 회사 노트북·운영 환경·PR/main/배포를 변경하지 않았다.
