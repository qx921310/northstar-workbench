param(
    [Parameter(Mandatory=$true)][ValidateRange(1, 2147483647)][int]$Revision
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
if (-not $env:TAURI_SIGNING_PRIVATE_KEY -and -not $env:TAURI_SIGNING_PRIVATE_KEY_PATH) {
    throw '请通过环境变量提供界面更新签名密钥；不要将密钥放入仓库。'
}
$shellVersion = (Get-Content -Raw 'src-tauri/tauri.conf.json' | ConvertFrom-Json).version
if ($shellVersion -notmatch '^\d+\.\d+\.\d+$') { throw '应用版本格式无效。' }
& npm run build
if ($LASTEXITCODE -ne 0) { throw '前端构建失败。' }
$output = Join-Path $root "src-tauri/target/ui-release/v$shellVersion"
New-Item -ItemType Directory -Force -Path $output | Out-Null
$bundle = Join-Path $output "ui-$Revision.zip"
if (Test-Path -LiteralPath $bundle) { throw "更新包已存在：$bundle；请使用新修订号。" }
$stage = Join-Path $output ("stage-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -Path (Join-Path $root 'dist/*') -Destination $stage -Recurse
# The desktop icon source is only used by the icon generator. The installed
# updater accepts index.html and assets/ only, so do not include this file.
$iconSource = Join-Path $stage 'northstar-mark.svg'
if (Test-Path -LiteralPath $iconSource) { Remove-Item -LiteralPath $iconSource }
$parts = $shellVersion.Split('.') | ForEach-Object { [int]$_ }
$appVersion = "{0}.{1}.{2}" -f $parts[0], $parts[1], ($parts[2] + $Revision)
$commit = (git rev-parse HEAD).Trim()
if (git status --porcelain) { throw '请先提交变更，确保版本可追溯。' }
$manifest = @{ shell_version = $shellVersion; revision = $Revision; app_version = $appVersion; commit = $commit } | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $stage 'manifest.json'), $manifest, [Text.UTF8Encoding]::new($false))
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $bundle -CompressionLevel Optimal
& npx tauri signer sign --app-version $shellVersion $bundle
if ($LASTEXITCODE -ne 0) { throw '界面更新包签名失败。' }
Write-Output "已生成：$bundle，应用版本：$appVersion，提交：$commit"
Write-Output "请将更新包及其 .sig 文件上传至 ui-v$shellVersion 预发布版。"
