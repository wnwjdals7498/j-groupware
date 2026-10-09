# 공통 UI Chromium fixture

`node --test tests/ui/browser.test.mjs`는 Vite가 고른 임시 로컬 포트에서 fixture를 제공하고 실제 Chromium으로 `@j-groupware/ui` 공개 export의 접근성·키보드·반응형 동작과 설치한 `@j-messenger/client-react` 정확 버전의 공개 앱·CSS를 검사한다. 메신저 API는 브라우저 내부 `fetch` fixture가 대신하며 실제 서비스/API 연결이 아니다.

검증 결과는 fixture 구성요소의 동작 근거다. `acceptance_complete`는 항상 `false`; 전체 제품 UI, 실제 Keycloak 로그인, 실제 메신저 API 또는 고객 인수를 완료했다는 뜻이 아니다. Chromium이 기본 경로에 없으면 `JGW_CHROMIUM_PATH`로 실행 파일을 지정한다. 브라우저 임시 파일은 `TMPDIR`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME` 환경 변수로 지정한 소유 디렉터리에 남긴다.
