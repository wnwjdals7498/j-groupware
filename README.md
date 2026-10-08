# j-groupware

고객별 웹서버-DB 1쌍, 하위 회원 관리 도구, 기준 UI 문서, 게시판.

Part of the j-groupware suite. See `j-groupware/docs/architecture.md`.

기능 명세: [제품군 기준·목차](docs/suite-feature-specifications.md), [j-groupware 상세 명세](docs/feature-specifications.md).

고객 BFF의 HTTPS 서버·PG 세션·OIDC 로그인·권한 검사·게시판 API를 구현했다. [실행·개발 안내](docs/server-development.md), [클라우드 검증 결과와 남은 범위](docs/cloud-bff-verification-2026-10-08.md), [구현 추적표](docs/implementation-progress.json)를 참고한다.

G23의 서비스별 token exchange·세션 cache·공통 내부 호출 함수도 구현했다. [검증 범위](docs/cloud-token-exchange-verification-2026-10-08.md)는 실제 제품별 업무 중계 인수와 구별한다.

회원 관리 BFF의 실제 j-auth 연결·권한 변경 후 세션 정리·미배치 저장은 [후속 검증 기록](docs/cloud-member-bff-verification-2026-10-08.md)을 따른다. 정식 화면과 전체 인수는 아직 미완료다.
