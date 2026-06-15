# 🎬 Normalizador de Vídeos — Windows

Ferramenta para converter vídeos **na sua máquina** para o perfil do servidor.
Vídeos pré-normalizados sobem pro painel e ficam prontos em **segundos**
(o servidor detecta que já estão no padrão e só reempacota, sem re-encode).

## Como usar

1. Copie esta pasta (`normalizador-windows`) para o seu PC.
2. Dê **duplo clique em `Normalizador.bat`**.
3. Na primeira execução, aceite o download automático do FFmpeg (~150 MB, uma vez só).
4. Arraste seus vídeos para a lista (ou clique em *Adicionar vídeos*).
5. Clique em **Iniciar**. Os arquivos convertidos vão para `Vídeos\Normalizados`
   (configurável).
6. Suba os arquivos da pasta de saída no painel — upload instantâneo. ⚡

## Baixar do YouTube (no seu PC)

Em vez de baixar pelo servidor (onde o YouTube costuma bloquear o IP), baixe
**no seu PC** — aqui o yt-dlp lê os cookies direto do Firefox instalado.

1. Clique em **"Baixar YouTube..."**.
2. Cole a URL do vídeo (ou da playlist).
3. (Opcional) **"Listar resoluções"** mostra o que o vídeo oferece.
4. Escolha a **resolução** — dica: escolha a **mesma do perfil** (ex.: 720p).
   Assim o arquivo já vem no padrão e a normalização é **pulada** (instantâneo).
5. Marque **"Usar cookies do Firefox"** se o vídeo pedir login/idade, e
   **"Playlist inteira"** se for uma playlist.
6. Ele baixa e, em seguida, normaliza automaticamente (ou pula, se já estiver
   no padrão). O `yt-dlp.exe` é baixado sozinho na primeira vez.

## Detalhes

- **Perfil**: os campos no topo (resolução, FPS, bitrates, preset) vêm com os
  padrões do servidor (720p30, 2500k/128k). Se você alterou as variáveis
  `NORMALIZE_*` no servidor, use os mesmos valores aqui.
- **Detecção inteligente**: igual à do servidor —
  - vídeo e áudio já no padrão → marca *"já está no padrão — envie direto!"*
    e não converte nada;
  - só o áudio fora do padrão → copia o vídeo intacto e converte apenas o áudio
    (muito rápido, sem perda de qualidade no vídeo);
  - resto → conversão completa.
- **Requisitos**: Windows 10 ou 11. Nada precisa ser instalado — o PowerShell
  já vem no Windows e o FFmpeg é baixado pela própria ferramenta.
- Se o download automático do FFmpeg falhar, baixe em
  <https://www.gyan.dev/ffmpeg/builds/> (versão *essentials*) e copie
  `ffmpeg.exe` e `ffprobe.exe` para uma pasta `bin` ao lado do script.

## Aviso do Windows SmartScreen

Por ser um script baixado da internet, o Windows pode mostrar um aviso na
primeira execução. Clique em *Mais informações → Executar assim mesmo*.
O código é aberto — você pode ler tudo no `Normalizador.ps1`.
