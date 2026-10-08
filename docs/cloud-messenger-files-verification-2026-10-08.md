# 메신저 첨부 BFF·보존·PG 복구 후속 — 2026-10-08

상태: **첨부 backend/BFF 연결 구현·실제 통합 검증 완료; 정식 UI·운영 설치·VM 인수 미완료**. 메신저 복구 구현 커밋은 [`ff154702a53d2e9359e549d51a6dff16b79d1319`](https://github.com/wnwjdals7498/j-messenger/commit/ff154702a53d2e9359e549d51a6dff16b79d1319)다. 기존 172개 추적표는 코드 구현66·부분19·미착수87을 유지한다. GW-30은 정식 화면이 없어 partial이며 `whole_suite_verified=false`다. [남은 106개 전수 분류](cloud-remaining-feature-audit-2026-10-08.md)와 [메신저 PG 복구 기록](../../j-messenger/docs/cloud-postgres-recovery-verification-2026-10-08.md)을 함께 읽는다.

## 구현과 실제 동작

`POST /api/messenger/api/v1/conversations/:id/files`, `GET /api/messenger/api/v1/files/:id/content`를 명시적 `messenger:use` 경로로 추가했다. 기존 세션·tenant·Origin/CSRF·단일 audience 토큰 검증 뒤 고정 loopback backend만 호출한다. 파일 ID를 메시지에 연결할 수 있고 `/me`는 실제 backend 파일 capability를 투영한다. 보존/native 관리 API는 추가하지 않았다.

업로드는 정확히 한 `file` part, 5,000,000 bytes, wire 전체5,065,536 bytes, 30초 상한이다. 추가 field/part·잘못된 filename·쿼리 tenant 입력은 거절한다. 업로드를 비공개 임시 디렉터리0700/파일0600에 제한해 받고 전체 multipart를 검사한 뒤 서버가 다시 만든 multipart만 backend에 전송한다. 성공 응답 전에 임시 파일을 제거한다. filename·본문·쿠키·외부 Bearer·tenant·URL을 로그나 downstream credential로 넘기지 않는다. 원래 backend 파일 정책·quota는 그대로 적용한다.

다운로드는 참여·tenant를 backend가 검증하며 최대5MB stream을 전달한다. 검증한 filename으로 `Content-Disposition: attachment`, `application/octet-stream`, `nosniff`, `no-store`를 생성한다. backend 쿠키/실행 MIME은 전달하지 않는다. 잘못된 header·초과/불일치 길이는 실패한다. 이미 stream header를 전송한 뒤 오류는 연결을 종료하며 정상 완료로 기록하지 않는다.

Gateway의 기본1MiB 제한으로 정상5MB 첨부가 막히므로 정확한 첨부 업로드 경로에만5,065,536 bytes와 request buffering off를 적용했다. 다른 API는 기존1MiB 제한을 유지한다. 실제 Nginx는 정상 첨부 wire를 전달하고 초과·다른 API 대용량은413으로 거절했다. 신규 `@fastify/multipart@10.1.2`는 메신저 서버가 이미 쓰던 고정 버전이고 `@j-messenger/contracts@0.2.0`은 기존 불변 registry 패키지를 정확히 설치했다. package/lock을 함께 갱신했다. [공식 multipart 문서](https://github.com/fastify/fastify-multipart)는 stream·file size/part 제한 근거다. multipart는 Fastify 일반 body limit만으로 전체 wire 크기를 제한하지 않으므로 별도 카운터도 둔다.

## 실행 증거

| 실행                                                  | 결과·범위                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| Node24.19 `npm run check`                             | build/typecheck/lint/format, 단위74/74, exit0                                  |
| Node24 actual Keycloak·PG·BFF 전체                    | 125/125, 실패·skip0, exit0                                                     |
| Node24 메신저 집중                                    | 17/17, 실패·skip0, exit0                                                       |
| Node22.18 메신저 집중(첨부 본문·filename 비로그 포함) | 17/17, 실패·skip0, exit0                                                       |
| actual Nginx1.30.5 Gateway Node24·22                  | 각각14/14, 실패·cancel·skip0, exit0                                            |
| 메신저 전체 check                                     | contracts10/core17/React13/server94/web4/deploy11, build/type/lint/format 통과 |
| 메신저 actual PG18.6 전체 Node22·24                   | 각각21/21, 실제 shard·owner download·rollback, 실패·skip0, exit0               |

공개 registry client를 통해 작은 한글 첨부를 업로드하고 실제 byte 일치를 확인했다. 미연결 파일404, 연결201/동일 재시도200/내용 변경409, 다른 참여자 다운로드200, 다른 tenant404, 권한 없음403, CSRF 없음403, 추가 tenant/part 거절, 정확히5MB201/5MB+1byte413 및 거절 시 파일 행 무변경을 검증했다. 6일 전 메시지 본문은 만료되지만 14일 미만 첨부는 유지되고, 15일 전 첨부는 접근404·삭제 job 처리되는 것을 실제 PG/BFF로 확인했다. 마지막 로그 검사는 토큰·자격 증명뿐 아니라 파일 본문과 filename도 검사한다.

최초 단위 시험은 Fastify multipart가 raw stream을 읽는데 preParsing pipe가 먼저 소비해400이 발생했고, 이후 성공 응답보다 임시 cleanup이 늦는 경합이 드러났다. raw wire 카운터와 응답 전 cleanup으로 수정했다. 실제 집중 첫 실행은 기존 미존재 file ID가 이제 backend404라는 계약 변화와 Node 내장 FormData/고정 undici의 brand 차이로 실패했다. 응답 기대를 실제 의미에 맞추고 test transport에서 FormData를 같은 undici 형식으로 변환해 실제 HTTP bytes로 재실행했다. Gateway 첫 회귀의1건 실패는 fixture GET 응답에 불필요한 bytes 필드가 추가된 것으로, POST에만 byte 관찰을 적용해 수정했다. 이 실패들을 통과로 처리하지 않는다.

외부 증거는 `/workspace/.suite-runtime/j-groupware/messenger-files-{check,full,node22,gateway,gateway-node22}.log`와 `messenger-files-{full,node22}-results.json`이다. private env·키·npm 자격 증명은 체크아웃 밖에 두었다. 기존 DB/realm·사용자 변경·standalone 앱은 보존했다. 승인된 작업 브랜치 커밋·푸시만 수행하며 PR·main 병합·운영 설치·배포는 실행하지 않는다. 운영 서비스 차단·재시작 연결, 고객 VM·정식 화면/Playwright·부하·외부 백업은 미실행이다.
