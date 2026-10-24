# 发布到 GitHub：取授权 → 建仓库 → 提交 → 推送
# 由 DSH 调用，交互部分只有一次 GitHub 登录（浏览器或设备码）
$ErrorActionPreference = 'Stop'
$git = 'D:\Git\cmd\git.exe'
$repoPath = 'D:\ds_workspace\resume-app'
$repoName = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { 'resume-studio' }
$description = '手机上填写、排版并导出 A4 PDF 的简历工具，纯前端零依赖'

Write-Host "[1/5] 请求 GitHub 授权……（浏览器会弹出登录页）"
$credInput = "protocol=https`nhost=github.com`n`n"
$cred = $credInput | & $git credential fill
$user = ($cred | Where-Object { $_ -like 'username=*' }) -replace '^username=', ''
$token = ($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
if (-not $user -or -not $token) { throw '没有拿到 GitHub 凭据（可能取消了登录）' }
Write-Host "      已登录：$user"

$headers = @{
  Authorization        = "Bearer $token"
  Accept               = 'application/vnd.github+json'
  'User-Agent'         = 'resume-app-publisher'
  'X-GitHub-Api-Version' = '2022-11-28'
}

Write-Host "[2/5] 确认仓库 $user/$repoName 是否存在……"
$exists = $null
try {
  $exists = Invoke-RestMethod -Uri "https://api.github.com/repos/$user/$repoName" -Headers $headers
} catch {
  $exists = $null
}

if ($exists) {
  Write-Host "      仓库已存在：$($exists.html_url)"
} else {
  $body = @{
    name        = $repoName
    description = $description
    private     = $false
    has_issues  = $true
    has_wiki    = $false
    auto_init   = $false
  } | ConvertTo-Json

  $created = Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Method Post -Headers $headers -Body $body -ContentType 'application/json'
  Write-Host "      已创建：$($created.html_url)"
}

Write-Host "[3/5] 配置提交身份并提交……"
& $git -C $repoPath config user.name $user
& $git -C $repoPath config user.email "$user@users.noreply.github.com"
& $git -C $repoPath add -A
$status = & $git -C $repoPath status --porcelain
if ($status) {
  & $git -C $repoPath commit -m '初始化：简历工坊' | Out-Host
  Write-Host "      已提交"
} else {
  Write-Host "      没有新的改动需要提交"
}

Write-Host "[4/5] 设置远程仓库……"
& $git -C $repoPath remote remove origin 2>$null
& $git -C $repoPath remote add origin "https://github.com/$user/$repoName.git"
Write-Host "      origin = https://github.com/$user/$repoName.git"

Write-Host "[5/5] 推送……"
& $git -C $repoPath push -u origin main 2>&1 | Out-Host

Write-Host ""
Write-Host "完成：https://github.com/$user/$repoName"
Write-Host "Pages：仓库 Settings → Pages → Source 选 GitHub Actions"
