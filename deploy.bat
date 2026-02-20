REM Check if C:\bin directory exists, create if it doesn't
if not exist "C:\bin" (
    mkdir "C:\bin"
)

REM Remove arquivo antigo
if exist "C:\bin\commit-ia-task.exe" (
    rm "C:\bin\commit-ia-task.exe"
)

REM Move the file to C:\bin
move ".\commit-ia-task.exe" "C:\bin"