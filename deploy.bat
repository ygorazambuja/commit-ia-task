@echo off
setlocal

set "BIN_DIR=C:\bin"
set "EXE_NAME=commit-ia-task.exe"

REM Executa a partir da pasta do script
cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
    echo [ERRO] Bun nao encontrado no PATH. Instale em https://bun.sh
    exit /b 1
)

echo Compilando %EXE_NAME%...
call bun build --compile src/index.ts --outfile "%EXE_NAME%"
if errorlevel 1 (
    echo [ERRO] Falha ao compilar.
    exit /b 1
)

if not exist "%EXE_NAME%" (
    echo [ERRO] %EXE_NAME% nao foi gerado.
    exit /b 1
)

if not exist "%BIN_DIR%" (
    echo Criando %BIN_DIR%...
    mkdir "%BIN_DIR%"
    if errorlevel 1 (
        echo [ERRO] Nao foi possivel criar %BIN_DIR%. Execute como administrador.
        exit /b 1
    )
)

if exist "%BIN_DIR%\%EXE_NAME%" (
    del /f /q "%BIN_DIR%\%EXE_NAME%"
    if exist "%BIN_DIR%\%EXE_NAME%" (
        echo [ERRO] Nao foi possivel remover a versao antiga. Feche o programa se estiver em uso.
        exit /b 1
    )
)

move /y "%EXE_NAME%" "%BIN_DIR%\" >nul
if errorlevel 1 (
    echo [ERRO] Falha ao mover %EXE_NAME% para %BIN_DIR%.
    exit /b 1
)

echo %PATH% | find /i "%BIN_DIR%" >nul
if errorlevel 1 (
    echo [AVISO] %BIN_DIR% nao esta no PATH. Veja a secao "Configuracao Especifica do Windows" no README.
)

echo Deploy concluido: %BIN_DIR%\%EXE_NAME%
endlocal
