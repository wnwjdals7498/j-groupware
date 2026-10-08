# WSL Docker 준비 도구

**현재 회사 노트북에서는 시스템 설치·Docker 기동이 금지되어 있습니다. `-Apply`를 실행하지 않습니다.** 이 도구의 설치 경로는 설치가 허용된 별도 개발 환경용이며, 현재 기기에서는 구문·읽기 전용 준비안까지만 검증했습니다.

`j-groupware` 디렉터리에서 Windows PowerShell로 실행합니다.

```powershell
.\tools\runtime\bootstrap-wsl-docker.ps1
```

기본 실행은 이미 실행 중인 WSL 2 Ubuntu의 버전과 아키텍처를 확인하고 설치 계획을 출력합니다. 현재 WSL 사용자로 읽기만 하며, 중지된 배포판을 시작하지 않습니다.

```powershell
.\tools\runtime\bootstrap-wsl-docker.ps1 -Apply
```

`-Apply`는 `wsl --user root`로 실행해 sudo 암호 입력을 요구하지 않습니다. Docker 공식 apt 키와 저장소를 추가하고 패키지 목록을 갱신한 뒤 Engine과 Compose를 설치하고 서비스를 시작해 실제 버전을 확인합니다. 부분 설치, 충돌 패키지, 기존 Docker 데이터나 키·저장소 파일이 있으면 덮지 않고 중단합니다.

도구가 방화벽이나 `/etc/wsl.conf`를 직접 편집하지는 않습니다. 패키지 설치나 Docker 서비스 시작 과정에서 Docker가 네트워크·iptables 상태를 만들거나 변경할 수 있습니다.

절차와 지원 Ubuntu 버전·아키텍처는 [Docker 공식 안내](https://docs.docker.com/engine/install/ubuntu/)를 따릅니다.
