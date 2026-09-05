@echo off
rem Portable MSVC env for cargo/rustc (no admin required)
set MSVC_ROOT=D:\ai\pm-todo\tools\msvc-portable\msvc
set MSVC_VER=14.44.35207
set SDK_VER=10.0.26100.0

set "PATH=%MSVC_ROOT%\VC\Tools\MSVC\%MSVC_VER%\bin\Hostx64\x64;%MSVC_ROOT%\Windows Kits\10\bin\%SDK_VER%\x64;%PATH%"
set "INCLUDE=%MSVC_ROOT%\VC\Tools\MSVC\%MSVC_VER%\include;%MSVC_ROOT%\Windows Kits\10\Include\%SDK_VER%\ucrt;%MSVC_ROOT%\Windows Kits\10\Include\%SDK_VER%\um;%MSVC_ROOT%\Windows Kits\10\Include\%SDK_VER%\shared;%MSVC_ROOT%\Windows Kits\10\Include\%SDK_VER%\winrt"
set "LIB=%MSVC_ROOT%\VC\Tools\MSVC\%MSVC_VER%\lib\x64;%MSVC_ROOT%\Windows Kits\10\Lib\%SDK_VER%\ucrt\x64;%MSVC_ROOT%\Windows Kits\10\Lib\%SDK_VER%\um\x64"
