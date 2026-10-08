# j-groupware 기능 명세

작성일: 2026-10-08. 상태: **고객 BFF·권한·게시판·회원·조직도 서버 구현, 전체 인수 시험 미완료**. [기능 목록](features.md), [결정](decisions.md), [제품군 명세 기준](suite-feature-specifications.md)을 따른다. 고객 BFF·모든 서비스 화면, control plane 콘솔, 설치·gateway·알림을 담당한다. 실제 실행 범위는 [검증 기록](cloud-bff-verification-2026-10-08.md)에 구별한다.

서버 contracts는 flow 5분, `__Host-jgw-session`/`__Host-jgw-login`, 변경 시 `x-csrf-token`과 정확한 Origin, 목록 50개, 제목 200자·본문 20,000자·전체 body 64 KiB로 고정했다. G23 공통 token exchange·cache·내부 호출 함수는 구현했다([검증](cloud-token-exchange-verification-2026-10-08.md)). 정식 UI·WSS/SSE·제품별 업무 중계는 아직 없다. RP logout은 client_id 기반 Keycloak 확인 화면을 거친다. [개발 안내](server-development.md)를 따른다.

G6 서버 API·원래 Bearer/서비스 키·대상 세션 종료·미배치 저장의 실제 범위는 [회원 BFF 검증](cloud-member-bff-verification-2026-10-08.md)을 따른다. 정식 회원 화면은 미완료다. G15의 부서·직책·소속 편집, 기존 회원 등록·부분 생성 복구, 기본/커스텀 결재선 API는 [조직도 검증 기록](cloud-organization-verification-2026-10-08.md)을 따른다. GW-T07의 실제 j-approval N단계 업무와 조직도 화면은 아직 미완료다.

## 입력·상태·데이터

| 대상 | 최소 계약 |
| --- | --- |
| 로그인 임시 상태 | tenant·state·nonce·PKCE verifier를 서버에 저장한다. callback은 일치·유효성·재사용 여부를 검증하고 사용한 임시 상태를 폐기한다. |
| 회원 세션 | tenant·회원 sub·username·effective roles·access/refresh token·sid·생성/접근/만료 시각. 브라우저에는 보호 쿠키와 UI에 필요한 정보만 준다. |
| 권한 표 | 메뉴·route·필요 role. 인증 callback·공개/내부 경로도 접근 유형을 명시해 선언 없는 route가 생기지 않게 한다. |
| 게시판 | tenant·글 id·작성자·제목·본문·작성 시각. 최초 범위는 목록·작성·조회다. |
| 조직도 | tenant·부서 부모 관계·직책·회원 sub·부서장·미배치. 결재선은 같은 tenant의 등록 계정으로 만든다. |
| 알림 | tenant·service·type·대상·title·body·link·dedupKey·시각, 회원별 읽음. 허용 link는 BFF 화면 경로이며 외부 URL로 임의 이동시키지 않는다. |
| 콘솔 | 고객 tenant·계약 상태·원하는 서비스·인증 반영 결과·설치 보고, 에이전트 키 해시. bootstrap secret 원문은 보관하지 않는다. |

## 사용자 흐름

로그인은 `/auth/login` → Keycloak → `/auth/callback` → 세션 생성 → `/api/me` 순서다. 변경 요청은 세션과 CSRF를 확인한다. 만료 30초 이내 토큰은 세션 행 잠금 아래 한 번 갱신하고 대기한 요청은 새 토큰을 사용한다. 로그아웃·권한 변경·backchannel은 세션과 해당 WSS·SSE를 닫는다.

회원 관리 화면은 grantable-roles를 가져와 쓰기 선택 시 읽기를 잠근다. 새 회원은 조직도 미배치로 등록한다. j-auth 변경 성공 뒤 BFF/조직도 반영이 실패하면 단계별 실패를 표시하고 재시도 전 실제 회원 상태를 조회한다. 비밀값을 자동 재반환하는 회원 생성 재시도는 만들지 않는다.

서비스 화면은 권한 표로 노출하고 BFF가 내부 API·WSS를 중계한다. 상담 손님 이름처럼 필요한 데이터 조합은 BFF에서 수행하며 서비스 DB를 복사하지 않는다. 사이트 배포 성공 뒤 상담 출처 등록 실패는 별도 안내로 표시한다.

## 기능별 계약

| 기능 ID | PMT Item | 입력·정상 동작·출력 | 권한·실패 경계 | 인수 시험 |
| --- | --- | --- | --- | --- |
| GW-01 | G3 | 접속 Host→tenant·realm, state/nonce/PKCE 생성·redirect | 등록 tenant만, 임의 Host·redirect 입력 거절 | GW-T01 |
| GW-02 | G3 | callback code 교환·ID/access 검증→세션 쿠키 | state/nonce 불일치·재사용·검증 실패 시 세션 없음 | GW-T01 |
| GW-03 | G3 | 보호 쿠키·PG 세션·CSRF·idle30분/max8시간 | 토큰 브라우저 비노출, CSRF 없는 변경 거절 | GW-T01 |
| GW-04 | G3 | 만료 임박 요청→행 잠금 갱신→토큰·roles 교체 | 동시 갱신 1회, 거절은 재로그인·장애는 별도 표시 | GW-T02 |
| GW-05 | G3 | 로그아웃→로컬 세션 삭제·RP logout | 재접근 401, 연결 종료 | GW-T02 |
| GW-06 | G3 | logout token의 iss/aud/sid/events→해당 세션 제거 | 무효 서명·대상 sid 불일치가 다른 세션을 지우지 않음 | GW-T02 |
| GW-07 | G3 | GET /api/me→회원·tenant·roles·메뉴 | 쿠키 세션 기준, access/refresh 원문 없음 | GW-T03 |
| GW-08 | G23 | 세션/서비스별 exchange 토큰 캐시→내부 Bearer | 목표 aud 1개·만료/세션 폐기 반영, 장애 시 우회 없음 | GW-T04 |
| GW-10 | G4 | j-auth 카탈로그→route/메뉴 권한 표 | 이름 중복·미선언 route 검사 | GW-T03 |
| GW-11 | G4 | route preHandler→role 검사·업무 처리 | 직접 접근 403, 인증/내부 경로도 접근 유형 선언 | GW-T03 |
| GW-12 | G4 | 같은 표로 사이드바 노출 | 메뉴 숨김과 서버 접근 모두 검사 | GW-T03 |
| GW-13 | G6 | 회원 목록·추가·삭제를 j-auth로 중계 | member:manage·tenant 서비스 키, 자기/관리자 삭제 제한 | GW-T05 |
| GW-14 | G6 | role 체크→부여/회수→effective roles 재조회 | 쓰기 포함 읽기 잠금, direct 읽기 회수 규칙 | GW-T05 |
| GW-15 | G6 | 권한 변경·삭제→대상 BFF 세션/WSS 제거 | 다른 회원 세션 유지, 실패 단계 별도 표시 | GW-T05 |
| GW-20 | G5 | 글 목록·작성·조회→현재 tenant 글 | board:read/write, 권한 없는 쓰기·타 tenant 조회 거절 | GW-T06 |
| GW-21 | G15 | 부서·직책·소속 편집→조직도 | org:manage, 타 tenant 계정 참조·트리 순환 거절 | GW-T07 |
| GW-22 | G15 | 신규 회원→미배치, 기존 회원→관리자 수동 추가 | 같은 회원 중복 등록 방지, 실패 후 실제 상태 확인 | GW-T07 |
| GW-23 | G15 | 작성자 부서장→상위 부서장 순서의 기본 결재선 | 작성자 제외, 빈/중복 후보는 편집·검증 뒤 상신 | GW-T07 |
| GW-30 | G12 | client-react 화면·HTTP/WSS 중계·재연결 | messenger:use, 새 연결은 갱신 토큰, 세션 삭제 종료 | GW-T08 |
| GW-31 | G14 | 메일 목록·상세·HTML sandbox iframe | mail:read, script 실행 금지·타 tenant 404 | GW-T09 |
| GW-32 | G13 | 손님 목록·CRUD 화면→서비스 중계 | guest:read/write, 비밀번호 로그 없음 | GW-T10 |
| GW-33 | G13 | 이름/스코프→키 발급1회·목록·회수 확인 | guest:write, 목록 원문 없음·회수 즉시 반영 | GW-T10 |
| GW-34 | G16 | 결재선 미리보기/편집·상신·결재함·승인/반려 | approval:use+현재 지정자, 사유 필수·충돌 표시 | GW-T07 |
| GW-35 | G19 | 상태별 상담·배정/답장/종료·손님 정보 조합 | talk:read/write; guest:read 없으면 이름 조회 안 함 | GW-T11 |
| GW-36 | G19 | 출처·스니펫·서명 예제·키 발급/교체 화면 | talk:write, 키 원문1회·구분자 서명은 사이트 서버 | GW-T11 |
| GW-37 | G20 | 사이트·DNS·계정·용량·편집/미리보기/배포 | web:read/write, 재설정 비밀번호1회 | GW-T12 |
| GW-38 | G20 | 배포 성공 origin→j-talk 출처 등록 | talk:write·가입 필요, 실패는 별도 안내·배포 유지 | GW-T12 |
| GW-40 | G22 | loopback POST /internal/notifications→검증·저장 | 서비스 키·가입·tenant/type·대상 검사, 외부 노출 없음 | GW-T13 |
| GW-41 | G22 | 등록 type→아이콘/문구/필요 role | 미등록 종류400, 다른 서비스 type 혼용 거절 | GW-T13 |
| GW-42 | G22 | dedup 저장·회원별 읽음·30일 삭제 | tenant/service/사건 경계, 타 회원 읽음과 분리 | GW-T13 |
| GW-43 | G22 | GET /api/notifications/stream SSE→새 알림 | 현재 회원 권한·대상만, 세션 종료 닫힘 | GW-T13 |
| GW-44 | G22 | unread 수·목록·클릭 이동/읽음 | 카운트도 동일 권한 필터, 외부 link 불허 | GW-T13 |
| GW-50 | G7 | operator OIDC→콘솔 BFF 세션 | 고객/하위 회원 콘솔 접근 거절 | GW-T14 |
| GW-51 | G7 | 고객·계약 조회/변경→콘솔 저장 | customer:read/write, 상태값은 콘솔 계약에 고정 | GW-T14 |
| GW-52 | G17 | tenant/관리자→realm 생성→에이전트 키·bootstrap1회 | customer:write, 키 해시만·부분 실패/secret 유실 구별 | GW-T15 |
| GW-53 | G17 | 가입·해지 기록→j-auth 반영·비교·재시도 | 원하는/인증/설치 상태를 하나의 성공으로 합치지 않음 | GW-T15 |
| GW-54 | G21 | desired-state GET·status POST→가입 목록·설치 보고 | 에이전트 Bearer 키의 tenant만, 사용자 세션과 구별 | GW-T15 |
| GW-60 | G11 | tenant/env→Nginx include·TLS·WSS 템플릿 | 치환 변수 제한, nginx -t 후 반영 | GW-T16 |
| GW-61 | G11 | 가입 상태→/ext/customer-auth·/ext/talk 경로 | 내부 API 노출 없음; talk 미가입 위젯200 빈 응답 | GW-T16 |
| GW-62 | G11 | ext 요청→IP별 요청/연결 제한 | 초과429·env 변경, 정상 WSS upgrade 유지 | GW-T16 |
| GW-63 | G18 | 수동 VM에서 bootstrap→기본 설치·env·CA·에이전트 | secret 출력/로그 제한, 실패 상태와 다음 단계 기록 | GW-T17 |
| GW-64 | G18 | provision-service→전용DB·계정·env·unit·경로 | 자기 DB만, 알림 키 서비스별, 반복 실행 중복 방지 | GW-T17 |
| GW-65 | G18 | remove→중지·덤프·NOLOGIN·경로 정리·env 삭제 | nginx 검증 실패 복구; purge는 별도 실행 경계 | GW-T17 |
| GW-66 | G21 | 1분 timer→목표/실제 비교→직렬 설치·해지·보고 | 동일 상태 무변경, 잠금·재시도·오류 보고 | GW-T17 |
| GW-70 | G1 | workspaces·도구·PG·migration·HTTPS/env 골격 | 버전·포트 고정, 3001 금지·비밀 Git 제외 | GW-T18 |
| GW-71 | G2·G9 | UI 토큰/레이아웃→표·폼·모달·빈상태·오류 | packages/ui와 문서 일치·메신저 CSS 변수 일치 | GW-T18 |
| GW-72 | X1 | 공유 contracts/client 게시·정확 버전 설치 | Verdaccio 6.10.5·인증 게시·버전 불변, Compose 실기동은 현재 기기에서 미검증 | GW-T18 |
| GW-73 | G10 | control/customer VM2대→G8·중계·자원 측정 | 인증·설치 선행, VM 실측과 추정 사양 구분 | GW-T19 |

## 인수 시험

| ID | 관찰할 결과 |
| --- | --- |
| GW-T01 | 실제 Keycloak 로그인·callback·쿠키, state/nonce 재사용 거절·CSRF 없는 변경 거절·시간 만료, 브라우저 응답/스토리지에 토큰 원문 없음. |
| GW-T02 | 동시 요청 갱신1회, RP/backchannel·회원 권한 변경의 세션·WSS/SSE 종료, 무효 logout token이 정상 세션을 삭제하지 않음. |
| GW-T03 | role 없는 회원 메뉴 없음·직접403, 권한 부여 후 재로그인 메뉴/route 일치, 미선언 route 검사 실패, me 비밀 비노출. |
| GW-T04 | 서비스별 교환 토큰 aud/role·캐시·만료·세션 무효화, 다른 서비스 aud 사용 거절, 교환 실패를 원래 토큰으로 우회하지 않음. |
| GW-T05 | 회원 추가·역할 포함/회수·삭제, 대상 세션 즉시 무효화, 신규 미배치와 중간 장애의 실제 상태 표시. |
| GW-T06 | 게시판 권한 정상/거절·타 tenant 글 id404, API와 Playwright 화면에서 생성 글 재조회. |
| GW-T07 | 조직도 편집·기본/커스텀 결재선·미배치, 작성자 제외·순환/중복, 실제 서비스 N단계 승인/반려·종결 불변. |
| GW-T08 | 두 회원 실제 메신저 송수신·cursor 복구·로그아웃 종료, 별도 메신저 로그인 화면 없이 BFF 메뉴에서 동작. |
| GW-T09 | SMTP→메일 목록/상세·공유 받은편지함, 다른 tenant404, 공격용 HTML script 미실행. |
| GW-T10 | 손님 CRUD·키 발급/회수·1회 원문 UI, 권한 없는 탭/쓰기 거절, 외부 로그인·조회 키 무효화. |
| GW-T11 | 위젯→상담 목록·WSS·배정/답장/종료, guest 권한 없을 때 이름 요청 없음, 출처/키 관리와 서명 예제 일치. |
| GW-T12 | 사이트 생성→미리보기→배포→HTTPS, 비밀번호1회, talk 미가입/권한 없음/장애 시 배포 성공과 출처 등록 안내 구분. |
| GW-T13 | 같은 사건 재송신1건·서로 다른 사건 각각 저장, 수신 권한·역할·카운트·SSE·회원별 읽음, 30일 경계·키/미등록 type 거절. |
| GW-T14 | op-admin 콘솔 로그인·고객조회/계약변경, customer:read만 있으면 변경 거절, 고객 realm 콘솔 접근 거절. |
| GW-T15 | 신규 tenant bootstrap1회·키 회수/교체 경로, 가입 반영 실패·재시도·실제 상태 비교, 에이전트가 다른 tenant 상태를 읽거나 보고하지 못함. |
| GW-T16 | 실제 Nginx 구성검사·HTTPS/WSS·가입별 예외 경로·내부 API 비노출·요청/연결 제한429·빈 위젯 응답. |
| GW-T17 | 격리 대상 bootstrap·중복 설치·timer 잠금·해지 백업/NOLOGIN, nginx 실패 복구·오류 보고; 다른 서비스 DB/경로 보존. |
| GW-T18 | 골격/migration·정확 패키지 설치, UI 기준과 실제 화면 컴포넌트 비교, 빈/로딩/오류/금지 상태 표시. |
| GW-T19 | VM2대에서 G8·각 서비스 화면·gateway 재검증, 메모리/CPU 실측과 환경·버전·한계 기록. |

## 확정 관문

각 화면 route·중계 path·DTO·필드 길이·페이지 규칙은 G1·G3 및 서비스 contracts를 연결할 때 고정한다. 세션 쿠키/CSRF 이름과 callback 임시 상태 수명, 조직도 삭제 제약·결재 후보 중복 처리, 계약 상태값·에이전트 키 교체, 알림 대상·사건 키와 제한 단위는 [공통 미정 표](suite-feature-specifications.md)의 해당 관문에서 확정한다. 모바일 셸·고객 VM 생성 자동화·사양 자동화는 추가하지 않는다.
