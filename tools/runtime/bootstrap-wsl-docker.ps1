[CmdletBinding()]
param(
    [string]$Distribution = 'Ubuntu',
    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:OfficialDocs = 'https://docs.docker.com/engine/install/ubuntu/'
$script:OfficialKey = 'https://download.docker.com/linux/ubuntu/gpg'
$script:EnginePackages = @(
    'docker-ce',
    'docker-ce-cli',
    'containerd.io',
    'docker-buildx-plugin',
    'docker-compose-plugin'
)
$script:ConflictingPackages = @(
    'docker.io',
    'docker-compose',
    'docker-compose-v2',
    'docker-doc',
    'docker-buildx',
    'podman-docker',
    'containerd',
    'runc'
)

function Invoke-WslBash {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [switch]$StreamOutput,
        [switch]$RunAsRoot
    )

    $wslArguments = @('--distribution', $Distribution)
    if ($RunAsRoot) {
        $wslArguments += @('--user', 'root')
    }
    $wslArguments += @('--exec', 'bash', '--noprofile', '--norc', '-c', $Command)

    if ($StreamOutput) {
        & wsl.exe @wslArguments
        $nativeExitCode = $LASTEXITCODE
        if ($nativeExitCode -ne 0) {
            throw "WSL command failed with exit code $nativeExitCode."
        }
        return
    }

    $output = @(& wsl.exe @wslArguments 2>&1)
    $nativeExitCode = $LASTEXITCODE
    if ($nativeExitCode -ne 0) {
        throw "WSL preflight command failed with exit code $nativeExitCode."
    }
    return $output
}

function Get-ProbeValues {
    param([string[]]$Lines)

    $values = @{}
    foreach ($line in $Lines) {
        $normalizedLine = ([string]$line).Replace([string][char]0, '').Replace([string][char]0xFEFF, '').Trim()
        if ($normalizedLine -match '^(?<name>[A-Z_]+)=(?<value>.*)$') {
            $values[$matches['name']] = $matches['value']
        }
    }
    return $values
}

function Get-PackageNames {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -eq 'none') {
        return @()
    }
    return @($Value.Split(',') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Start-DockerService {
    param([string]$SystemdAvailable)

    if ($SystemdAvailable -eq 'yes') {
        Invoke-WslBash -Command 'set -e; systemctl start docker' -StreamOutput -RunAsRoot
    }
    else {
        Invoke-WslBash -Command 'set -e; command -v service >/dev/null 2>&1; service docker start' -StreamOutput -RunAsRoot
    }
}

function Test-DockerVersions {
    $verifyScript = @'
set -euo pipefail
client="$(docker --context default version --format '{{.Client.Version}}')"
server="$(docker --context default version --format '{{.Server.Version}}')"
compose="$(docker --context default compose version --short)"
test -n "$client"
test -n "$server"
test -n "$compose"
printf 'Docker client: %s\nDocker server: %s\nDocker Compose: %s\n' "$client" "$server" "$compose"
'@
    Invoke-WslBash -Command $verifyScript -StreamOutput -RunAsRoot
}

if ([string]::IsNullOrWhiteSpace($Distribution) -or $Distribution -notmatch '^[A-Za-z0-9._-]+$') {
    throw 'Distribution must be a simple WSL distribution name.'
}

$wslListingLines = @(& wsl.exe --list --verbose 2>&1)
$wslListingExitCode = $LASTEXITCODE
if ($wslListingExitCode -ne 0) {
    throw "Could not read the WSL distribution list (exit code $wslListingExitCode)."
}
$wslListing = (@($wslListingLines | ForEach-Object {
    ([string]$_).Replace([string][char]0, '').Replace([string][char]0xFEFF, '')
})) -join "`n"
$distributionPattern = '(?im)^\s*\*?\s*' + [regex]::Escape($Distribution) + '\s+(?<state>Running|Stopped)\s+(?<version>\d+)\s*$'
$distributionMatch = [regex]::Match($wslListing, $distributionPattern)
if (-not $distributionMatch.Success) {
    throw "WSL distribution '$Distribution' is not registered or its state could not be read. No changes were made."
}
if ($distributionMatch.Groups['state'].Value -ne 'Running') {
    throw "WSL distribution '$Distribution' is stopped. Start it explicitly, then rerun this read-only preflight."
}
if ($distributionMatch.Groups['version'].Value -ne '2') {
    throw "WSL distribution '$Distribution' is not WSL 2. Docker Engine installation is supported here only for WSL 2."
}

$probeScript = @'
set -euo pipefail
. /etc/os-release
version_codename="${VERSION_CODENAME:-}"
ubuntu_codename="${UBUNTU_CODENAME:-}"
apt_codename="${ubuntu_codename:-$version_codename}"
architecture="$(dpkg --print-architecture)"
printf 'ID=%s\n' "${ID:-}"
printf 'VERSION_CODENAME=%s\n' "$version_codename"
printf 'APT_CODENAME=%s\n' "$apt_codename"
printf 'ARCHITECTURE=%s\n' "$architecture"
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    printf 'SYSTEMD_AVAILABLE=yes\n'
    service_state="$(systemctl is-active docker 2>/dev/null || true)"
    printf 'DOCKER_SERVICE=%s\n' "${service_state:-unknown}"
else
    printf 'SYSTEMD_AVAILABLE=no\n'
    printf 'DOCKER_SERVICE=unknown\n'
fi
engine_packages=''
for package in docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; do
    status="$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)"
    if [ "$status" = installed ]; then
        engine_packages="${engine_packages}${engine_packages:+,}${package}"
    fi
done
printf 'ENGINE_PACKAGES=%s\n' "${engine_packages:-none}"
conflicting_packages=''
for package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
    status="$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)"
    if [ "$status" = installed ]; then
        conflicting_packages="${conflicting_packages}${conflicting_packages:+,}${package}"
    fi
done
printf 'CONFLICT_PACKAGES=%s\n' "${conflicting_packages:-none}"
if command -v docker >/dev/null 2>&1; then
    printf 'DOCKER_BINARY=present\n'
    client_version="$(docker --context default version --format '{{.Client.Version}}' 2>/dev/null || true)"
    server_version="$(docker --context default version --format '{{.Server.Version}}' 2>/dev/null || true)"
    compose_version="$(docker --context default compose version --short 2>/dev/null || true)"
    printf 'DOCKER_CLIENT=%s\n' "${client_version:-unavailable}"
    printf 'DOCKER_SERVER=%s\n' "${server_version:-unavailable}"
    printf 'DOCKER_COMPOSE=%s\n' "${compose_version:-unavailable}"
else
    printf 'DOCKER_BINARY=absent\n'
    printf 'DOCKER_CLIENT=unavailable\nDOCKER_SERVER=unavailable\nDOCKER_COMPOSE=unavailable\n'
fi
if [ -e /var/lib/docker ] || [ -e /var/lib/containerd ]; then
    printf 'DOCKER_DATA=present\n'
else
    printf 'DOCKER_DATA=absent\n'
fi
if [ -e /etc/apt/sources.list.d/docker.sources ]; then
    printf 'DOCKER_SOURCE=present\n'
else
    printf 'DOCKER_SOURCE=absent\n'
fi
if [ -e /etc/apt/keyrings/docker.asc ]; then
    printf 'DOCKER_KEYRING=present\n'
else
    printf 'DOCKER_KEYRING=absent\n'
fi
other_docker_sources="$(find /etc/apt/sources.list.d -maxdepth 1 -type f \( -iname '*docker*.list' -o -iname '*docker*.sources' \) ! -name 'docker.sources' -print -quit 2>/dev/null || true)"
if [ -n "$other_docker_sources" ]; then
    printf 'OTHER_DOCKER_SOURCE=present\n'
else
    printf 'OTHER_DOCKER_SOURCE=absent\n'
fi
'@
$probeLines = @(Invoke-WslBash -Command $probeScript)
$probe = Get-ProbeValues -Lines $probeLines

$requiredProbeValues = @(
    'ID', 'VERSION_CODENAME', 'APT_CODENAME', 'ARCHITECTURE', 'SYSTEMD_AVAILABLE',
    'DOCKER_SERVICE', 'ENGINE_PACKAGES', 'CONFLICT_PACKAGES', 'DOCKER_BINARY',
    'DOCKER_CLIENT', 'DOCKER_SERVER', 'DOCKER_COMPOSE', 'DOCKER_DATA',
    'DOCKER_SOURCE', 'DOCKER_KEYRING',
    'OTHER_DOCKER_SOURCE'
)
foreach ($name in $requiredProbeValues) {
    if (-not $probe.ContainsKey($name)) {
        throw "WSL preflight did not return the required '$name' value. No changes were made."
    }
}

if ($probe['ID'] -ne 'ubuntu') {
    throw "The WSL distribution is '$($probe['ID'])', not Ubuntu. Docker's Ubuntu repository will not be configured."
}

$supportedCodenames = @('resolute', 'noble', 'jammy')
$supportedArchitectures = @('amd64', 'armhf', 'arm64', 's390x', 'ppc64el')
$codename = $probe['APT_CODENAME']
$architecture = $probe['ARCHITECTURE']
if ([string]::IsNullOrWhiteSpace($probe['VERSION_CODENAME']) -and [string]::IsNullOrWhiteSpace($codename)) {
    throw 'Ubuntu VERSION_CODENAME is missing. No changes were made.'
}
if ($codename -notin $supportedCodenames) {
    throw "Ubuntu codename '$codename' is not listed as supported by Docker's official Ubuntu instructions. No changes were made."
}
if ($architecture -notin $supportedArchitectures) {
    throw "dpkg architecture '$architecture' is not listed as supported by Docker's official Ubuntu instructions. No changes were made."
}

$expectedSource = @(
    'Types: deb',
    'URIs: https://download.docker.com/linux/ubuntu',
    "Suites: $codename",
    'Components: stable',
    "Architectures: $architecture",
    'Signed-By: /etc/apt/keyrings/docker.asc',
    ''
) -join "`n"
$engineInstalled = @(Get-PackageNames -Value $probe['ENGINE_PACKAGES'])
$conflicts = @(Get-PackageNames -Value $probe['CONFLICT_PACKAGES'])
if ($engineInstalled.Count -gt 0) {
    if ($engineInstalled.Count -ne $script:EnginePackages.Count) {
        throw "A partial Docker Engine package set is already installed ($($engineInstalled -join ', ')). It was left unchanged."
    }
    if ($probe['DOCKER_BINARY'] -ne 'present') {
        throw 'Docker Engine packages are installed but the docker command is missing. Existing packages were left unchanged.'
    }

    Write-Host "WSL distribution: $Distribution (running, WSL 2)"
    Write-Host "Ubuntu codename: $codename; dpkg architecture: $architecture"
    Write-Host "Docker service: $($probe['DOCKER_SERVICE'])"
    Write-Host "Docker client: $($probe['DOCKER_CLIENT']); server: $($probe['DOCKER_SERVER']); Compose: $($probe['DOCKER_COMPOSE'])"
    if (-not $Apply) {
        if ($probe['DOCKER_SERVER'] -ne 'unavailable' -and $probe['DOCKER_COMPOSE'] -ne 'unavailable') {
            Write-Host 'Existing Docker Engine and Compose versions are reachable. No changes are planned.'
        }
        elseif ($probe['DOCKER_COMPOSE'] -eq 'unavailable') {
            Write-Host 'The Compose plugin could not be verified. No package changes are planned.'
        }
        else {
            Write-Host 'The Docker server is unreachable. Rerun with -Apply to start the existing service and verify local versions; packages will not be reinstalled.'
        }
        return
    }

    if ($probe['DOCKER_COMPOSE'] -eq 'unavailable') {
        throw 'The existing Docker Compose plugin cannot be verified. Existing packages were left unchanged.'
    }
    Start-DockerService -SystemdAvailable $probe['SYSTEMD_AVAILABLE']
    Test-DockerVersions
    return
}

if ($probe['DOCKER_SOURCE'] -eq 'present' -or $probe['DOCKER_KEYRING'] -eq 'present') {
    throw 'A Docker apt source or keyring already exists without the complete Engine package set. Nothing was overwritten.'
}
if ($probe['OTHER_DOCKER_SOURCE'] -eq 'present') {
    throw 'Another Docker apt source file exists. Resolve it manually before using this installer.'
}
if ($probe['DOCKER_BINARY'] -eq 'present') {
    throw 'A docker command already exists outside the complete Docker Engine package set. It was left unchanged.'
}
if ($conflicts.Count -gt 0) {
    throw "Conflicting packages are installed ($($conflicts -join ', ')). This tool will not remove or replace them."
}
if ($probe['DOCKER_DATA'] -eq 'present') {
    throw 'Docker or containerd data directories already exist without the complete official package set. They were left untouched.'
}

Write-Host "WSL distribution: $Distribution (running, WSL 2)"
Write-Host "Ubuntu VERSION_CODENAME: $($probe['VERSION_CODENAME']); apt suite: $codename"
Write-Host "dpkg architecture: $architecture"
Write-Host "Systemd available: $($probe['SYSTEMD_AVAILABLE'])"
Write-Host "Official Docker instructions: $script:OfficialDocs"

if (-not $Apply) {
    Write-Host ''
    Write-Host 'Read-only preflight passed. Planned commands:'
    Write-Host '  apt update (as WSL root)'
    Write-Host '  apt install -y ca-certificates curl (as WSL root)'
    Write-Host '  install -m 0755 -d /etc/apt/keyrings (if missing)'
    Write-Host "  curl -fsSL $script:OfficialKey -o <temporary file>"
    Write-Host "  bash -c 'set -C; cat > /etc/apt/keyrings/docker.asc' < <temporary file>"
    Write-Host '  chmod a+r /etc/apt/keyrings/docker.asc'
    Write-Host '  create /etc/apt/sources.list.d/docker.sources without replacing an existing file:'
    Write-Host '    Types: deb'
    Write-Host '    URIs: https://download.docker.com/linux/ubuntu'
    Write-Host "    Suites: $codename"
    Write-Host '    Components: stable'
    Write-Host "    Architectures: $architecture"
    Write-Host '    Signed-By: /etc/apt/keyrings/docker.asc'
    Write-Host "  bash -c 'set -C; cat > /etc/apt/sources.list.d/docker.sources' (stdin is the stanza above)"
    Write-Host '  apt update'
    Write-Host '  apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin'
    if ($probe['SYSTEMD_AVAILABLE'] -eq 'yes') {
        Write-Host '  systemctl start docker'
    }
    else {
        Write-Host '  service docker start'
    }
    Write-Host "  docker --context default version --format '{{.Client.Version}} / {{.Server.Version}}'"
    Write-Host '  docker --context default compose version --short'
    Write-Host ''
    Write-Host 'No repository, package, data, or service changes were made. Pass -Apply to run these commands as WSL root.'
    return
}

$applyScript = @'
set -euo pipefail
. /etc/os-release
actual_codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
actual_architecture="$(dpkg --print-architecture)"
if [ "${ID:-}" != ubuntu ] || [ "$actual_codename" != '__CODE_NAME__' ] || [ "$actual_architecture" != '__ARCHITECTURE__' ]; then
    printf 'Ubuntu release or architecture changed after preflight. Stopping.\n' >&2
    exit 20
fi
for package in docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; do
    status="$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)"
    if [ "$status" = installed ]; then
        printf 'Docker package appeared after preflight (%s). Stopping without replacing it.\n' "$package" >&2
        exit 21
    fi
done
for package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
    status="$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)"
    if [ "$status" = installed ]; then
        printf 'Conflicting package appeared after preflight (%s). Resolve it manually.\n' "$package" >&2
        exit 22
    fi
done
if command -v docker >/dev/null 2>&1; then
    printf 'A docker command appeared after preflight. Stopping without replacing it.\n' >&2
    exit 23
fi
if [ -e /var/lib/docker ] || [ -e /var/lib/containerd ]; then
    printf 'Docker or containerd data appeared after preflight. Stopping without touching it.\n' >&2
    exit 24
fi
if [ -e /etc/apt/sources.list.d/docker.sources ] || [ -e /etc/apt/keyrings/docker.asc ]; then
    printf 'A Docker apt source or keyring appeared after preflight. Nothing was overwritten.\n' >&2
    exit 25
fi
other_docker_sources="$(find /etc/apt/sources.list.d -maxdepth 1 -type f \( -iname '*docker*.list' -o -iname '*docker*.sources' \) -print -quit 2>/dev/null || true)"
if [ -n "$other_docker_sources" ]; then
    printf 'Another Docker apt source appeared after preflight. Resolve it manually.\n' >&2
    exit 26
fi
apt update
apt install -y ca-certificates curl
if [ ! -d /etc/apt/keyrings ]; then
    install -m 0755 -d /etc/apt/keyrings
fi
key_temp="$(mktemp)"
trap 'rm -f "$key_temp"' EXIT
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$key_temp"
grep -q 'BEGIN PGP PUBLIC KEY BLOCK' "$key_temp"
bash -c 'set -C; cat > /etc/apt/keyrings/docker.asc' < "$key_temp"
chmod a+r /etc/apt/keyrings/docker.asc
printf '%s' '__SOURCE_BASE64__' | base64 -d | bash -c 'set -C; cat > /etc/apt/sources.list.d/docker.sources'
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    systemctl start docker
elif command -v service >/dev/null 2>&1; then
    service docker start
else
    printf 'No usable WSL service manager is available. Docker was installed but could not be started.\n' >&2
    exit 28
fi
client="$(docker --context default version --format '{{.Client.Version}}')"
server="$(docker --context default version --format '{{.Server.Version}}')"
compose="$(docker --context default compose version --short)"
test -n "$client"
test -n "$server"
test -n "$compose"
printf 'Docker client: %s\nDocker server: %s\nDocker Compose: %s\n' "$client" "$server" "$compose"
'@
$sourceBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($expectedSource))
$applyScript = $applyScript.Replace('__CODE_NAME__', $codename)
$applyScript = $applyScript.Replace('__ARCHITECTURE__', $architecture)
$applyScript = $applyScript.Replace('__SOURCE_BASE64__', $sourceBase64)

Write-Host 'Applying the official Docker Engine and Compose installation plan.'
Write-Host 'WSL account: root (--user root; no sudo prompt).'
Write-Host 'This may change the WSL apt source, install packages, and start the Docker service.'
Invoke-WslBash -Command $applyScript -StreamOutput -RunAsRoot
