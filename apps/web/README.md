# 고객 업무 화면

`@j-groupware/web`는 고객의 HTTPS BFF가 제공하는 React 화면이다. `npm run build`가 공개 UI와 화면을 먼저 빌드하고, BFF는 `apps/web/dist/index.html`과 고정 JS/CSS 목록을 읽어 제공한다. 운영 entrypoint는 화면 산출물이 없거나 잘못되면 시작에 실패한다. 신규 실행 묶음에도 같은 산출물을 포함한다.

- 실제 `/api/me`의 현재 권한·메뉴로 탐색을 구성한다. 서버도 같은 권한 표로 화면·API를 검사한다.
- 로그인은 기존 OIDC code/PKCE 흐름을 따른다. 브라우저에는 HttpOnly 세션 cookie와 메모리의 CSRF 값만 사용하고 Bearer·refresh token·서비스 키를 저장하지 않는다.
- 회원·권한·조직도·게시판·손님·API 키·메일·결재·상담·상담 설정·웹 관리·알림 화면을 기존 BFF 계약에 연결한다.
- 회원 생성 뒤 조직도 등록 실패 등 확정된 부분 결과는 별도 안내한다. 현재 목록 확인과 조직도 재등록으로 복구한다.
- API 키·위젯 키·사이트 계정 암호는 응답 직후 한 번 표시하며 사용자가 직접 복사할 수 있다. 창을 닫거나 화면·세션이 바뀌면 값을 버린다.
- 메일 HTML과 웹 미리보기는 sandbox iframe과 추가 CSP로 script·폼·외부 요청을 막는다. 게시판과 상담 텍스트는 React가 escape한다.
- 공개 메신저 패키지의 cookie BFF HTTP/WSS transport를 사용한다. 상담은 WSS와 서명 cursor sync, 알림은 전 화면의 SSE와 읽지 않은 수를 사용한다.

클라우드 테스트 환경에서 `npm run check`는 화면 build/typecheck와 기존 단위·스타일 검사를, `npm run test:web`는 실제 Keycloak·PostgreSQL·HTTPS BFF·Chromium 고객 화면을 실행한다. 전체 화면의 서비스 연결은 `npm run test:integration`에 포함된다. 테스트 계정·DB·브라우저 profile은 기존 격리 test job이 소유하며 운영 계정을 사용하지 않는다.

실제 고객 VM의 시스템 설치·서비스 활성화·CA 신뢰·방화벽·20GB 데이터 디스크·외부 접속 인수는 이 테스트와 별개다. 회사 노트북에는 설치하지 않는다.
