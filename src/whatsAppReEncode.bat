@echo off
REM Windows implementation of Marian Minar's answer to "ffmpeg video compression / specific file size" https://stackoverflow.com/a/61146975/2902367
SET "video=%~1"
SET "target_video_size_MB=%~2"
SET "output_file=%~dpn1 %~2MB.mp4"
REM I usually don't see a big difference between two-pass and single-pass... set to anything but "true" to turn off two-pass encoding
SET "twopass=true"
REM We need a way to do floating point arithmetic in CMD, here is a quick one. Change the path to a location that's convenient for you
set "mathPath=.\Math.vbs"
REM Creating the Math VBS file
if not exist "%mathPath%" echo Wscript.echo replace(eval(WScript.Arguments(0)),",",".")>%mathPath%

echo Converting to %target_video_size_MB% MB: "%video%"
echo -^> "%output_file%"

SETLOCAL EnableDelayedExpansion
REM Getting the (audio) duration. TODO: watch out for differing audio/video durations?
FOR /F "delims=" %%i IN ('ffprobe -v error -show_streams -select_streams a "%~1"') DO (
    SET "line=%%i"
    if "!line:~0,9!" == "duration=" (
        SET "duration=!line:~9!"
    )
)
echo "Finished probing"
REM Getting the audio bitrate
FOR /F "delims=" %%i IN ('ffprobe -v error -pretty -show_streams -select_streams a "%~1"') DO (
    SET "line=%%i"
    SET /A "c=0"
    if "!line:~0,9!" == "bit_rate=" (
        FOR %%a IN (!line:~9!) DO (
            if "!c!" == "0" (
                SET "audio_rate=%%a"
            )
            SET /A "c+=1"
        )
    )
)
echo "Finished Audio bitrate probing"
REM TODO: Adjust target audio bitrate. Use source bitrate for now.
SET "target_audio_bitrate=%audio_rate%"

call:Math %target_video_size_MB% * 8192 / (1.048576 * %duration%) - %target_audio_bitrate%
SET "target_video_bitrate=%result%"

echo %target_audio_bitrate% audio, %target_video_bitrate% video

SET "passString="
if "%twopass%" == "true" (
    echo Two-Pass Encoding
    ffmpeg ^
        -y ^
        -i "%~1" ^
        -c:v libx264 ^
        -b:v %target_video_bitrate%k ^
        -pass 1 ^
        -an ^
        -f mp4 ^
        nul
    SET "passString=-pass 2"
) else ( echo Single-Pass Encoding )
ffmpeg ^
    -i "%~1" ^
    -c:v libx264 ^
    -b:v %target_video_bitrate%k ^
    %passString% ^
    -c:a aac ^
    -b:a %target_audio_bitrate%k ^
    "%output_file%"
    
GOTO :EOF

:Math
REM echo Working : "%*"
for /f %%a in ('cscript /nologo %mathPath% "%*"') do set "Result=%%a"
GOTO :EOF