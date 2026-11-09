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
$output = Join-Path $root 'src-tauri/target/ui-release'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$bundle = Join-Path $output "ui-$Revision.zip"
if (Test-Path -LiteralPath $bundle) { throw "更新包已存在：$bundle；请使用新修订号。" }
$stage = Join-Path $output ("stage-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -Path (Join-Path $root 'dist/*') -Destination $stage -Recurse
$manifest = @{ shell_version = $shellVersion; revision = $Revision } | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $stage 'manifest.json'), $manifest, [Text.UTF8Encoding]::new($false))
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $bundle -CompressionLevel Optimal
& npx tauri signer sign --app-version $shellVersion $bundle
if ($LASTEXITCODE -ne 0) { throw '界面更新包签名失败。' }
Write-Output "已生成：$bundle"
Write-Output "请将更新包及其 .sig 文件上传至 ui-v$shellVersion 预发布版。"
