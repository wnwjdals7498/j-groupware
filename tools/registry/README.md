# 로컬 패키지 레지스트리

현재 회사 노트북에서는 Docker 설치·기동을 하지 않습니다. 아래 Compose 실행은 허용된 개발 환경용이고, 현재 검증은 기존 Node의 임시 Verdaccio fixture로 수행했습니다.

Verdaccio `6.10.5`를 `127.0.0.1:4873`에 실행합니다. 데이터와 htpasswd는 기본적으로 저장소 밖 `github/.suite-runtime/verdaccio`에 둡니다. 외부 경로를 쓰려면 `VERDACCIO_RUNTIME_DIR`에 절대 경로를 지정하세요. Linux Docker에서는 해당 경로를 컨테이너 UID `10001`이 쓸 수 있어야 합니다.

`npm ci` 후 `npm run registry:up`으로 시작하고 `npm run registry:down`으로 종료합니다. 첫 계정은 `npm adduser --registry http://127.0.0.1:4873/ --auth-type=legacy`로 만들고, 이어 `npm login --registry http://127.0.0.1:4873/ --auth-type=legacy`로 로그인합니다. 등록은 한 계정으로 제한하며, 게시 인증은 사용자 홈 `.npmrc`에 저장됩니다.

각 서비스의 `.npmrc.example`에는 scope별 로컬 경로만 적혀 있습니다. 기존 `.npmrc`를 교체하지 말고 필요한 설정을 반영하세요. 사용자 인증 토큰은 예제나 저장소에 넣지 않습니다. 8개 suite scope는 익명 읽기와 인증 게시를 허용하고, 나머지 package 이름은 npmjs 읽기/proxy만 허용합니다. 삭제 차단은 기본 htpasswd 사용자가 가질 수 없는 `__registry_unpublish_disabled__:deny` 권한 그룹으로 설정합니다. 이 그룹의 콜론은 기본 htpasswd 등록에서 URI-safe username 검사를 통과할 수 없습니다. 게시한 버전은 덮어쓰지 않으며 삭제도 허용하지 않습니다.

기본 포트는 `4873`입니다. `VERDACCIO_HOST_PORT`로 변경할 수 있지만 `3001`은 사용할 수 없습니다. 포트를 바꾸면 저장소 `.npmrc`의 loopback 주소도 같은 포트로 바꾸세요. 외부 bind 주소를 설정하는 항목은 두지 않았습니다.

참고: [Verdaccio Docker](https://www.verdaccio.org/docs/docker/), [npm 설정](https://www.verdaccio.org/docs/setup-npm/), [패키지 접근](https://www.verdaccio.org/docs/packages/), [인증 플러그인 권한](https://www.verdaccio.org/dev/plugin-auth/), [기본 htpasswd 플러그인](https://www.npmjs.com/package/verdaccio-htpasswd), [인증](https://www.verdaccio.org/docs/authentication/).
