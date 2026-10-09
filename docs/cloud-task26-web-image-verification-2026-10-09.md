# Task26 Web 최종 이미지와 자원 검증

Web 최종 소스 이미지 빌드와 영향 범위 검증을 완료했다. 이미지 `sha256:cd6c616e3ced2d3e475f01cf0a57c8efb7a9ec06e74ed57d308e7659a2c655f1`은 깨끗한 최종 코드 `237bfeb1833f4dc7b27e578dfc01ff8d649bd300`로 재생성해 동일성을 확인했다. 42개 설치 파일 SHA-256과 root 소유권·모드가 일치하고 runtime mount는 없다. [Web 상세 보고](../../j-web/docs/cloud-image-build-verification-2026-10-09.md), [실행 증거 JSON](cloud-task26-web-image-results.json)을 따른다.

Node22.18.0/24.19.0에서 각각 Web check(unit7/helper1·build/type/lint/format), 새 이미지 설치/HTTPS 음성 검사, 실제 hosting5, Web PG/HTTPS15, GWA Web BFF6, 별도 customer-auth19가 통과했다. 최종 실패/skip 0·exit 0이다. 이번 전체196 BFF 재실행은 하지 않았으며 앞선 전체 회귀와 구분한다.

원래 VFS COPY 실패의 로그·build bundle을 보존하고 Dockerfile 파일 설치를 한 RUN으로 합쳤다. 추가 진단에서 gateway ENOSPC와 디스크 0바이트를 확인한 뒤 해당 이전 실패 빌드의 미공유 COPY cache3개만 ID로 지정해 회수했다. 923,455,488바이트를 확보했다. 광범위 prune·이미지/컨테이너/볼륨/소스/사용자 자료 삭제는 없었다. 사전 cache 보존 이동은 하위층 공간을 회수하지 못했으며 실패한 공간 확보 시도로 기록했다. 파일24,342개는 hash/metadata 동일하고 원래 경로가 유지된다.

기존 overlay 이미지의 protocol 파일은 contains/notContains를 검사하지 않았다. Task25 pass 수의 해당 HTTP 내용 검사 범위를 정정한다. 새 이미지에서 공개 연락처·escape·실제 credential 미노출, 두 음성 assertion, 페이지 순회로 exact owned site 집합을 검증했다. 중간 연락처/UUID 정렬/probe query 오류와 gateway ENOSPC는 최종 성공과 분리해 보존했다.

기존 customer-auth 두 번째 child startup의 상세 원인은 미확정이다. 새 gateway ENOSPC는 시작 후의 다른 실패다. 공간 회수 뒤 customer19가 두 driver에서 모두 통과했고, 0.5초 간격 최소 루트 여유는 각각484,392,960/472,842,240바이트였다. 이전 실패·skip을 성공으로 바꾸지 않았다.

Git CLI의 기본 credential 경로가 없는 구간은 환경이 이미 제공한 인증을 해당 child에만 적용해 원격 쓰기를 복구했다. 영구 credential은 만들지 않았다. 신규 기능·VM·운영 배포·회사 노트북·PR/병합은 진행하지 않았다. 진척은130 implemented/34 partial/8 not_started, whole_suite_verified=false다.
