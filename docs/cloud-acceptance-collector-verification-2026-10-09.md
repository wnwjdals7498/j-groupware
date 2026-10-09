# Task 25 고객 VM 인수 준비 도구 검증

실제 Hyper-V VM 8개 인수는 미실행이다. VM 위치에 관한 사용자 답변을 기다리고
있으며 VM 접근·보안 설정 변경 승인은 받지 않았다. 이 변경은 클라우드 소스와
소유한 임시 HTTPS fixture만 사용한다.

`tools/customer-acceptance/`는 AU-51, GW-73, MS-09, ML-32, CA-32, AP-32,
TK-42, WB-33의 명시적 프로필·테스트 항목·운영 O01–O05 증거 형식을 제공한다.
기본 대상 없이 실행하면 네트워크 요청을 하지 않는다. 명시한 hostname과 경로만
읽으며 TLS 검증, timeout, 응답 크기 제한, credential·본문·경로 비노출을 검사한다.
어떤 결과에서도 `acceptance_complete=false`, 인수 항목은 `not_run`이다.

Node 22.18.0과 24.19.0에서 각각 실제 임시 HTTPS fixture를 이용한 11개 시험이
통과했다. 불신 TLS, 연결 불가, 잘못된 프로필, 리다이렉트·3001·credential·경로
거절, 무프로필 요청 없음, 민감 응답 redaction, 응답 상한을 포함한다.

실행 명령은 `node --test tools/customer-acceptance/test/collector.test.mjs`다.
클라우드 로그는 `/workspace/.suite-runtime/j-groupware/`의
`task25-vm-acceptance-final-node22.log/.exit`와
`task25-vm-acceptance-final-node24.log/.exit`이며 두 exit는 0이다.
실제 VM 접속·로그인·업무 흐름·systemd·방화벽·부하·복원은 통과로 기록하지 않는다.
