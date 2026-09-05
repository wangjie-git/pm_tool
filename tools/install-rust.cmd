@echo off
set "RUSTUP_DIST_SERVER=https://mirrors.ustc.edu.cn/rust-static"
set "RUSTUP_UPDATE_ROOT=https://mirrors.ustc.edu.cn/rust-static/rustup"
C:\Users\MSI\.cargo\bin\rustup.exe toolchain install stable-x86_64-pc-windows-msvc --profile minimal
if errorlevel 1 (
  echo USTC failed, trying SJTU mirror...
  set "RUSTUP_DIST_SERVER=https://mirrors.sjtug.sjtu.edu.cn/rust-static"
  C:\Users\MSI\.cargo\bin\rustup.exe toolchain install stable-x86_64-pc-windows-msvc --profile minimal
)
C:\Users\MSI\.cargo\bin\rustup.exe default stable-x86_64-pc-windows-msvc
echo RUST-MSVC-DONE errorlevel=%errorlevel%
