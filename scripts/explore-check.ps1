# 全流程自检：测试站 + mock AI + 一整轮自动探索
# 用法： powershell -File scripts/explore-check.ps1 [scenario]
param([string]$Scenario = 'normal')

$ErrorActionPreference = 'SilentlyContinue'
Get-Process electron | Stop-Process -Force
Set-Location $PSScriptRoot\..

# 构建失败必须立刻暴露，否则会拿旧产物跑出误导性的结果
$build = npm run build 2>&1
if ($LASTEXITCODE -ne 0) {
  "构建失败，已中止："
  $build | Select-Object -Last 25
  exit 1
}
$build | Select-Object -Last 1

$site = Start-Process -FilePath "node" -ArgumentList "test-site/serve.mjs 4183" -PassThru -NoNewWindow
$ai   = Start-Process -FilePath "node" -ArgumentList "tests/mock-ai/server.mjs 4192 $Scenario" -PassThru -NoNewWindow
Start-Sleep -Seconds 2

$env:UFC_TEST = '1'
$env:UFC_SELFCHECK_EXPLORE = '1'
$env:UFC_SITE = 'http://localhost:4183'
$env:UFC_AI = 'http://localhost:4192/v1'
$out = & node_modules\.bin\electron.cmd . 2>&1
Remove-Item Env:UFC_SELFCHECK_EXPLORE

Stop-Process -Id $site.Id -Force
Stop-Process -Id $ai.Id -Force

$line = $out | Select-String -Pattern 'EXPLORE_RESULT'
if ($line) {
  ($line -split 'EXPLORE_RESULT ')[1]
} else {
  "自检未产出结果，最后输出："
  $out | Select-Object -Last 40
}

