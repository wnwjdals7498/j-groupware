# 남은 기능 감사 — 2026-10-09

기존 명세/결정과 실제 소스·실행 증거 대조. 각 기능의 첫 미완료 단계 기준이며 구현 완료·제품 인수 완료를 뜻하지 않는다. 기술 계약과 선행 서비스는 구현자가 계속할 수 있는 작업이며 사용자/외부 환경 차단으로 취급하지 않는다.

현재 소스 기준: 구현 130, 부분 34, 미착수 8 / 총 172. 남은 42개. 전체 인수: 미완료.

25차 초기 미착수22 중 소스14 구현·Node22/24 실제 검증을 마쳤다. 현재130/34/8, 남은42. 기존 partial34는 범위 대조 전 보수적으로 유지했다. 공통 UI·T2 visitor·E8 capture·H7 보존 배포 소스 관문은 해소됐다. 실제 VM8은 위치·승인 대기/미실행이며 whole_suite_verified=false다.

[Task25 구현·실행 증거](cloud-source-fourteen-verification-2026-10-09.md). 실제 VM 준비 도구와 실제 VM 인수는 구분한다.

| 분류 | 남은 수 |
| --- | ---: |
| 계속 가능한 소스·명세 검증 | 11 |
| 기술 계약 확정 선행 | 0 |
| 서비스 구현 선행 | 0 |
| 정식 UI·브라우저 인수 | 16 |
| 제품 정책 결정 필요 | 1 |
| 외부 VM 인수 | 14 |
| 현재 최소 범위 제외 | 0 |

| ID | 서비스 | 기능 | 분류 | 현재 소스 | 다음 단계 |
| --- | --- | --- | --- | --- | --- |
| AU-02 | j-auth | 고객 realm 템플릿 | 정식 UI·브라우저 인수 | partial | 공통 UI 기준으로 theme를 적용하고 실제 OIDC 브라우저 흐름을 검증한다. |
| AU-05 | j-auth | OIDC 로그인 | 정식 UI·브라우저 인수 | partial | 공통 UI 기준에 따라 로그인 화면과 실제 브라우저 제한 시험을 연결한다. |
| AU-51 | j-auth | VM 검증·측정 | 외부 VM 인수 | not_started | 사용자가 지정·승인한 격리 VM에서 명세별 실제 인수를 실행한다. |
| GW-12 | j-groupware | 메뉴 숨김 | 정식 UI·브라우저 인수 | partial | UI 기준에 맞춰 필터된 메뉴만 표시하고 탐색을 시험한다. |
| GW-13 | j-groupware | 회원 목록·추가·삭제 | 정식 UI·브라우저 인수 | partial | 기존 회원 BFF 계약으로 화면과 브라우저 시나리오를 구현한다. |
| GW-14 | j-groupware | 권한 부여·회수 화면 | 정식 UI·브라우저 인수 | partial | UI 기준에 맞춰 기존 권한 계약을 화면에 연결한다. |
| GW-20 | j-groupware | 게시판 | 정식 UI·브라우저 인수 | partial | 기존 게시판 API의 정식 화면을 구현한다. |
| GW-21 | j-groupware | 조직도 편집 | 정식 UI·브라우저 인수 | partial | 기존 조직도 API로 편집 화면과 충돌 안내를 구현한다. |
| GW-30 | j-groupware | 메신저 화면 | 정식 UI·브라우저 인수 | partial | 설치된 공개 client 패키지로 정식 메신저 화면을 연결한다. |
| GW-31 | j-groupware | 메일 화면 | 정식 UI·브라우저 인수 | partial | 기존 read 계약으로 화면·sandbox·Playwright를 구현한다. |
| GW-32 | j-groupware | 손님 관리 화면 | 정식 UI·브라우저 인수 | partial | 공통 UI 기준에 따라 손님/키 화면과 Playwright 인수를 구현한다. |
| GW-33 | j-groupware | API 키 화면 | 정식 UI·브라우저 인수 | partial | 공통 UI 기준에 따라 손님/키 화면과 Playwright 인수를 구현한다. |
| GW-34 | j-groupware | 결재 화면 | 정식 UI·브라우저 인수 | partial | 기존 결재 계약으로 상신·승인·반려 화면을 구현한다. |
| GW-35 | j-groupware | 상담 화면 | 정식 UI·브라우저 인수 | partial | 공통 UI 기준과 실제 backend를 사용해 정식 업무 화면·브라우저 업무 인수를 구현한다. |
| GW-36 | j-groupware | 상담 설정 | 정식 UI·브라우저 인수 | partial | 공통 UI 기준에 따라 상담 설정 화면을 연결하고 확정된 visitor 서명 계약을 예제로 제공한다. |
| GW-37 | j-groupware | 웹 관리 화면 | 정식 UI·브라우저 인수 | partial | 공통 UI 기준과 실제 backend를 사용해 정식 업무 화면·브라우저 업무 인수를 구현한다. |
| GW-40 | j-groupware | 알림 수신 API | 제품 정책 결정 필요 | partial | 운영 owner/갱신·key 회전·배치/전달 책임 확정 뒤 고정 CLI/실제 고객 설치와 연결한다. 새 영구 자격·grant·timer를 임의 도입하지 않는다. |
| GW-44 | j-groupware | 알림 화면 | 정식 UI·브라우저 인수 | partial | 정식 UI와 기존 알림 계약을 연결한다. |
| GW-63 | j-groupware | 부트스트랩 | 외부 VM 인수 | partial | 신뢰한 실제 offline package와 dependency closure·기존 private 입력을 준비해 승인된 고객 VM에서 첫 bootstrap/CA trust/PG Compose/전체 인수를 실행한다. |
| GW-64 | j-groupware | 서비스 설치 | 외부 VM 인수 | partial | 승인된 고객 VM의 기존 준비 입력으로 전체 native 설치·중지/재시도·gateway/방화벽 traffic 인수를 실행한다. 운영 알림 owner·SMTP capture 입력·실제 배포 인수는 별도다. |
| GW-65 | j-groupware | 서비스 해지 | 외부 VM 인수 | partial | 고객 VM에서 native 제품 전체 해지·실패/retry·PG/files/backup 보존과 gateway/account/env 순서 인수를 실행한다. 자동 purge는 하지 않는다. |
| GW-66 | j-groupware | 프로비저닝 에이전트 | 외부 VM 인수 | partial | 고객 VM에서 기존 준비 입력의 agent control/unit·실제 installer 호출·timer 실행과 실패/retry를 인수한다. 알림 refresh owner/회전/topology는 임의 지정하지 않는다. |
| GW-73 | j-groupware | VM 검증·측정 | 외부 VM 인수 | not_started | 사용자가 지정·승인한 격리 VM에서 명세별 실제 인수를 실행한다. |
| MS-09 | j-messenger | 고객 서버 검증 | 외부 VM 인수 | not_started | 사용자가 지정·승인한 격리 VM에서 명세별 실제 인수를 실행한다. |
| ML-03 | j-mail | 외부 발신 차단 | 외부 VM 인수 | partial | 지정 VM의 실제 방화벽으로 외부 발신 차단을 확인한다. |
| ML-30 | j-mail | 저장소 골격·DB | 외부 VM 인수 | partial | 승인된 고객 VM과 명시적 운영 SMTP 입력으로 설치·binding·전체 인수를 실행한다. |
| ML-32 | j-mail | 고객 서버 검증 | 외부 VM 인수 | not_started | 사용자가 지정·승인한 격리 VM에서 명세별 실제 인수를 실행한다. |
| CA-32 | j-customer-auth-db | 고객 서버 검증 | 외부 VM 인수 | not_started | 사용자가 지정·승인한 격리 VM에서 명세별 실제 인수를 실행한다. |
| AP-32 | j-approval | 고객 서버 검증 | 외부 VM 인수 | not_started | 사용자가 지정·승인한 격리 VM에서 명세별 실제 인수를 실행한다. |
| TK-02 | j-talk | FAB·대화창 | 계속 가능한 소스·명세 검증 | partial | 새 정책 답변 없이 Task25 실제 증거를 기능별 전체 명세와 대조하고 남은 인수 범위·완료 판정을 정리한다. |
| TK-03 | j-talk | 표시 조건 | 계속 가능한 소스·명세 검증 | partial | 새 정책 답변 없이 Task25 실제 증거를 기능별 전체 명세와 대조하고 남은 인수 범위·완료 판정을 정리한다. |
| TK-13 | j-talk | 출처 검사 | 계속 가능한 소스·명세 검증 | partial | 새 정책 답변 없이 Task25 실제 증거를 기능별 전체 명세와 대조하고 남은 인수 범위·완료 판정을 정리한다. |
| TK-14 | j-talk | 남용 제한 | 계속 가능한 소스·명세 검증 | partial | 새 정책 답변 없이 Task25 실제 증거를 기능별 전체 명세와 대조하고 남은 인수 범위·완료 판정을 정리한다. |
| TK-22 | j-talk | 답장 | 계속 가능한 소스·명세 검증 | partial | 새 정책 답변 없이 Task25 실제 증거를 기능별 전체 명세와 대조하고 남은 인수 범위·완료 판정을 정리한다. |
| TK-23 | j-talk | 종료 | 계속 가능한 소스·명세 검증 | partial | 새 정책 답변 없이 Task25 실제 증거를 기능별 전체 명세와 대조하고 남은 인수 범위·완료 판정을 정리한다. |
| TK-24 | j-talk | 실시간 전달 | 계속 가능한 소스·명세 검증 | partial | 새 정책 답변 없이 Task25 실제 증거를 기능별 전체 명세와 대조하고 남은 인수 범위·완료 판정을 정리한다. |
| TK-27 | j-talk | 인증·tenant 격리 | 계속 가능한 소스·명세 검증 | partial | 새 정책 답변 없이 Task25 실제 증거를 기능별 전체 명세와 대조하고 남은 인수 범위·완료 판정을 정리한다. |
| TK-41 | j-talk | contracts | 계속 가능한 소스·명세 검증 | partial | 새 정책 답변 없이 Task25 실제 증거를 기능별 전체 명세와 대조하고 남은 인수 범위·완료 판정을 정리한다. |
| TK-42 | j-talk | 고객 서버 검증 | 외부 VM 인수 | not_started | 사용자가 지정·승인한 격리 VM에서 명세별 실제 인수를 실행한다. |
| WB-13 | j-web | 위젯 스니펫 삽입 | 계속 가능한 소스·명세 검증 | partial | 새 정책 답변 없이 Task25 실제 증거를 기능별 전체 명세와 대조하고 남은 인수 범위·완료 판정을 정리한다. |
| WB-31 | j-web | contracts | 계속 가능한 소스·명세 검증 | partial | 새 정책 답변 없이 Task25 실제 증거를 기능별 전체 명세와 대조하고 남은 인수 범위·완료 판정을 정리한다. |
| WB-33 | j-web | 고객 서버 검증 | 외부 VM 인수 | not_started | 사용자가 지정·승인한 격리 VM에서 명세별 실제 인수를 실행한다. |

## 실제 미실행 경계

- Actual Hyper-V VM acceptance AU-51/GW-73/MS-09/ML-32/CA-32/AP-32/TK-42/WB-33 is not_run; VM location and explicit execution approval pending. No VM or OS security changes authorized.
- Customer VM/20GB disk/systemd PID1/trusted offline OS packages/CA trust/firewall/native lifecycle/timer/external access acceptance remains unexecuted. Cloud fixtures and collector preparation are separate.
- Operating notification refresh credential owner, service-key rotation responsibility and control-plane/customer projection/private receiver topology remain unresolved; no permanent credentials, grants or operating timer created.
- Shared UI baseline and initial 14 source targets are implemented. Formal business screens and full specification acceptance for existing partial features remain; bounded component passes do not complete the whole suite.

VM 8개는 AU-51·GW-73·MS-09·ML-32·CA-32·AP-32·TK-42·WB-33이다. 환경 위치와 실행 승인 대기이며 보안 설정 변경을 승인으로 간주하지 않는다.

T2는 30분 hash-only credential·유효 회전·5초 첫 WSS frame·5분 signed cursor로 구현했다. E8은 전체 RCPT capture와 FS-U07의 webhook 이전 누락 경계를 유지했다. H7은 수동 index 충돌 거절과 다른 파일 보존, 원자 배포·journal 복구로 구현했다. 운영 activation은 별도다.
