# j-groupware

고객별 웹서버-DB 1쌍, 하위 회원 관리 도구, 기준 UI 문서, 게시판.

Part of the j-groupware suite. See `j-groupware/docs/architecture.md`.

기능 명세: [제품군 기준·목차](docs/suite-feature-specifications.md), [j-groupware 상세 명세](docs/feature-specifications.md).

고객 BFF의 HTTPS 서버·PG 세션·OIDC 로그인·권한 검사·게시판 API를 구현했다. [실행·개발 안내](docs/server-development.md), [클라우드 검증 결과와 남은 범위](docs/cloud-bff-verification-2026-10-08.md), [구현 추적표](docs/implementation-progress.json)를 참고한다.

G23의 서비스별 token exchange·세션 cache·공통 내부 호출 함수도 구현했다. [검증 범위](docs/cloud-token-exchange-verification-2026-10-08.md)는 실제 제품별 업무 중계 인수와 구별한다.

회원 관리 BFF의 실제 j-auth 연결·권한 변경 후 세션 정리·미배치 저장은 [후속 검증 기록](docs/cloud-member-bff-verification-2026-10-08.md)을 따른다. 정식 화면과 전체 인수는 아직 미완료다.

조직도 서버의 부서·직책·소속 편집, 기존 회원 등록·부분 생성 복구, 기본 결재선·로컬 후보 검증은 [G15 구현·실제 검증](docs/cloud-organization-verification-2026-10-08.md)을 따른다. 조직도 화면·실제 결재 업무는 후속 범위다.

실제 WSS/SSE 연결의 다중 인스턴스 종료·세션 폐기·장애 처리는 [실시간 검증 기록](docs/cloud-realtime-verification-2026-10-08.md)을 따른다. 하위 peer 전송 검사를 실제 메신저 업무 인수로 표시하지 않으며 알림 수신/저장/필터는 후속이다.
