SET "input_file=%~1"
SET "output_file=%~dpn1 45.mp4"

:: Run FFmpeg command
rem ffmpeg -i "%input_file%" -vf "scale=-2:400" -c:a copy "%output_file%"
rem 600square:
rem ffmpeg -i "%input_file%" -vf "scale=w=600:h=600:force_original_aspect_ratio=decrease,pad=600:600:(ow-iw)/2:(oh-ih)/2" -c:v libx265 -tag:v hvc1  "%output_file%"
ffmpeg -i "%input_file%" -vf "scale=-1:400,pad=320:400:(320-iw)/2:(400-ih)/2:black" -c:v libx265 -tag:v hvc1 -c:a copy "%output_file%"
echo.
echo Processing complete! The resized file is saved as %output_file%400.