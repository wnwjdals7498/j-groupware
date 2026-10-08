# 고객 gateway (G11, GW-60·61·62)

프로파일의 허용 tenant·가입 서비스를 검증한 뒤 **실제 `envsubst`에 명시한 변수 목록만** 넘긴다. `$http_host`, `$request_uri`, `$binary_remote_addr`와 WebSocket 변수는 보존한다. 원본은 `nginx.conf.template`, `gw.conf.template`, `snippets/tls.conf`다. `/etc/nginx`를 대상으로 하면 결정 8의 `jgw.d`·`jweb.d` include가 만들어진다. `jweb.d` 파일은 읽는 것 외에 변경하지 않는다.

외부 env의 서비스 목록은 설치기 소유 상태다. 이 모듈은 j-auth 가입을 변경하거나 운영 키를 발급하지 않는다. `JGW_TENANT`는 `JGW_GATEWAY_ALLOWED_TENANTS`에 있어야 한다. 다른 tenant·알 수 없는 서비스·중복 서비스·설정 주입·예약 포트 3001을 거부한다. 모든 upstream은 `127.0.0.1`의 고정 포트다. BFF는 인증서를 검증하는 HTTPS, 선택 서비스는 프로파일의 `http` 또는 인증서 검증 `https`를 사용한다. HTTPS upstream 인증서에는 `gw.<tenant>.jgw.test` SAN이 필요하다.

가입한 경우에만 `/ext/customer-auth/`, `/ext/talk/`를 중계하며 URI를 바꾸지 않는다. 미가입 상담 위젯은 같은 고정 주소에서 200·빈 JavaScript·ETag·300초 캐시를 제공한다. `/internal`·`/internal/`은 404다. 그 밖의 경로는 BFF로 간다. 공개 예외는 서비스 자체 인증도 필요하다. gateway가 업무 권한을 대신 판정하지 않는다.

IP는 실제 TCP 상대 주소로 제한한다. 클라이언트의 `X-Forwarded-For`는 덮어쓰며 trusted proxy/real-IP 설정은 추가하지 않았다. `/ext/`의 정상 중계·빈 위젯·없는 경로에 요청/연결 제한을 적용한다. 기본값 10r/s·burst20·동시20, 초과429다. HTTP는 고정 tenant HTTPS 주소로 308, 알 수 없는 host는 404다. TLS1.2/1.3 및 WSS Upgrade를 지원한다. access 로그는 추적 id·상태·시간·바이트만 기록한다. error 로그는 crit 이상으로 제한한다.

## 실행 경계

Node22.18 이상, `@j-auth/contracts` 의존 패키지, `envsubst`·Nginx가 필요하다. env·TLS 파일과 대상 설정 root는 체크아웃 밖의 절대 경로이며 공백·메타문자를 허용하지 않는다. `gateway.env.example`를 **외부 경로**에 복사해 필요한 포트·파일·상태를 채운다. 다음은 인터페이스 예시이며 운영 대상에 자동 실행하지 않는다.

```sh
# 비활성 별도 설정 root에 파일 생성·nginx -t만 실행 (reload 없음)
node deploy/gateway/cli.mjs validate /external/gateway.env /external/nginx-test
# 지정 root의 Nginx가 이미 실행 중일 때만 명시적으로 reload
node deploy/gateway/cli.mjs apply /external/gateway.env /external/nginx
```

설치 전 `validate` 후 최초 master 기동은 설치기가 담당한다. 같은 파일이면 실제 `nginx -t`와 실행 중 세대를 확인하지만 reload하지 않는다. 변경은 root의 `.jgw-gateway.lock`으로 직렬화하고 각 파일을 fsync·rename한다. 검증 실패 시 원본을 복구하고 실행 중 worker는 건드리지 않는다. reload 결과 실패 시 원본 복구→`nginx -t`→이전 설정 reload·세대 확인을 한다. 복구 실패는 `rollback_failed`로 구별하며 성공으로 보고하지 않는다. 오류에 stderr·env·설정 원문을 반환하지 않는다. root와 파일의 symlink는 거부한다. 중단 뒤 남은 lock은 실행 프로세스가 없는지 운영자가 확인한 후에만 제거하며 자동 만료하지 않는다. 설치기는 이 root 변경을 이 도구로 직렬화해야 한다.

signal 명령 exit0만으로 reload 성공을 판정하지 않는다. `/internal`의 직접 404 응답에 설정/템플릿/공개 인증서의 SHA256 세대를 넣고, loopback HTTPS·인증서/SAN 검증·새 연결로 그 세대를 최대5초 확인한다. 내부 API는 공개하지 않는다. 실제 master의 포트 bind 실패도 이전 세대 복구 대상으로 처리한다. 다른 형식의 기존 설정은 이 관찰 계약을 만족하지 않으므로 설치기가 먼저 비활성 root에서 준비해야 한다.

## 격리 시험

```sh
JGW_GATEWAY_TEST_RUNTIME=isolated-cloud npm run test:gateway
```

명시한 opt-in이 없으면 실패하며 skip하지 않는다. 공식 Nginx1.30.5 이미지의 고정 digest를 사용하고, 비특권 uid·read-only container·capability 제거·loopback 임시 포트·일회용 TLS fixture로 실행한다. host Nginx·systemd·방화벽·기존 컨테이너는 변경하지 않는다. 구성 CLI, 실제 envsubst·nginx -t·reload·HTTPS·WSS·429와 복구를 확인한다. BFF·고객 인증·상담 upstream은 프로토콜 fixture이며 실제 서비스 업무 인수와 구별한다. 상세 결과는 [검증 기록](../../docs/cloud-gateway-verification-2026-10-08.md)을 따른다.
