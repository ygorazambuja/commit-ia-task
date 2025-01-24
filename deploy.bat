bun build --outfile commit-ia-task --compile .\src\index.ts

REM Check if the file exists
if not exist "commit-ia-task.exe" (
    echo Error: The file commit-ia-task.exe does not exist.
    exit /b 1
)

REM Check if C:\bin directory exists, create if it doesn't
if not exist "C:\bin" (
    mkdir "C:\bin"
)

REM Move the file to C:\bin
move ".\commit-ia-task.exe" "C:\bin"