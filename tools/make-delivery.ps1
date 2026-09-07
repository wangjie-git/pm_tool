# 交付打包脚本：pm-todo v2.2.0
$ErrorActionPreference = 'Stop'
$root = 'D:\ai\pm-todo'
$stage = Join-Path $root 'dist-staging\pm-todo-v2.2.0'

if (Test-Path (Join-Path $root 'dist-staging')) {
  Remove-Item (Join-Path $root 'dist-staging') -Recurse -Force
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# 1) 安装包 + 绿色版 exe
$pkgDir = Join-Path $stage '安装包'
New-Item -ItemType Directory -Path $pkgDir -Force | Out-Null
Copy-Item (Join-Path $root 'src-tauri\target\release\bundle\nsis\PM待办助手_2.2.0_x64-setup.exe') $pkgDir
Copy-Item (Join-Path $root 'src-tauri\target\release\pm-todo.exe') (Join-Path $pkgDir 'PM待办助手-v2.2.0-绿色版.exe')

# 2) 源码
$src = Join-Path $stage '源码\pm-todo'
New-Item -ItemType Directory -Path $src -Force | Out-Null
Copy-Item (Join-Path $root 'ui') (Join-Path $src 'ui') -Recurse
Get-ChildItem (Join-Path $src 'ui') -Filter '*.bak-v22' -Recurse | Remove-Item -Force
New-Item -ItemType Directory -Path (Join-Path $src 'src-tauri') -Force | Out-Null
Copy-Item (Join-Path $root 'src-tauri\src') (Join-Path $src 'src-tauri\src') -Recurse
Copy-Item (Join-Path $root 'src-tauri\capabilities') (Join-Path $src 'src-tauri\capabilities') -Recurse
Copy-Item (Join-Path $root 'src-tauri\icons') (Join-Path $src 'src-tauri\icons') -Recurse
Copy-Item (Join-Path $root 'src-tauri\Cargo.toml'), (Join-Path $root 'src-tauri\build.rs'), (Join-Path $root 'src-tauri\tauri.conf.json'), (Join-Path $root 'src-tauri\installer-hooks.nsh') (Join-Path $src 'src-tauri')
Copy-Item (Join-Path $root 'docs') (Join-Path $src 'docs') -Recurse
New-Item -ItemType Directory -Path (Join-Path $src 'tools') -Force | Out-Null
Copy-Item (Join-Path $root 'tools\check_ids.js'), (Join-Path $root 'tools\check_syntax.js'), (Join-Path $root 'tools\serve-ui.js') (Join-Path $src 'tools')
Copy-Item (Join-Path $root 'README.md'), (Join-Path $root 'AGENTS.md'), (Join-Path $root 'LICENSE'), (Join-Path $root 'app-icon.png') $src

# 3) 实施记录放包根
Copy-Item (Join-Path $root 'docs\实施记录-实用性与交互打磨v2.2.md') $stage

# 4) 压缩
$zip = Join-Path $root 'pm-todo-v2.2.0-交付.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $root 'dist-staging\pm-todo-v2.2.0') -DestinationPath $zip

$z = Get-Item $zip
Write-Output ('ZIP: ' + $z.FullName + '  ' + [math]::Round($z.Length / 1MB, 2) + ' MB')
Get-ChildItem $stage | ForEach-Object { Write-Output ('  /' + $_.Name) }
