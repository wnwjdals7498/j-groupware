# npm 레지스트리 사용

레지스트리는 `http://127.0.0.1:4873/`에서 loopback 전용으로 사용합니다. 3001 포트는 사용하지 않습니다.

처음 한 번 npm 계정을 등록하고 로그인합니다. 인증 토큰은 사용자 npm 프로필에만 저장합니다.

```powershell
npm adduser --registry http://127.0.0.1:4873/ --auth-type=legacy
```

패키지 디렉터리나 `package.json` 경로를 게시합니다.

```powershell
node scripts/registry-publish.mjs --package packages/contracts --registry http://127.0.0.1:4873/
```

게시 도구는 8개 `@j-*` 허용 scope, package manifest의 정확한 이름·버전, loopback registry를 확인합니다. 이미 게시된 버전, 외부 `publishConfig.registry`, 다른 scope registry 설정은 거절합니다. npm 실행 결과와 토큰은 출력하지 않습니다. 다른 사용자 npm 프로필은 `--npmrc <경로>`로 지정할 수 있습니다.

Verdaccio 6.10.5에서 빈 `unpublish` 값이나 빈 목록은 권한이 비어 있는 상태로 처리되지 않고 `publish` 권한으로 fallback됩니다. 그래서 8개 scope 규칙은 `unpublish: '__registry_unpublish_disabled__:deny'`를 사용합니다. 기본 `htpasswd` 플러그인은 `:`가 포함된 username 등록을 409로 거절하므로 계정이 이 그룹에 들어갈 수 없습니다. 이 규칙은 `htpasswd` 인증을 유지하고 등록 계정을 제한할 때 유효합니다. 인증 플러그인을 바꾸면 실제 unpublish 거절을 다시 확인해야 합니다.

레지스트리 저장소와 인증 파일을 archive로 백업합니다.

```powershell
node scripts/registry-backup.mjs --output D:\backups\verdaccio.tar.gz
```

기본 원본은 checkout 밖의 `..\.suite-runtime\verdaccio\storage`와 `..\.suite-runtime\verdaccio\htpasswd`입니다. 출력 경로는 새 파일이어야 하며 8개 서비스 checkout, runtime 경로, symlink/junction을 거치는 경로는 거절합니다. archive에는 비공개 패키지와 비밀번호 hash가 들어 있고 암호화되지 않으므로 접근을 제한해 보관합니다.

통합 검증은 다음 명령으로 실행합니다.

```powershell
node --test tests/registry/registry.integration.test.mjs
```

회사 노트북의 설치 제한으로 Docker/Compose 구성의 실제 기동은 검증하지 않았습니다. 검증은 이미 설치된 Node와 Verdaccio 6.10.5 CLI로 OS 임시 폴더에 config·storage·인증 파일·npm 프로필·패키지를 만든 뒤 loopback에서만 수행합니다. 실제 Verdaccio 계정 생성과 `npm whoami`, 게시·설치·import, scope 및 unpublish 거절, archive 내용을 확인하며 외부 registry는 사용하지 않습니다.
