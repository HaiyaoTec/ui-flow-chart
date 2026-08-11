# 引擎自检：起测试站 → 跑主进程自检 → 打印 JSON 结果
# 用法： powershell -File scripts/selfcheck.ps1
$ErrorActionPreference = 'SilentlyContinue'
Get-Process electron | Stop-Process -Force
Set-Location $PSScriptRoot\..

npm run build 2>&1 | Select-Object -Last 1

$site = Start-Process -FilePath "node" -ArgumentList "test-site/serve.mjs 4183" -PassThru -NoNewWindow
Start-Sleep -Seconds 2

$env:UFC_TEST = '1'
$env:UFC_SELFCHECK = 'http://localhost:4183'
$out = & node_modules\.bin\electron.cmd . 2>&1
Remove-Item Env:UFC_SELFCHECK

Stop-Process -Id $site.Id -Force

$line = $out | Select-String -Pattern 'SELFCHECK_RESULT'
if ($line) {
  ($line -split 'SELFCHECK_RESULT ')[1]
} else {
  "自检未产出结果，最后输出："
  $out | Select-Object -Last 30
}
