param(
    [Parameter(Mandatory=$true)][ValidateRange(1, 2147483647)][int]$Revision
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
if (git status --porcelain) { throw '源码工作区有未提交的变更，请先完成审查和提交。' }
$shellVersion = (Get-Content -Raw 'src-tauri/tauri.conf.json' | ConvertFrom-Json).version
if ($shellVersion -notmatch '^\d+\.\d+\.\d+$') { throw '应用版本格式无效。' }
$bundle = Join-Path $root "src-tauri/target/ui-release/ui-$Revision.zip"
$signature = "$bundle.sig"
if (-not (Test-Path -LiteralPath $bundle) -or -not (Test-Path -LiteralPath $signature)) { throw '请先生成并校验界面更新包及签名。' }
$lines = @('protocol=https','host=github.com','username=qx921310','') | git -c credential.interactive=never credential fill
$secret = $lines | Where-Object { $_ -like 'password=*' } | Select-Object -First 1
if (-not $secret) { throw 'GitHub 登录凭据不可用。' }
$token = $secret.Substring(9); $lines = $null; $secret = $null
$headers = @{ Authorization = "Bearer $token"; 'User-Agent' = 'Northstar-Workbench'; Accept = 'application/vnd.github+json' }
try {
    $user = Invoke-RestMethod -Headers $headers 'https://api.github.com/user'
    if ($user.login -ne 'qx921310') { throw 'GitHub 凭据不属于目标账户。' }
    $base = 'https://api.github.com/repos/qx921310/northstar-workbench/releases'
    $tag = "ui-v$shellVersion"
    try { $release = Invoke-RestMethod -Headers $headers "$base/tags/$tag" }
    catch {
        if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
        $body = @{tag_name=$tag;target_commitish=(git rev-parse HEAD).Trim();name="北极星 $shellVersion 界面更新";body='与指定桌面壳兼容的签名界面资源。';draft=$true;prerelease=$true} | ConvertTo-Json
        $release = Invoke-RestMethod -Method Post -Headers $headers -Uri $base -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
    }
    if (-not $release.prerelease) { throw '界面资源发布必须是预发布版，避免覆盖正式版更新。' }
    foreach ($file in @($bundle, $signature)) {
        $name = [IO.Path]::GetFileName($file)
        $existing = $release.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
        if ($existing) {
            $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($existing.digest -ne "sha256:$hash") { throw "远程已存在不同内容的 $name，请使用新的修订号。" }
            Write-Output "已存在且校验一致：$name"
            continue
        }
        $upload = "https://uploads.github.com/repos/qx921310/northstar-workbench/releases/$($release.id)/assets?name=$([Uri]::EscapeDataString($name))"
        $asset = Invoke-RestMethod -Method Post -Headers $headers -Uri $upload -ContentType 'application/octet-stream' -InFile $file
        Write-Output "已上传：$($asset.name)"
    }
    if ($release.draft) {
        $release = Invoke-RestMethod -Method Patch -Headers $headers -Uri "$base/$($release.id)" -ContentType 'application/json' -Body '{"draft":false}'
    }
    Write-Output "界面更新已发布：$($release.html_url)"
} finally { $token = $null; $headers = $null }
