# T2·E8·H7의 최소 결정 묶음

2026-10-08. 아래 권고는 제안이며 사용자 결정으로 취급하지 않는다. 구현자에게
위임된 고객 인증 C2 계약과 제품 정책 T2는 구분한다. UI 기준 위치는 기존 질의의
응답을 기다리고 있으며 다시 묻지 않는다.

## T2 방문자·손님 전환·WSS

확정된 내용은 256비트 opaque 방문자 token, localStorage 및 HTTP
Authorization 전달, DB hash·회수, tenant/guestId/exp의 HMAC-SHA256 위젯
서명이다. 잘못된 서명은 위젯 오류 없이 익명으로 처리한다. 같은 손님의 기존
활성 대화에는 합류한다. 위젯 새/이전 키의 24시간 겹침, 20건/분·UTF-8 4KB·
활성 방 하나, exact Origin과 plaintext 기준도 기존 명세다. 브라우저 WSS는
임의 Authorization 헤더를 넣을 수 없으므로 전달 계약이 추가로 필요하다.

| 선택 | 제안 | 보안·재방문 영향 |
|---|---|---|
| A 권고 | 방문자 token 24시간 | 탈취 token의 사용 기간을 줄인다. 만료된 익명 방문자는 이전 방을 자동 재개하지 못한다. |
| B | 방문자 token 30일 | 재방문 편의가 늘고 탈취 token의 사용 기간도 길어진다. |

두 선택의 제안 공통 규칙은 만료 시 재발급, 손님 전환 시 새 방문자 token 발급·
이전 token 회수, 이전 대화 이력의 다른 손님 이전 금지다. 동일한 서명 손님은
기존 활성 방에 합류한다. 익명→손님 및 이미 열린 다른 손님 방의 충돌에서는
기존 이력을 서버에 보존하고 새 token에 이전 방 접근권을 주지 않는 방식을
권고한다. WSS에는 HTTP Bearer로 먼저 발급받은 30초 단회 티켓을
`Sec-WebSocket-Protocol`에 전달하고 URL query에는 넣지 않는 방식을 권고한다.
이 수명·전달·회수·재연결 묶음 전체는 선택 전 미정 정책으로 유지한다.
현재 customer-auth 손님 JWT의 300초 만료는 이 방문자 수명 선택을 대신하지 않는다.

## E8 전체 SMTP envelope와 적재 전 알림 누락

확정된 기준은 BCC·여러 RCPT를 포함한 전체 SMTP envelope, 같은 Mailpit
message ID의 수신자 묶음 및 tenant/username별 중복 억제다. 표시 To/Cc나
첫 RCPT/Received로 전체 목록을 복원할 수 없다. PG 적재 후 outbox가 재시도하며
webhook은 적재 후 200을 반환한다. `MP_WEBHOOK_LIMIT=0`을 사용해 burst
제한을 피하고, Mailpit 자체 webhook 재시도를 가정하지 않는다.

| 결정 | 권고 | 대안·영향 |
|---|---|---|
| 전체 envelope 확보 | 신뢰된 capture adapter에 전체 수신자를 보존하고 Mailpit ID와 연결 | Mailpit fork에 전체 수신자/ID 저장을 추가하면 구성 요소는 줄지만 fork 유지보수가 생긴다. |
| webhook/PG 적재 전 누락 | FS-U07 최소 범위를 유지해 적재 전 알림 누락을 허용 | 무손실을 요구하면 durable ingress/reconciliation·복구·중복 관리와 추가 저장소로 범위를 확대해야 한다. |

빠른 응답 형식은 **“capture + 적재 전 누락 허용”**(권고),
**“fork + 적재 전 누락 허용”**, 또는 **“capture + 무손실 범위 확대”**다.
이때 누락은 알림에 관한 것이며 Mailpit에 이미 저장된 원본 메일과 구분한다.
적재 전 누락 허용을 선택해도 적재 후 outbox 재시도 기준은 유지된다.

## H7 수동 업로드와 template 재배포

확정된 내용은 한 페이지 template, HTML escaping, 위젯 항상 포함,
atomic replacement·이전 버전 보존·실패 시 기존 페이지 유지이며 수동
SFTP/FTPS 업로드도 허용된다. 새 배포가 수동 파일을 교체할 범위는 미정이다.

| 선택 | 제안 | 데이터·운영 영향 |
|---|---|---|
| A 권고 | 생성 index.html·로고만 관리하고 다른 수동 파일 보존; 관리 파일의 수동 수정은 충돌로 중단 | 수동 자산을 보존한다. 충돌 시 명시적인 덮어쓰기 선택이 필요하다. |
| B | public root 전체 교체, 이전 버전 backup 보존 | 새 생성물에 없는 수동 파일은 live 경로에서 사라지고 이전 backup에서 복원해야 한다. |

어느 선택이든 privileged helper의 고정 경로·symlink 거부·원자적 교체
검증을 유지해야 한다. 이 제안으로 운영 파일을 교체하거나 삭제하지 않았다.
