$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.method -eq 'voices') {
        $voices = @($synth.GetInstalledVoices() | Where-Object Enabled | ForEach-Object {
            @{ id = $_.VoiceInfo.Name; name = $_.VoiceInfo.Name; language = $_.VoiceInfo.Culture.Name }
        })
        [Console]::Write((ConvertTo-Json -InputObject $voices -Compress))
    } elseif ($request.method -eq 'synthesize') {
        $synth.SelectVoice($request.voice)
        $synth.Rate = [Math]::Max(-10, [Math]::Min(10, [Math]::Round([Math]::Log($request.rate, 2) * 5)))
        $stream = [IO.MemoryStream]::new()
        try {
            $synth.SetOutputToWaveStream($stream)
            $synth.Speak([string]$request.text)
            $synth.SetOutputToNull()
            [Console]::Write([Convert]::ToBase64String($stream.ToArray()))
        } finally { $stream.Dispose() }
    } else { throw 'Unknown speech request' }
} finally { $synth.Dispose() }
