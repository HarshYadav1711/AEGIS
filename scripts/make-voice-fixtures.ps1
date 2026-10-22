# Generate the FIXTURE recordings used by the voice smoke test (Windows built-in speech synthesis, offline).
# Each file is 16 kHz mono 16-bit PCM with 0.6 s of leading and 1.6 s of trailing silence, so Chromium's fake
# capture device (which loops the file) is stopped inside the trailing silence.
#   powershell -ExecutionPolicy Bypass -File scripts\make-voice-fixtures.ps1 -OutDir $env:TEMP\aegis-voice
# These are synthetic speech, not microphone recordings; results obtained with them are labelled as fixtures.
param([Parameter(Mandatory = $true)][string]$OutDir, [string]$Voice = 'Microsoft Zira Desktop')
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutDir | Out-Null
Add-Type -AssemblyName System.Speech

$phrases = [ordered]@{
  ask      = 'In one short sentence, what is the capital of France?'
  remember = 'Remember that my preferred development workflow uses manual commits.'
  recall   = 'What did I ask you to remember about commits?'
  correct  = 'Correct that memory: this exception applies only to my test repository.'
  file     = 'Organize the files in my downloads folder by type.'
}
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($name in $phrases.Keys) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try {
    $synth.SelectVoice($Voice)
    $pcm = New-Object System.IO.MemoryStream
    $synth.SetOutputToAudioStream($pcm, $format)
    $synth.Speak($phrases[$name])
    $synth.SetOutputToNull()
  } finally {
    $synth.Dispose()
  }
  $lead = New-Object byte[] (16000 * 2 * 0.6)
  $tail = New-Object byte[] (16000 * 2 * 1.6)
  $data = [byte[]]($lead + $pcm.ToArray() + $tail)
  $file = Join-Path $OutDir "$name.wav"
  $out = [System.IO.File]::Create($file)
  $w = New-Object System.IO.BinaryWriter($out)
  $w.Write([Text.Encoding]::ASCII.GetBytes('RIFF')); $w.Write([int](36 + $data.Length)); $w.Write([Text.Encoding]::ASCII.GetBytes('WAVE'))
  $w.Write([Text.Encoding]::ASCII.GetBytes('fmt ')); $w.Write([int]16); $w.Write([int16]1); $w.Write([int16]1)
  $w.Write([int]16000); $w.Write([int]32000); $w.Write([int16]2); $w.Write([int16]16)
  $w.Write([Text.Encoding]::ASCII.GetBytes('data')); $w.Write([int]$data.Length); $w.Write($data)
  $w.Close()
  Write-Host ("{0,-9} {1:N1} s  {2}" -f $name, ($data.Length / 32000), $phrases[$name])
}
