# 메일 imported realm 호환 수정·제품 회귀 (2026-10-08)

[j-auth fbbb7382eb5dc4805aab4bbf5e0d3b634aef03e0](https://github.com/wnwjdals7498/j-auth/commit/fbbb7382eb5dc4805aab4bbf5e0d3b634aef03e0)의 [코드/실제 진단 기록](https://github.com/wnwjdals7498/j-auth/blob/fbbb7382eb5dc4805aab4bbf5e0d3b634aef03e0/docs/cloud-imported-role-compatibility-2026-10-08.md)을 따른다. 기존 imported sample-a의 mail:read 부여403→j-auth503의 원인은 신규 tenant의 통합 성공과 별개로 재현·수정됐다.

이전 import template의 clientScopeMappings 방향 오류가 j-groupware에 mail:read alias를 추가했다. DB의 tenant+role 이름만 찾는 조회가 그 alias를 골랐고, canonical j-mail role만 허용하는 기존 FGAP가 거절했다. 조회에 카탈로그의 소유 client를 추가했고 새 import는 key를 역할 소유자, entry.client를 로그인 scope 소비자로 만든다. 기존 realm/권한/role/scope/자격은 바꾸거나 재import하지 않았다.

| 검사 | 실제 결과 |
| --- | --- |
| j-auth 전체 check | contract9·runtime config1·realm8·unit30·build/typecheck/lint/format 통과 |
| Node22.18/24.19 compatibility | 각각6/6, fail/skip0 |
| j-auth 전체 통합 |69/69, fail/skip0 |
| j-mail 영향 회귀 |18/18, fail/skip0 |
| PostgreSQL 모드 전체 BFF 영향 회귀 |122/122, fail/skip0 |

focused 시험은 기존 sample에서 member201/canonical 회수·재부여200/wrong alias403, 실제 j-mail 단일aud·sid·username·mail:read 축소 JWT, alias-only/비허용 role의 fail-closed 조회, 새 전체 선택 서비스의 actual Keycloak import·scope 방향·alias 없음·제한된 서비스 자격부여·실제 OIDC/PKCE/축소 JWT를 확인한다. 기존 catalog와 managed FGAP의 전후 hash는 일치했다. 일부 fixture/토큰 scope 가정 실패는 수정 전 결과에 보존했으며 통과로 계산하지 않는다.

기존 sample의 정상 mail role login scope는 비어 있지만 실제 축소 JWT에는 mail:read가 있었다. 이를 추가 인증 장애라고 단정하지 않는다. 기존 alias/scope drift의 정리나 재import migration은 미실행이고 범위에 추가하지 않았다. 브라우저·고객 VM 전체 인수는 여전히 미실행이다.

증거는 `/workspace/.suite-runtime/j-auth/mail-compat-results.json`, `mail-compat-node22-results.json`, `mail-compat-full-results.json`, `imported-mail-compat-evidence.json`, `/workspace/.suite-runtime/j-mail/auth-compat-regression-results.json`, `/workspace/.suite-runtime/j-groupware/auth-mail-compat-bff-results.json`이다. 제품 상태66/19/87과 whole_suite_verified=false는 유지한다.

E8은 전체 SMTP envelope 수신자 보존 방식과 FS-U07의 webhook 수신 전 누락 허용/복구 필요 기준이 결정돼야 한다. 임의 outbox/ingress/복구 정책을 추가하지 않았다. 공개 패키지 version/contents·운영 key/권한·외부 이메일/SMS/제3자 송신·설치/배포·PR/main 병합은 수행하지 않았다.
