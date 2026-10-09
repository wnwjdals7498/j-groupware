# 제품별 내부 실행 번들

`build-product-bundle.mjs`는 이미 빌드된 groupware BFF, approval, Messenger,
Talk, Mail, Web, customer-auth의 일곱 내부 서버와 로컬 패키지를 포장한다.
등록되지 않은 서비스는 거부한다. 기본 BFF에는 contracts,
permissions, bff-auth와 설치/gateway 모듈을 함께 넣는다.
기존 봉인 자격을 사용하는 [명시적 one-shot agent](provision-agent.md)도
기본 번들에 포함하며 fresh 설치 후 inert import를 확인한다. native OS
설치기나 timer 활성화를 수행한 것으로 취급하지 않는다.

입력은 해당 제품 이름의 실제 체크아웃, 외부 출력 `.tar.gz`, 외부 mode-600
registry npmrc, npm cache와 npm-cli.js 경로다. 빌드·배포·서비스 활성화·registry
publish는 실행하지 않는다. 외부 CA·키·env·node_modules·web/desktop 앱은
읽거나 복사하지 않는다. symlink와 쓰기 가능한 비관리 입력, unpinned 직접
의존성, 과도한 파일/용량과 기존 출력 덮어쓰기를 거부한다.

컴파일된 server/contracts, 고정 DB migration, Talk 위젯(30 KiB 제한),
Web의 고정 root helper·sudo/SSH/FTP 구성만 포함한다. 런타임 package.json은
scripts를 제거하고 제품별 두 workspace, 기본 BFF의 네 workspace만 선언한다. 사설 loopback registry에서
`--package-lock-only --omit=dev --ignore-scripts`로 정확한 lockfile을 만들며
인증 npmrc는 복사하지 않는다. 현재 사설 registry 기본값은 127.0.0.1:4873이다.
사용자 노트북이나 운영 고객 서버에서 이 주소로 설치했다고 주장하지 않는다.

`jgw-bundle.json`은 NativeSystemdPlatform이 요구하는 suite-internal profile,
고정 entrypoint·SHA256·lockfile SHA256을 제공한다. 상세 파일 digest는 별도
`jgw-bundle-files.json`에 들어가며 전체 archive SHA256을 bootstrap staging에서
검사한다. root 소유 bundle ancestry, 실제 의존성 설치, helper 고정 위치 설치와
unit 활성화는 실제 설치 환경에서 별도로 수행해야 한다. Native preflight는
의존성 설치 후 기록된 `.jgw-install.json` 완료 표시와 lockfile digest도 요구한다.

`BundleInstaller`는 외부 소유 mode-755 runtime root에 임시 private stage를
만든다. gzip→USTAR를 스트림으로 읽고 압축 64MiB/해제 80MiB/파일 합계
64MiB, 개별 파일 4MiB와 개수 제한을 적용한다. 경로 탈출·절대 경로·중복·링크·
장치·확장 헤더·쓰기/특수 권한·손상 checksum·비영 trailer를 거부하고 metadata,
파일별 hash, workspace와 고정 registry lock을 검사한다. archive SHA256 확인
후에만 scripts를 끈 `npm ci`를 실행한다. 완료된 파일과 내부 의존성 링크의
권한을 서비스 계정이 읽을 수 있게 정규화하고, 기존 목적지를 덮어쓰지 않는
예약을 거쳐 최종 ready marker를 남긴다. 재시도는 같은 archive/hash의 기존
파일을 검사하고, 비관리/변경된 목적지는 보존하며 실패한다. npm 실패·취소와
압축 실패는 자신의 stage/예약만 정리한다. 이 API는 unit/OS 신뢰를 활성화하지 않는다.

`readPreparedBootstrap`와 `BaseEnvironment`는 봉인된 marker·CA fingerprint와
정확한 env 형식을 확인하고 BFF의 실제 환경 변수로 변환한다. agent key와
콘솔 자격은 BFF env에 넣지 않는다. 기본 BFF 준비 상태는 loopback에 접속하되
등록된 Host/SNI와 외부 인증서를 검증한다. 기본 번들에 `tls-credentials.mjs`와
`launch-service.mjs`가 포함된다. root 전용 source에서 서비스별 immutable
credential을 준비하고, unit의 고정 LoadCredential과 non-root launcher가
실제 TLS·CA·손님 JWT 키 경로를 연결한다. launcher는 새 Node 프로세스로
같은 PID를 유지해 CA trust를 시작 시 읽는다. Node22.18/24.19의 실제
격리 컨테이너에서 전용 계정의 자기 키 읽기·다른 계정/CA private key 거부와
HTTPS trust를 확인했다. 실제 systemd PID1 전달과 고객 계정 설치는 미실행이다.
customer-auth도 새 archive의 실제 설치·재시도·cold main 부팅, 전용 PG,
native Argon2·독립 guest JWT/JWKS·TLS readiness와 실제 Nginx 연결을 통과했다.
registry의 0.1.0 공용 contracts를 BFF exact dependency로 소비하고 cold CA의
contracts JS와 바이트 일치도 확인했다. [최신 연결 증거](../../docs/cloud-customer-relay-bundle-verification-2026-10-08.md)를
따른다. 정식 UI·전체 installer entrypoint·고객 VM 인수는 미완료다.

실행 인터페이스:

```sh
JGW_BUNDLE_NPM_CONFIG=/external/private/user.npmrc \
JGW_BUNDLE_NPM_CACHE=/external/cache/npm \
JGW_BUNDLE_NPM_CLI=/external/node/lib/node_modules/npm/bin/npm-cli.js \
node deploy/agent/build-product-bundle.mjs j-talk /checkout/j-talk /external/artifacts/j-talk.tar.gz
```

검사: `JGW_AGENT_TEST_RUNTIME=isolated-cloud npm run test:agent:bundles`와
`npm run test:agent:unpack`; 기본 cold BFF는 BFF 통합 검사에 포함된다.
이 클라우드에서는 TMPDIR를 실행 사용자 소유의 외부 private 디렉터리로 설정한다.
Node22.18/24.19 각각 4개 실제 검사에서 여섯 선택 제품 archive/lockfile을 생성하고,
저장소 node_modules 없이 `npm ci --omit=dev --ignore-scripts`를 실행했다.
압축 해제한 Talk/Web은 각자의 실제 격리 PostgreSQL에 연결되어 TLS 준비 상태를
통과했고 Talk의 packaged widget도 정확한 파일 바이트를 제공했다.
Approval/Mail/Messenger는 cold 의존성 설치와 compiled config import까지만
검사했다. 새 unpack 검사 19개는 기본 BFF/Talk의 실제 설치, idempotence,
기존 파일 보존과 독립 Python tar writer로 만든 위험 archive 14종 거부,
의존성 프로세스 실패/취소 후 stage와 lock 정리를 확인한다.
기본 BFF 통합 검사 4개는 봉인→안전 해제→cold 기동 후 실제 Keycloak 코드
로그인, PostgreSQL 게시판, 다른 tenant의 접근 거부, CSRF/Host/로그아웃을 확인한다.
이 세 제품의 cold 전체 기동, 고객 VM·20GB 디스크·systemd·CA 신뢰와
전체 제품군 인수 시험은 미실행이다. 검사 archive와 임시 cold 디렉터리는 정리된다.

기본 번들은 [고정 네이티브 진입점](native-installer.md)과 storage/Mailpit owner를 포함한다. 해제 후 wrapper만 0755로 복원하며 재시도의 권한 변조를 거절한다. 실제 OS 설치 완료를 뜻하지 않는다.
