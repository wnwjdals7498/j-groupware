# 제품별 내부 실행 번들

`build-product-bundle.mjs`는 이미 빌드된 approval, Messenger, Talk, Mail,
Web의 내부 서버와 로컬 contracts만 포장한다. customer-auth와 기본 groupware
bootstrap 번들은 대상이 아니며 준비되지 않은 서비스는 거부한다.

입력은 해당 제품 이름의 실제 체크아웃, 외부 출력 `.tar.gz`, 외부 mode-600
registry npmrc, npm cache와 npm-cli.js 경로다. 빌드·배포·서비스 활성화·registry
publish는 실행하지 않는다. 외부 CA·키·env·node_modules·web/desktop 앱은
읽거나 복사하지 않는다. symlink와 쓰기 가능한 비관리 입력, unpinned 직접
의존성, 과도한 파일/용량과 기존 출력 덮어쓰기를 거부한다.

컴파일된 server/contracts, 고정 DB migration, Talk 위젯(30 KiB 제한),
Web의 고정 root helper·sudo/SSH/FTP 구성만 포함한다. 런타임 package.json은
scripts를 제거하고 두 workspace만 선언한다. 사설 loopback registry에서
`--package-lock-only --omit=dev --ignore-scripts`로 정확한 lockfile을 만들며
인증 npmrc는 복사하지 않는다. 현재 사설 registry 기본값은 127.0.0.1:4873이다.
사용자 노트북이나 운영 고객 서버에서 이 주소로 설치했다고 주장하지 않는다.

`jgw-bundle.json`은 NativeSystemdPlatform이 요구하는 suite-internal profile,
고정 entrypoint·SHA256·lockfile SHA256을 제공한다. 상세 파일 digest는 별도
`jgw-bundle-files.json`에 들어가며 전체 archive SHA256을 bootstrap staging에서
검사한다. root 소유 bundle ancestry, 실제 의존성 설치, helper 고정 위치 설치와
unit 활성화는 실제 설치 환경에서 별도로 수행해야 한다.

실행 인터페이스:

```sh
JGW_BUNDLE_NPM_CONFIG=/external/private/user.npmrc \
JGW_BUNDLE_NPM_CACHE=/external/cache/npm \
JGW_BUNDLE_NPM_CLI=/external/node/lib/node_modules/npm/bin/npm-cli.js \
node deploy/agent/build-product-bundle.mjs j-talk /checkout/j-talk /external/artifacts/j-talk.tar.gz
```

검사: `JGW_AGENT_TEST_RUNTIME=isolated-cloud npm run test:agent:bundles`.
이 클라우드에서는 TMPDIR를 실행 사용자 소유의 외부 private 디렉터리로 설정한다.
Node22.18/24.19 각각 4개 실제 검사에서 다섯 제품 archive/lockfile을 생성하고,
저장소 node_modules 없이 `npm ci --omit=dev --ignore-scripts`를 실행했다.
압축 해제한 Talk/Web은 각자의 실제 격리 PostgreSQL에 연결되어 TLS 준비 상태를
통과했고 Talk의 packaged widget도 정확한 파일 바이트를 제공했다.
Approval/Mail/Messenger는 cold 의존성 설치와 compiled config import까지만
검사했다. 이 세 제품의 cold 전체 기동, 고객 VM·20GB 디스크·systemd·CA 신뢰와
전체 제품군 인수 시험은 미실행이다. 검사 archive와 임시 cold 디렉터리는 정리된다.
