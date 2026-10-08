# AU-11·GW-72 실제 registry Compose 검증

Node 22.18.0·24.19.0에서 `npm run test:registry:compose` 각 1/1 통과. 기존 4873 registry를 보존하고 고유 Compose project·외부 private runtime·loopback 4878로 실제 Verdaccio를 새로 띄웠다. `JGW_REGISTRY_TEST_RUNTIME=isolated-cloud` 표지가 필요하다. Docker root 운영 설치나 공개 registry 게시는 수행하지 않았다.

실제 `@j-auth/contracts` 0.1.0의 manifest·dist·문서를 복사하고 기존 publish helper로 게시했다. 익명 게시 거절, SHA-512 tarball 검증, 새 consumer 설치의 lock integrity·registry 주소·dist 바이트 일치, TOKEN_POLICY/SERVICE_CATALOG import, 같은 버전 재게시 및 unpublish 거절을 확인했다. 기존 registry 설정 파일은 바뀌지 않았다. fixture 사용자와 비밀번호·npm token은 checkout 밖 권한 600 파일에만 두고 시험 종료 시 자체 Compose와 임시 파일을 제거한다.

Compose는 기존 이미지의 UID 10001/GID 65533을 기본으로 유지한다. cloud fixture의 private bind directory 사용에 한해 VERDACCIO_UID/GID를 함께 지정할 수 있고 root·불완전·잘못된 정수 override는 거절한다. 테스트는 실제 nonroot 실행과 loopback publish를 Docker inspect로 확인한다. [Verdaccio Docker 공식 문서](https://www.verdaccio.org/docs/docker/)의 bind volume 소유권 제약에 따른 것이다. digest: `sha256:560744912b640ddc0f23cd475d296b663b656c0fcfa0ba17cc5ca1cbcb620225`.

외부 증거: `/workspace/.suite-runtime/j-groupware/ready-registry-compose-node{22,24}.log`. 첫 consumer assertion은 catalog 필드 id/serviceId를 혼동해 실패했고 `ready-registry-compose-first-consumer-failure.log`에 남겼다. 공개 계약의 serviceId로 교정한 뒤 실제 게시·설치를 다시 수행한 결과가 최종 증거다. 기존 ACL·backup 시험 증거는 이전 registry 검증 기록과 함께 사용한다.
