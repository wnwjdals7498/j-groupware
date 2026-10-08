# 봉인 자격 기반 one-shot 에이전트·권한별 상담 손님 이름

2026-10-08. 저장된 클라우드 체크아웃과
`codex/cloud-auth-foundation-20261008` 브랜치에서 진행했다.
회사 노트북에 설치하지 않았고 기존 작업을 보존했다.
구현 검증과 고객 OS/전체 제품군 인수를 구분한다.

## 구현과 소스 커밋

- groupware [a1e875006117aa7feffd2dea72d07d5d7535db55](https://github.com/wnwjdals7498/j-groupware/commit/a1e875006117aa7feffd2dea72d07d5d7535db55):
  명시적 `--config /external/agent.json --once` 진입점을 추가했다.
  private control의 정확한 키·외부 경로를 검증하고 기존 봉인 bootstrap의
  tenant/콘솔 origin/agent key/CA를 사용한다. 자격 override는 거부한다.
  tenant lock, actual desired/inventory, 고정 설치/해지 argv, 실제 TLS 준비
  상태와 accepted console report를 연결한다. 동기화와 보고 승인 모두 참일
  때만 exit0이며 busy·관찰 실패·보고 실패는 exit1이다. import/생성은 inert다.
  기본 cold 번들에도 포함한다. [인터페이스](../deploy/agent/provision-agent.md)를 따른다.
- Talk [41f84030119d8deaa7eff94079f95da1a4a7d23b](https://github.com/wnwjdals7498/j-talk/commit/41f84030119d8deaa7eff94079f95da1a4a7d23b):
  문의방 목록도 상세처럼 같은 tenant의 visitor 연결에서 `guestId`를
  반환한다. customer-auth를 Talk에서 호출하지 않는다. 기존 게시된
  contracts 0.1.0의 바이트를 변경하거나 재게시하지 않았다.
- groupware [8525b5804fe6aa5ffff3d438612a1b0353c3af1d](https://github.com/wnwjdals7498/j-groupware/commit/8525b5804fe6aa5ffff3d438612a1b0353c3af1d):
  `guest:read` 회원에게만 기존 customer-auth UUID 조회와 단일 aud Bearer로
  `guestName`을 조합한다. 권한이 없으면 조회·token exchange·이름 필드가
  없다. 익명/삭제/다른 tenant 손님은 이름 null, 장애·무효 UUID·응답 ID
  불일치는 503이다. 이름 외 contact/login/hash는 조합 응답에 전달하지 않는다.
  페이지의 중복 UUID를 합치고 동시 조회 4개·전체 10초로 제한하며 실패 시
  다른 요청을 취소하고 모두 settle한 뒤 반환한다.

## 실제 실행

| 검사 | Node22.18 | Node24.19 | 범위 |
| --- | ---: | ---: | --- |
| 콘솔·one-shot agent 연결 | 18 pass·exit0 | 18 pass·exit0 | 실제 CLI/콘솔/PG/Talk/TLS, 봉인 자격·busy·재시도·실패 보고 |
| customer-auth·Talk 연결 | 19 pass·exit0 | 19 pass·exit0 | 실제 auth/PG/서비스, 이름 조합 3개와 기존 BFF/cold CA/Nginx/JWT 검증 |
| 전체 BFF 최종 회귀 | 179 pass·exit0 | 179 pass·exit0 | 13개 파일·skip0, 최종 로그와 실제 종료 코드를 함께 기록 |
| agent core | 20 pass·exit0 | 20 pass·exit0 | 준비·재조정·잠금·멱등·취소·안전한 실패 |
| 기본/Talk cold unpack | 19 pass·exit0 | 19 pass·exit0 | skip0, 새 에이전트 모듈의 실제 fresh 설치 후 inert import 포함 |
| groupware check | 77 pass·exit0 | 77 pass·exit0 | build/type/unit/lint/format |
| groupware 단위 검사 | 77 pass·exit0 | 77 pass·exit0 | 위 check에 포함, bounded lookup/cancellation |
| Talk check | 1 pass·exit0 | 1 pass·exit0 | build/type/lint/format 포함 |

정적 문서 검증도 exit0이다. 기능172·인수 시험 **정의**60·제품군 시험
정의9·local links139를 대조했으며 기능 인수 시험을 실행한 수가 아니다.
Talk의 상태 선언 교정은 [50053a91bbf49d36b75037ca6e50a5d9ebb3a654](https://github.com/wnwjdals7498/j-talk/commit/50053a91bbf49d36b75037ca6e50a5d9ebb3a654)로
커밋·푸시하고 원격 SHA를 확인했다.

집중 검사는 전체 회귀에 포함돼 있으므로 합산하지 않는다. 문의방은 실제
전용 Talk DB의 fixture로 준비했고 방문자 발급이나 live visitor 전달로
취급하지 않는다. console fixture의 설치기는 소유한 임시 파일에 고정 argv와
state를 기록하고 소유한 Talk 프로세스만 시작/정지한다. 실제 콘솔·서비스·PG·
TLS·accepted report는 검증했지만 native OS 설치기로 고객을 설치한 것은 아니다.

## 실패·미실행 경계

에이전트 첫 CLI 실행은 fixture가 콘솔 CA 대신 BFF CA를 봉인해
`desired_unavailable`로 실패했다. 실제 콘솔 CA를 입력한 뒤 통과했으며 TLS
검증을 끄지 않았다. 다음 실패는 이전 negative test의 일반 문자열
`invalid`를 비밀값으로 등록한 검사기가 안전한 `invalid_agent_control` 코드와
충돌한 false positive였다. CLI가 실제 읽는 발급 자격과 Talk DB/알림 비밀값을
대상으로 노출 검사를 하고, 잘못된 control의 정확한 안전 오류 코드도 확인했다.
세 실패 실행의 로그/exit1을 보존하고 성공으로 합산하지 않는다.
이전 묶음의 환경 재연결로 종료 코드를 조회하지 못했던 Node24 회귀와
구분해 이번에는 두 Node의 전체179와 실제 `.exit=0`을 모두 확인했다.
이전 receiver startup 초기 실패의 원인은 여전히 미확정이며 이번 통과가
그 원인을 해결했다는 의미는 아니다.
문서 검사의 첫 실행은 Talk 명세의 상태 문구가 고정 상태 선언을 빠뜨려
실패했다. 명세에 정확한 전체 인수 미완료 선언을 복원했으며 검사기를
완화하지 않았다. 최초 실패 보고서도 별도 보존했다.

완전한 native bootstrap/installer 조합, Messenger/Mailpit 저장소 준비·정리와
운영 notification 자격 갱신/토폴로지는 남은 독립 기술 작업이다. 제거 시
DB role NOLOGIN 이전의 일관된 파일/DB 백업과 소유권 검증을 연결해야 하며
파일 보존을 백업 완료로 취급하지 않는다. T2·E8·H7과 정식 UI 질의는 답변
대기이며 정책을 임의 채택하지 않았다. 운영 자격 발급/갱신, timer 활성화,
외부 메일/SMS 송신, 고객 VM·20GB 디스크·실제 systemd PID1·OS CA trust·
정식 UI/Playwright·전체 인수는 미실행이다. root/account/CA/TLS OS 시험은
이번 묶음에서 추가 실행하지 않았고 과거 격리 컨테이너 증거와 구분한다.

## 재현 증거와 진행 상태

로그는 `/workspace/.suite-runtime/j-groupware/`의
`agent-entry-console-node{22,24}-final.log`와 대응 `.exit`,
`guest-names-customer-node{22,24}.log`와 대응 `.exit`,
`agent-names-full-bff-node{22,24}-final.log`와 대응 `.exit`,
`agent-names-core-node{22,24}.log`와 대응 `.exit`,
`agent-names-unpack-node{22,24}-final.log`와 대응 `.exit`,
`agent-names-check-node{22,24}-final.log`와 대응 `.exit`,
`guest-names-talk-check-node{22,24}.log`와 대응 `.exit`,
`guest-names-unit-node{22,24}.log`,
`guest-names-{types,lint,format}-final.log`에 있다.
정적 검증은 `agent-names-doc-validation-final.json`과 대응 log/exit0,
첫 상태 표기 실패는 `agent-names-doc-validation-status-failed.{json,log}`에 있다.
실패 로그는 `agent-entry-console-node22.log`, `-attempt2.log`, `-attempt3.log`다.

소스 상태는 구현109·부분32·미착수31/총172, 남은63이다.
GW-35·GW-63/64/65/66과 `whole_suite_verified=false`를 유지한다.
검증된 소스 묶음은 각각 커밋·푸시 후 `ls-remote`와 GitHub exact SHA 조회로
확인했다. PR 게시·main 병합·배포는 수행하지 않았다.
