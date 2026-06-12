# ============================================================================
# Normalizador de Videos - RTMP Panel (Windows)
#
# Converte videos na sua maquina para o perfil de normalizacao do servidor,
# para que o upload no painel seja instantaneo (so reempacota, sem re-encode).
#
# - Interface grafica com fila, progresso e arrastar-e-soltar
# - Baixa o FFmpeg automaticamente na primeira execucao
# - Mesma deteccao inteligente do servidor: pula o que ja esta no padrao
#
# Requisitos: Windows 10+ (PowerShell 5.1, ja incluso no Windows)
# Execute pelo "Normalizador.bat" (duplo clique).
# ============================================================================

$ErrorActionPreference = 'Stop'

$script:ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:BinDir    = Join-Path $script:ScriptDir 'bin'
$script:FFmpeg    = Join-Path $script:BinDir 'ffmpeg.exe'
$script:FFprobe   = Join-Path $script:BinDir 'ffprobe.exe'
$script:Extensions = @('.mp4', '.mkv', '.mov', '.avi', '.flv', '.ts', '.m4v', '.webm')
$script:FFmpegUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip'

# ----------------------------------------------------------------------------
# Funcoes de analise e montagem de comando (espelham o servidor)
# ----------------------------------------------------------------------------

function Get-Probe([string]$Path) {
    try {
        $out = & $script:FFprobe -v quiet -print_format json -show_streams -show_format $Path 2>$null
        if (-not $out) { return $null }
        return ($out -join "`n") | ConvertFrom-Json
    } catch { return $null }
}

function Convert-Fps([string]$s) {
    if (-not $s) { return $null }
    $parts = $s -split '/'
    if ($parts.Count -eq 2) {
        if ([double]$parts[1] -eq 0) { return $null }
        return [double]$parts[0] / [double]$parts[1]
    }
    try { return [double]$s } catch { return $null }
}

# Decide o quanto precisa converter, igual ao servidor:
#   'skip'  - video e audio ja conformes (pode enviar direto, sem converter)
#   'audio' - video conforme, audio difere: copia o video, converte o audio
#   'full'  - re-encode completo
function Get-Conformance($Probe, $Settings) {
    if (-not $Probe -or -not $Probe.streams) { return 'full' }
    $v = $Probe.streams | Where-Object { $_.codec_type -eq 'video' } | Select-Object -First 1
    $a = $Probe.streams | Where-Object { $_.codec_type -eq 'audio' } | Select-Object -First 1
    if (-not $v -or -not $a) { return 'full' }

    $fps = Convert-Fps $v.r_frame_rate
    if ($null -eq $fps) { $fps = Convert-Fps $v.avg_frame_rate }

    $sarOk = (-not $v.sample_aspect_ratio) -or ($v.sample_aspect_ratio -eq '1:1') -or ($v.sample_aspect_ratio -eq '0:1')
    $progOk = (-not $v.field_order) -or ($v.field_order -eq 'progressive')

    $videoOk = ($v.codec_name -eq 'h264') -and
               ($v.pix_fmt -eq 'yuv420p') -and
               ([int]$v.width -eq $Settings.Width) -and
               ([int]$v.height -eq $Settings.Height) -and
               ($null -ne $fps) -and ([math]::Abs($fps - $Settings.Fps) -le 1) -and
               $progOk -and $sarOk
    if (-not $videoOk) { return 'full' }

    $audioOk = ($a.codec_name -eq 'aac') -and
               ([int]$a.sample_rate -eq 44100) -and
               ([int]$a.channels -eq 2)
    if ($audioOk) { return 'skip' }
    return 'audio'
}

function Get-ConversionArgs([string]$InPath, [string]$OutPath, $Settings, [string]$Method) {
    $w = $Settings.Width; $h = $Settings.Height; $fps = $Settings.Fps
    $vb = $Settings.VideoBitrate; $ab = $Settings.AudioBitrate
    $buf = ([int]($vb -replace 'k', '') * 2).ToString() + 'k'

    if ($Method -eq 'audio') {
        return @(
            '-hide_banner', '-loglevel', 'error', '-y',
            '-i', $InPath,
            '-c:v', 'copy',
            '-af', 'aresample=async=1:first_pts=0',
            '-c:a', 'aac', '-b:a', $ab, '-ar', '44100', '-ac', '2',
            '-movflags', '+faststart',
            $OutPath
        )
    }
    return @(
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', $InPath,
        '-vf', "scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=$fps",
        '-c:v', 'libx264', '-preset', $Settings.Preset, '-profile:v', 'high', '-level', '4.1',
        '-b:v', $vb, '-maxrate', $vb, '-bufsize', $buf,
        '-g', [string](2 * $fps), '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', $ab, '-ar', '44100', '-ac', '2',
        '-movflags', '+faststart',
        $OutPath
    )
}

function ConvertTo-ArgString([string[]]$Items) {
    ($Items | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    }) -join ' '
}

function Get-OutputPath([string]$InPath, [string]$OutDir) {
    $base = [System.IO.Path]::GetFileNameWithoutExtension($InPath)
    $candidate = Join-Path $OutDir ($base + '.mp4')
    $n = 1
    while (Test-Path $candidate) {
        $candidate = Join-Path $OutDir ("$base ($n).mp4")
        $n++
    }
    return $candidate
}

# Le o arquivo de -progress do ffmpeg mesmo com ele aberto para escrita
function Read-ProgressFile([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    try {
        $fs = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
        try {
            $sr = New-Object System.IO.StreamReader($fs)
            $text = $sr.ReadToEnd()
        } finally { $fs.Close() }
        $lastOut = $null
        foreach ($line in ($text -split "`n")) {
            if ($line -match '^out_time_ms=(\d+)') { $lastOut = [long]$Matches[1] }
        }
        return $lastOut
    } catch { return $null }
}

# Modo de teste (CI/Linux): exporta apenas as funcoes acima, sem GUI
if ($env:NORMALIZADOR_NO_GUI -eq '1') { return }

# ----------------------------------------------------------------------------
# Download automatico do FFmpeg
# ----------------------------------------------------------------------------

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Install-FFmpeg {
    if ((Test-Path $script:FFmpeg) -and (Test-Path $script:FFprobe)) { return $true }
    $resp = [System.Windows.Forms.MessageBox]::Show(
        "O FFmpeg ainda nao esta nesta pasta (necessario para converter)." + [Environment]::NewLine + [Environment]::NewLine +
        "Baixar automaticamente agora (~150 MB)?" + [Environment]::NewLine +
        "A janela pode ficar sem responder durante o download.",
        'Normalizador - FFmpeg', 'YesNo', 'Question')
    if ($resp -ne 'Yes') { return $false }
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $zip = Join-Path $env:TEMP 'ffmpeg-rtmppanel.zip'
        $tmp = Join-Path $env:TEMP 'ffmpeg-rtmppanel-extract'
        # Sem a barra de progresso o download do PS 5.1 fica varias vezes mais rapido
        $oldPP = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        try {
            Invoke-WebRequest -Uri $script:FFmpegUrl -OutFile $zip -UseBasicParsing
        } finally {
            $ProgressPreference = $oldPP
        }
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        New-Item -ItemType Directory -Force -Path $script:BinDir | Out-Null
        Get-ChildItem -Path $tmp -Recurse -Include 'ffmpeg.exe', 'ffprobe.exe' | ForEach-Object {
            Copy-Item $_.FullName -Destination $script:BinDir -Force
        }
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            "Falha ao baixar o FFmpeg: $($_.Exception.Message)" + [Environment]::NewLine + [Environment]::NewLine +
            "Voce pode baixar manualmente em https://www.gyan.dev/ffmpeg/builds/ e copiar ffmpeg.exe e ffprobe.exe para a pasta 'bin' ao lado deste script.",
            'Normalizador - erro', 'OK', 'Error')
        return $false
    }
    if ((Test-Path $script:FFmpeg) -and (Test-Path $script:FFprobe)) { return $true }
    [System.Windows.Forms.MessageBox]::Show(
        "O download terminou mas ffmpeg.exe/ffprobe.exe nao foram encontrados. Copie-os manualmente para a pasta 'bin'.",
        'Normalizador - erro', 'OK', 'Error')
    return $false
}

if (-not (Install-FFmpeg)) { return }

# ----------------------------------------------------------------------------
# Interface grafica
# ----------------------------------------------------------------------------

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Normalizador de Videos - RTMP Panel'
$form.Size = New-Object System.Drawing.Size(820, 600)
$form.MinimumSize = $form.Size
$form.StartPosition = 'CenterScreen'

# --- Perfil ---
$grpPerfil = New-Object System.Windows.Forms.GroupBox
$grpPerfil.Text = 'Perfil (use os mesmos valores do servidor - NORMALIZE_*)'
$grpPerfil.Location = New-Object System.Drawing.Point(12, 10)
$grpPerfil.Size = New-Object System.Drawing.Size(780, 80)
$grpPerfil.Anchor = 'Top,Left,Right'
$form.Controls.Add($grpPerfil)

function New-LabeledCombo($Parent, $LabelText, [string[]]$Options, $Default, $X) {
    $lbl = New-Object System.Windows.Forms.Label
    $lbl.Text = $LabelText
    $lbl.Location = New-Object System.Drawing.Point($X, 22)
    $lbl.AutoSize = $true
    $Parent.Controls.Add($lbl)
    $cmb = New-Object System.Windows.Forms.ComboBox
    $cmb.DropDownStyle = 'DropDownList'
    $cmb.Location = New-Object System.Drawing.Point($X, 42)
    $cmb.Width = 110
    [void]$cmb.Items.AddRange($Options)
    $cmb.SelectedItem = $Default
    $Parent.Controls.Add($cmb)
    return $cmb
}

$cmbRes    = New-LabeledCombo $grpPerfil 'Resolucao'      @('1920x1080', '1280x720', '854x480', '640x360') '1280x720' 15
$cmbFps    = New-LabeledCombo $grpPerfil 'FPS'            @('24', '30', '60') '30' 140
$cmbVb     = New-LabeledCombo $grpPerfil 'Bitrate video'  @('6000k', '4500k', '2500k', '1500k', '800k') '2500k' 265
$cmbAb     = New-LabeledCombo $grpPerfil 'Bitrate audio'  @('192k', '128k', '96k') '128k' 390
$cmbPreset = New-LabeledCombo $grpPerfil 'Preset x264'    @('ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium') 'veryfast' 515

$chkSmart = New-Object System.Windows.Forms.CheckBox
$chkSmart.Text = 'Deteccao inteligente (pula o que ja esta no padrao)'
$chkSmart.Checked = $true
$chkSmart.Location = New-Object System.Drawing.Point(645, 30)
$chkSmart.Size = New-Object System.Drawing.Size(130, 45)
$grpPerfil.Controls.Add($chkSmart)

# --- Pasta de saida ---
$lblOut = New-Object System.Windows.Forms.Label
$lblOut.Text = 'Pasta de saida:'
$lblOut.Location = New-Object System.Drawing.Point(12, 100)
$lblOut.AutoSize = $true
$form.Controls.Add($lblOut)

$txtOut = New-Object System.Windows.Forms.TextBox
$txtOut.Location = New-Object System.Drawing.Point(105, 97)
$txtOut.Width = 580
$txtOut.Anchor = 'Top,Left,Right'
$txtOut.Text = Join-Path ([Environment]::GetFolderPath('MyVideos')) 'Normalizados'
$form.Controls.Add($txtOut)

$btnBrowseOut = New-Object System.Windows.Forms.Button
$btnBrowseOut.Text = 'Procurar...'
$btnBrowseOut.Location = New-Object System.Drawing.Point(695, 95)
$btnBrowseOut.Anchor = 'Top,Right'
$form.Controls.Add($btnBrowseOut)
$btnBrowseOut.Add_Click({
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    if ($dlg.ShowDialog() -eq 'OK') { $txtOut.Text = $dlg.SelectedPath }
})

# --- Lista ---
$list = New-Object System.Windows.Forms.ListView
$list.View = 'Details'
$list.FullRowSelect = $true
$list.AllowDrop = $true
$list.Location = New-Object System.Drawing.Point(12, 130)
$list.Size = New-Object System.Drawing.Size(780, 360)
$list.Anchor = 'Top,Bottom,Left,Right'
[void]$list.Columns.Add('Arquivo', 420)
[void]$list.Columns.Add('Tamanho', 80)
[void]$list.Columns.Add('Status', 180)
[void]$list.Columns.Add('Progresso', 80)
$form.Controls.Add($list)

# --- Botoes ---
$btnAdd = New-Object System.Windows.Forms.Button
$btnAdd.Text = 'Adicionar videos...'
$btnAdd.Location = New-Object System.Drawing.Point(12, 500)
$btnAdd.Size = New-Object System.Drawing.Size(130, 32)
$btnAdd.Anchor = 'Bottom,Left'
$form.Controls.Add($btnAdd)

$btnStart = New-Object System.Windows.Forms.Button
$btnStart.Text = 'Iniciar'
$btnStart.Location = New-Object System.Drawing.Point(150, 500)
$btnStart.Size = New-Object System.Drawing.Size(110, 32)
$btnStart.Anchor = 'Bottom,Left'
$form.Controls.Add($btnStart)

$btnStop = New-Object System.Windows.Forms.Button
$btnStop.Text = 'Parar'
$btnStop.Enabled = $false
$btnStop.Location = New-Object System.Drawing.Point(268, 500)
$btnStop.Size = New-Object System.Drawing.Size(90, 32)
$btnStop.Anchor = 'Bottom,Left'
$form.Controls.Add($btnStop)

$btnOpenOut = New-Object System.Windows.Forms.Button
$btnOpenOut.Text = 'Abrir pasta de saida'
$btnOpenOut.Location = New-Object System.Drawing.Point(366, 500)
$btnOpenOut.Size = New-Object System.Drawing.Size(140, 32)
$btnOpenOut.Anchor = 'Bottom,Left'
$form.Controls.Add($btnOpenOut)
$btnOpenOut.Add_Click({
    if (Test-Path $txtOut.Text) { Start-Process explorer.exe $txtOut.Text }
})

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Text = 'Arraste videos para a lista ou clique em "Adicionar videos".'
$lblStatus.Location = New-Object System.Drawing.Point(520, 508)
$lblStatus.Size = New-Object System.Drawing.Size(280, 24)
$lblStatus.Anchor = 'Bottom,Left,Right'
$form.Controls.Add($lblStatus)

# --- Fila ---
$script:Queue = New-Object System.Collections.ArrayList
$script:Processing = $false
$script:CurrentItem = $null
$script:CurrentProc = $null
$script:ProgFile = $null
$script:ErrFile = $null

function Add-Files([string[]]$Paths) {
    foreach ($p in $Paths) {
        if (-not (Test-Path $p -PathType Leaf)) { continue }
        $ext = [System.IO.Path]::GetExtension($p).ToLower()
        if ($script:Extensions -notcontains $ext) { continue }
        if ($script:Queue | Where-Object { $_.Path -eq $p }) { continue }
        $li = New-Object System.Windows.Forms.ListViewItem([System.IO.Path]::GetFileName($p))
        $sizeMb = '{0:N1} MB' -f ((Get-Item $p).Length / 1MB)
        [void]$li.SubItems.Add($sizeMb)
        [void]$li.SubItems.Add('na fila')
        [void]$li.SubItems.Add('')
        [void]$list.Items.Add($li)
        [void]$script:Queue.Add([PSCustomObject]@{
            Path = $p; Status = 'queued'; Item = $li; Duration = $null
        })
    }
    $lblStatus.Text = "$($script:Queue.Count) video(s) na fila."
}

$btnAdd.Add_Click({
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Multiselect = $true
    $dlg.Filter = 'Videos|*.mp4;*.mkv;*.mov;*.avi;*.flv;*.ts;*.m4v;*.webm|Todos|*.*'
    if ($dlg.ShowDialog() -eq 'OK') { Add-Files $dlg.FileNames }
})

$list.Add_DragEnter({
    param($s, $e)
    if ($e.Data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
        $e.Effect = [System.Windows.Forms.DragDropEffects]::Copy
    }
})
$list.Add_DragDrop({
    param($s, $e)
    Add-Files ([string[]]$e.Data.GetData([System.Windows.Forms.DataFormats]::FileDrop))
})

function Get-CurrentSettings {
    $res = ($cmbRes.SelectedItem -split 'x')
    return @{
        Width = [int]$res[0]; Height = [int]$res[1]
        Fps = [int]$cmbFps.SelectedItem
        VideoBitrate = [string]$cmbVb.SelectedItem
        AudioBitrate = [string]$cmbAb.SelectedItem
        Preset = [string]$cmbPreset.SelectedItem
    }
}

function Set-ItemStatus($QItem, [string]$Text, [string]$Pct) {
    $QItem.Item.SubItems[2].Text = $Text
    $QItem.Item.SubItems[3].Text = $Pct
}

function Stop-Processing([string]$Reason) {
    $script:Processing = $false
    if ($script:CurrentProc -and -not $script:CurrentProc.HasExited) {
        try { $script:CurrentProc.Kill() } catch {}
    }
    if ($script:CurrentItem -and $script:CurrentItem.Status -eq 'working') {
        $script:CurrentItem.Status = 'queued'
        Set-ItemStatus $script:CurrentItem 'na fila' ''
    }
    $script:CurrentProc = $null
    $script:CurrentItem = $null
    $btnStart.Enabled = $true
    $btnStop.Enabled = $false
    $lblStatus.Text = $Reason
}

# Maquina de estados executada pelo timer (a cada 400ms)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 400
$timer.Add_Tick({
    if (-not $script:Processing) { return }

    # Sem processo rodando: pega o proximo da fila
    if ($null -eq $script:CurrentProc) {
        $next = $script:Queue | Where-Object { $_.Status -eq 'queued' } | Select-Object -First 1
        if ($null -eq $next) {
            $done = ($script:Queue | Where-Object { $_.Status -in @('done', 'skipped') }).Count
            Stop-Processing "Concluido: $done de $($script:Queue.Count) video(s)."
            return
        }
        $script:CurrentItem = $next
        $next.Status = 'working'
        Set-ItemStatus $next 'analisando...' ''

        $settings = Get-CurrentSettings
        $probe = Get-Probe $next.Path
        if ($probe -and $probe.format -and $probe.format.duration) {
            $next.Duration = [double]$probe.format.duration
        }
        $method = 'full'
        if ($chkSmart.Checked) { $method = Get-Conformance $probe $settings }

        if ($method -eq 'skip') {
            $next.Status = 'skipped'
            Set-ItemStatus $next 'ja esta no padrao - envie direto!' '100%'
            $script:CurrentItem = $null
            return
        }

        $outDir = $txtOut.Text
        New-Item -ItemType Directory -Force -Path $outDir | Out-Null
        $outPath = Get-OutputPath $next.Path $outDir
        $next | Add-Member -NotePropertyName OutPath -NotePropertyValue $outPath -Force

        $script:ProgFile = Join-Path $env:TEMP "normprog_$PID.txt"
        $script:ErrFile  = Join-Path $env:TEMP "normerr_$PID.txt"
        Remove-Item $script:ProgFile, $script:ErrFile -Force -ErrorAction SilentlyContinue

        $ffArgs = Get-ConversionArgs $next.Path $outPath $settings $method
        $ffArgs = @('-nostats', '-progress', $script:ProgFile) + $ffArgs
        $label = 'convertendo'
        if ($method -eq 'audio') { $label = 'convertendo audio (video aproveitado)' }
        Set-ItemStatus $next "$label..." '0%'
        try {
            $script:CurrentProc = Start-Process -FilePath $script:FFmpeg `
                -ArgumentList (ConvertTo-ArgString $ffArgs) `
                -WindowStyle Hidden -PassThru -RedirectStandardError $script:ErrFile
        } catch {
            $next.Status = 'error'
            Set-ItemStatus $next "erro: $($_.Exception.Message)" ''
            $script:CurrentItem = $null
        }
        return
    }

    # Processo rodando: atualiza progresso / finaliza
    if (-not $script:CurrentProc.HasExited) {
        if ($script:CurrentItem.Duration) {
            $outMs = Read-ProgressFile $script:ProgFile
            if ($null -ne $outMs) {
                # out_time_ms do ffmpeg e em microssegundos
                $pct = [math]::Min(100, [math]::Round(($outMs / 1e6) / $script:CurrentItem.Duration * 100))
                $script:CurrentItem.Item.SubItems[3].Text = "$pct%"
            }
        }
        return
    }

    $code = $script:CurrentProc.ExitCode
    $item = $script:CurrentItem
    $script:CurrentProc = $null
    $script:CurrentItem = $null
    if ($code -eq 0 -and (Test-Path $item.OutPath)) {
        $item.Status = 'done'
        Set-ItemStatus $item 'pronto' '100%'
    } else {
        $item.Status = 'error'
        $reason = ''
        if (Test-Path $script:ErrFile) {
            $reason = (Get-Content $script:ErrFile -ErrorAction SilentlyContinue | Select-Object -Last 1)
        }
        Set-ItemStatus $item "erro: $reason" ''
        Remove-Item $item.OutPath -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $script:ProgFile, $script:ErrFile -Force -ErrorAction SilentlyContinue
})
$timer.Start()

$btnStart.Add_Click({
    if ($script:Queue.Count -eq 0) {
        $lblStatus.Text = 'Adicione videos primeiro.'
        return
    }
    # Reenfileira erros para tentar de novo
    foreach ($q in $script:Queue) {
        if ($q.Status -eq 'error') { $q.Status = 'queued'; Set-ItemStatus $q 'na fila' '' }
    }
    $script:Processing = $true
    $btnStart.Enabled = $false
    $btnStop.Enabled = $true
    $lblStatus.Text = 'Processando...'
})

$btnStop.Add_Click({ Stop-Processing 'Interrompido.' })

$form.Add_FormClosing({
    if ($script:CurrentProc -and -not $script:CurrentProc.HasExited) {
        try { $script:CurrentProc.Kill() } catch {}
    }
})

[void]$form.ShowDialog()
