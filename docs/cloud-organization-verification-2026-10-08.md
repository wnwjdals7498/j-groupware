# 클라우드 조직도·회원 등록 복구 검증 — 2026-10-08

G6 `5819923a3f0e192440384f4661e85a52e9897ae5`에 이어 G15 서버를 구현했다. j-auth 선행 API는 `1a8c09e933ab6de6fc953592ddda8cd9015620b9`다. 작업 브랜치는 두 저장소 모두 `codex/cloud-auth-foundation-20261008`이며, `/workspace`의 격리 Keycloak 26.8.0·PostgreSQL 18.6·HTTPS j-auth/BFF를 사용했다. 회사 노트북이나 운영 환경을 변경하지 않았다.

## 구현·API

| 경로 | 권한·입출력 |
| --- | --- |
| `GET /api/organization?cursor=…` | `org:manage`. `{revision,departments,positions,members:{revision,items,nextCursor}}`. 회원은 50개씩 읽는다. |
| `POST /api/organization/departments` | `org:manage`. `{revision,name,parentId}` → 201 `{revision,department}`. `parentId=null`은 최상위 부서다. |
| `PATCH /api/organization/departments/:id` | `org:manage`. `{revision,name,parentId,headMemberId}` → `{revision,department}`. nullable 값을 명시한다. |
| `DELETE /api/organization/departments/:id` | `org:manage`. `{revision}` → `{revision}`. 자식 부서나 소속 회원이 있으면 409다. |
| `POST /api/organization/positions` | `org:manage`. `{revision,name}` → 201 `{revision,position}`. |
| `PATCH /api/organization/positions/:id` | `org:manage`. `{revision,name}` → `{revision,position}`. |
| `DELETE /api/organization/positions/:id` | `org:manage`. `{revision}` → `{revision}`. 배정된 회원이 있으면 409다. |
| `PUT /api/organization/members/:id` | `org:manage`. body 없이 실제 j-auth 단건 조회 후 기존 회원을 등록·동기화한다. `{revision,member}`를 반환한다. |
| `PATCH /api/organization/members/:id` | `org:manage`. `{revision,departmentId,positionId}` → `{revision,member}`. 소속 부서·직책은 각각 하나 또는 null이다. |
| `POST /api/members/:id/organization` | `member:manage`. body 없이 실제 단건 조회 후 부분 생성의 조직도 등록을 복구한다. 재생성·비밀번호 조회는 하지 않는다. |
| `GET /api/organization/candidates?cursor=…` | `approval:use`. 같은 tenant의 등록·활성 회원, 미배치 포함·작성자 제외. 50개와 revision/cursor를 반환한다. |
| `GET /api/organization/approval-line` | `approval:use`. 자기 소속 부서장 → 상위 부서장 순서의 `{revision,memberIds}`. 작성자·중복·비활성 부서장은 제외한다. 미배치는 빈 배열, 미등록 작성자는 404다. |
| `POST /api/organization/approval-line/validate` | `approval:use`. `{memberIds}` 1~32개 → `{revision,memberIds}`. 입력 순서를 보존하고 작성자·중복은 400, 미등록·외국·비활성 후보는 404다. |

변경에는 기존 세션·정확한 Origin·CSRF 검사가 필요하다. 추가 body 필드는 400, 등록·복구 API의 body도 400이다. tenant는 서버 설정에서만 결정한다. 부서/직책 id는 UUID, 회원 id는 기존 j-auth 경로 계약을 사용한다. 이름은 trim 후 1~120자이고 제어 문자는 거절한다. 부서는 최상위 또는 같은 부모 내에서 이름이 유일하며 직책 이름은 tenant 내에서 유일하다. 부서 최대 500개·깊이 32, 직책 최대 200개다. 부서장은 등록·활성·해당 부서 소속 회원이어야 하고 부서장을 이동하려면 먼저 지정 해제해야 한다. 삭제 시 자식·회원 배치를 자동으로 옮기지 않는다. 이는 FS-U08의 G15 상세 제약을 고정한 것이다.

## 저장·동시성·복구

`004-organization.sql`은 적용된 001~003을 바꾸지 않고 `unassigned_members`를 `organization_members`로 이름 변경한다. 기존 id·username·created_at을 보존하고 enabled=true·부서/직책 null을 추가한다. 부모·부서장·소속·직책 FK 모두 `(tenant_id,id)` 경계를 사용한다. 테이블의 PUBLIC 권한을 회수한다.

읽기와 변경은 tenant 조직도 advisory transaction lock으로 일관된 revision을 사용한다. 부서·직책·소속 변경은 클라이언트 revision과 현재 값이 다르면 409다. 클라이언트는 다시 읽고 사용자 수정 의도를 재확인해 요청한다. 동시에 반대 방향으로 부모를 바꾸면 한 요청만 반영하고 다른 요청은 409이며, 최신 revision으로 재시도해도 순환을 만들 수 없다. 실패한 SQL과 revision은 함께 rollback한다. cursor는 tenant·조회 종류/작성자·revision에 묶이고 변경 이후에는 409로 첫 페이지부터 다시 읽도록 한다. 잘못된 cursor는 400이다.

새 회원의 확인된 생성 결과는 자동으로 미배치에 등록한다. 등록 실패의 503은 외부 회원 생성이 취소됐다는 뜻이 아니다. 실제 회원 목록에서 id를 확인해 복구 API를 호출한다. 같은 username으로 생성 재전송은 409다. 기존 회원·Keycloak 콘솔 계정은 조직도 등록 API를 사용하며, j-auth가 자기 realm의 일반 회원인지 확인한다. 반복·동시 등록은 하나의 행만 만들고 기존 소속·직책을 보존한다. username·enabled가 그대로면 revision도 바꾸지 않는다. 비활성 확인 시 부서장 지정을 해제한다.

j-auth에는 원래 BFF access token과 서버의 자기 tenant 서비스 키만 보낸다. `org:manage`는 최소 단건 읽기 API를 사용할 수 있지만 회원 목록·생성·삭제·역할 변경 권한을 얻지 않는다. 같은 회원별 lock과 `member_session_ends`를 사용해, 조회 시작 뒤 삭제/권한 변경이 확인된 회원의 늦은 등록 결과는 409로 거절한다. 비교 시각은 PostgreSQL 마이크로초를 유지한다. 확인된 삭제는 세션/cache와 조직도 회원·부서장 참조를 정리하며 부분 삭제 재시도 계약도 유지한다.

결재선과 후보 검증은 로컬 조직도만 사용한다. 없는 결재자를 외부 서비스 조회로 검증하는 기능은 추가하지 않았다. 등록·복구 시의 존재 확인과 결재 단계 후보 검증은 서로 다른 동작이다. Keycloak 콘솔의 외부 변경을 자동 감시하지 않으며 명시적 재등록으로 이름/활성 상태를 갱신한다. 실제 상신 시점의 재검증·결재선 스냅샷·삭제된 결재자의 진행 문서 처리는 G16·j-approval A2의 후속 계약이다.

## 실행 결과

- `npm run check`: build·테스트 타입 검사·단위 **48/48**·lint·format 통과.
- `npm run test:integration -- --reporter=json --outputFile=…`: 전체 **52/52**, 실패 0·미실행 0. 기존 BFF/회원/G23 32개와 조직도 20개를 함께 실행했다.
- `npm run test:registry`: 실제 격리 Verdaccio 검사 **1/1**, 실패·미실행 0. 공개 npm 게시를 하지 않았다.
- j-auth 선행 변경의 `npm run check`: 기존 Node 검사 18개·Vitest 30개와 정적 검사 통과. `npm run test:integration`: 실제 **63/63**, 실패·미실행 0. [j-auth 기록](../../j-auth/docs/cloud-organization-member-read-2026-10-08.md)을 따른다.

실제 검증은 org-only 회원의 조회/편집과 member 권한 거절, 원래 Bearer·서비스 키 전달, 부분 생성 복구·동시 등록·배치 보존, foreign id/키·CSRF·추가 입력, 부서/직책 CRUD·순환·개수/깊이 제한·동시 수정, composite FK, DB 실패 rollback/재시도, 삭제 뒤 늦은 실제 조회 응답, 부서장 지정·해제·실제 회원 삭제, 작성자 제외·미배치·커스텀 결재선·로컬 후보만 검증, 실제 비활성 계정 확인, 페이지/cursor 경계, 실제 역할 회수·로그아웃 후 접근 거절, compiled HTTPS 서버를 포함한다.

마이그레이션 업그레이드는 격리 DB의 rollback-only 스키마에 003의 기존 행을 넣어 004 실행 후 원본 필드와 새 nullable 필드를 확인했다. 개수 제한과 pagination은 해당 테스트 소유의 DB 전용 등록 행을 사용했다. 이 행들까지 Keycloak에서 생성한 계정이라고 표시하지 않는다. 등록·복구·권한·삭제 경쟁 검사는 실제 j-auth/Keycloak 계정을 사용했다.

원본 결과는 `/workspace/.suite-runtime/j-groupware/organization-integration-results.json`, `organization-check.log`, `organization-registry.log`, `/workspace/.suite-runtime/j-auth/integration-results-phase5.json`이다. 문서 검사 결과는 별도 `organization-spec-validation.json`에 저장한다. 이는 문서 연결·172개 기능 명세 검사이며 기능 인수 실행 결과가 아니다.

## 남은 범위

G15 조직도 화면·회원 복구 화면·Playwright는 미완료이며 기준 `docs/ui-guidelines.md`가 없다. 이 결손은 이번 서버 구현·실제 테스트를 막지 않았다. 기본/커스텀 결재선 API의 통과를 GW-T07 전체 통과나 실제 j-approval 상신·N단계 승인/반려 통과로 표시하지 않는다.

실제 WSS/SSE relay·연결 종료, 제품별 업무 API 중계와 운영 콘솔, Nginx·고객 서버 설치/해지·Hyper-V/VM 인수는 후속이다. 테스트의 세션 종료 hook을 실제 WSS/SSE 종료로 표시하지 않는다. PR·main 병합·배포를 수행하지 않았고 `whole_suite_verified=false`를 유지한다.
