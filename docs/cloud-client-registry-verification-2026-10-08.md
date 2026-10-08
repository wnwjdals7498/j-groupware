# 메신저 공개 패키지 BFF 소비 검증 — 2026-10-08

메신저 공유 패키지 구현은 `07f8c72ef78a1ffed37b5f150c89f59e0f348871`이며 [게시·무결성·CSS consumer 증거](../../j-messenger/docs/cloud-client-registry-verification-2026-10-08.md)를 따른다. 격리 loopback Verdaccio에 core/react/contracts0.2.0을 최초 게시하고 공개 npm·운영 registry는 변경하지 않았다.

j-groupware에 정확한 `@j-messenger/client-core@0.2.0` dev dependency와 private registry URL/SHA-512 lock을 추가했다. 실제 BFF 시험은 이제 게시된 공개 import를 사용한다. 메신저 서비스 bootstrap용 sibling dist 참조는 격리 통합 환경에만 남아 있으며 제품 의존 코드로 복사하지 않았다. 기존 결재 contracts의 선언도 `^0.1.0`에서 정확0.1.0으로 고정해 S10과 맞췄다. 실제 설치 버전/내용은 유지했다.

- 실제 Node24와 최소 Node22.18 registry consumer **각1/1** 통과. 정확3개 버전·SHA-512/lock·배포 파일 제한·한 개 React·공개 타입·실제 Vite JS/CSS 산출물·중복 게시 거절을 확인했다. 정식 브라우저 화면 인수가 아니다.
- j-groupware offline npm ci **231개** 실제 설치, 전체 check 단위 **65/65**와 build/type/lint/format 통과.
- 게시된 client로 actual Keycloak·PostgreSQL·BFF HTTP/WSS 시험을 실행했다. 메신저14개 포함 전체 실제 BFF **114/114**, 실패/skip0. 결재/회원/조직/알림·구독/키 투영11개·compiled 시작/재시작/종료도 포함한다.
- 메신저 전체 check/build/format과 기존 server94·core17·React13·계약10·web4·deploy11을 유지했다.

원본은 체크아웃 밖 `registry-client-install.log`, `registry-client-ci.log`, `client-registry-check.log`, `client-registry-full-results.json`, `client-registry-full.log`에 둔다. registry의 기존 버전/회원/자료는 보존하고 정확히 없는 새0.2.0만 추가했다. auth profile과 cache는 체크아웃 밖이며 비밀을 출력하지 않았다.

이 checkpoint의172개 분류는 **구현56·부분15·미착수101**이다. MS-05 게시/설치와 MS-06 transport는 구현 범위에만 완료로 표시한다. MS-07 UI 토큰·MS-08 제품 경로 동결·GW-30 정식 화면/Playwright, 파일 BFF·고객 VM/운영 설치기/agent·메일/상담 업무 연결은 후속이다. `whole_suite_verified=false`이며 CI 실행이 없으면 통과로 표시하지 않는다. 회사 노트북·운영 자격/구독·PR/main·배포를 변경하지 않았다. Windows PMT 도구/경로는 없어 해당 기록만 미실행이다.
