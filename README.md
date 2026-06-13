# 📡 RTMP Panel

Servidor RTMP com painel de gerência web. Permite:

- **🎬 Acervo de vídeos** — upload de vídeos pelo painel (drag & drop, multi-arquivo, barra de progresso) e divisor de episódios (✂️ corta um arquivo grande em partes, sem re-encode)
- **🎞 Playlists** — listas ordenadas reutilizáveis, com indicação de onde são usadas
- **📺 Canais (emissora 24/7)** — playlist padrão em loop + **grade de programação visual** (grade de 30 min × 7 dias, pintável; blocos podem virar a meia-noite), **transição suave** (espera o programa atual terminar antes de trocar de bloco), **vinhetas/comerciais** por contagem ou por minutos, **logo/marca d'água** e **"agora exibindo / a seguir"** em tempo real
- **🔊 Loudness EBU R128** — o volume é padronizado no upload (-16 LUFS), acabando com o "comercial mais alto que o desenho"
- **🔞 Classificação indicativa** — cada playlist (programa) tem uma classificação; o selo oficial (L/10/12/14/16/18) aparece no canto quando ela está no ar
- **📅 Guia de programação (EPG)** — página pública `/guia.html` com o que está no ar agora, o que vem a seguir e a grade do dia de cada canal
- **🎥 Live com fallback** — vincule uma entrada ao vivo (OBS) ou um relay ao canal: quando publicar, o canal corta para a live; quando cair, volta para a playlist sozinho
- **🔁 Relays** — informe um link HTTP/HLS/RTMP/RTSP/SRT/UDP e ele é retransmitido como um novo link RTMP (com opção de loop para VOD)
- **▶️ YouTube/Twitch** — cole o link de um vídeo ou live e o relay resolve a mídia real via yt-dlp automaticamente, renovando o link a cada reinício
- **🎥 Entradas ao vivo** — gere chaves de stream para publicar do OBS/encoder e distribuir pelo link gerado
- **👁 Preview no navegador** — assista qualquer stream direto no painel (HTTP-FLV + flv.js)
- **📜 Logs em tempo real** — veja a saída do FFmpeg de cada canal/relay no painel
- **⚡ Normalização no upload** — vídeos são pré-convertidos uma única vez para um perfil uniforme; a transmissão usa cópia direta com CPU quase zero
- **🩺 Watchdog e métricas** — velocidade do encoder por stream, carga de CPU/memória no dashboard e reinício automático de ffmpeg congelado
- **⏯ Autostart e auto-restart** — canais marcados sobem junto com o servidor; se o FFmpeg cair, reinicia sozinho com backoff exponencial
- **🔀 Modo aleatório** — embaralha a ordem da playlist a cada ciclo
- **🔐 Login** — painel protegido por usuário/senha; publicações RTMP só são aceitas com chaves cadastradas

## Requisitos

- **Node.js 18+**
- **FFmpeg** (e ffprobe) instalados no servidor:
  ```bash
  # Debian/Ubuntu
  sudo apt install ffmpeg
  ```
- **yt-dlp** (opcional, só para relays de YouTube/Twitch). Instale o binário oficial e mantenha atualizado — versões antigas param de extrair do YouTube:
  ```bash
  sudo wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
  sudo chmod +x /usr/local/bin/yt-dlp
  # para atualizar depois: sudo yt-dlp -U
  ```
  (No Docker já vem incluído.)

## Instalação

```bash
git clone <este-repo>
cd RTMP
npm install
cp .env.example .env   # edite ADMIN_USER/ADMIN_PASS e PUBLIC_HOST
npm start
```

- Painel web: `http://SEU_IP:3000` (login padrão `admin` / `admin` — **troque no `.env`!**)
- RTMP: `rtmp://SEU_IP:1935/live/<chave>`
- HTTP-FLV (preview/players web): `http://SEU_IP:8000/live/<chave>.flv`

### Docker

```bash
docker compose up -d --build
```

O compose já inclui FFmpeg na imagem e persiste `data/` e `media/` em volumes.

## Como usar

1. **Suba vídeos** na aba *Vídeos* (arraste arquivos ou clique em Enviar). Para um arquivo com vários episódios, use o **✂️ divisor**: marque os cortes no player e cada parte vira um vídeo do acervo (sem re-encode, cortes ajustados ao keyframe).
2. **Monte playlists** na aba *Playlists* (listas ordenadas, reutilizáveis).
3. **Crie um canal** na aba *Canais*, escolha a **playlist padrão** e clique em **Iniciar**. Opcionalmente configure:
   - **📅 Grade de programação visual**: escolha uma playlist na paleta e **pinte os horários** na grade (30 min × 7 dias, clicando e arrastando; a borracha limpa). Fora dos blocos pintados, vale a playlist padrão. Blocos podem **virar a meia-noite** (ex.: 23:00→02:00 para o corujão). O horário é o do servidor — defina `TZ` (ex.: `America/Sao_Paulo`) no `.env`/compose.
   - **✂️ Transição suave**: ao trocar de bloco, o canal **espera o programa atual terminar** antes de cortar (sem corte no meio do episódio), respeitando o limite `BLOCK_GRACE_MAX_SEC` (padrão 10 min — além disso corta mesmo, ex.: se um bloco pegou o meio de um filme).
   - **📣 Vinhetas**: vídeos inseridos a cada N vídeos **ou** a cada N minutos de conteúdo.
   - **🎨 Logo/marca d'água**: envie um PNG (global) e ative por canal, escolhendo o canto. ⚠️ Ativar a logo re-encoda o vídeo (sai do modo cópia direta — custa CPU).
   - **🎥 Fonte ao vivo prioritária**: uma entrada OBS **ou um relay**; quando publicar, o canal corta para a live; quando cair, volta para a programação (a troca leva ~2s).
4. Copie o link **RTMP** gerado — use em qualquer player (VLC: *Mídia → Abrir transmissão de rede*) ou aponte como fonte para outra plataforma. O painel mostra **o que está no ar e o que vem a seguir**, e o **📺 Guia** (`/guia.html`) é uma página pública com a grade do dia.
5. Para **retransmitir um link HTTP** (m3u8, mp4, outra live), crie um *Relay* com a URL de origem — o painel gera o link RTMP de saída. Marque *loop* se a origem for um arquivo de vídeo.
6. Para **retransmitir do YouTube/Twitch**, cole o link da página (vídeo ou live) no relay — a opção *yt-dlp* é marcada automaticamente.
   - **Lives que mudam de link a cada transmissão** (ex.: cada jogo é um link novo): use a URL permanente do canal, `https://www.youtube.com/@NomeDoCanal/live` — ela sempre aponta para a live atual. A opção *📡 somente ao vivo* (marcada automaticamente para esse formato) faz o relay **aguardar a próxima live e engatar sozinho** quando ela começar, sem mexer em nada entre uma transmissão e outra. Deixe com *autostart* e esqueça.
   - **Canal com várias lives simultâneas** (ex.: o jogo numa live e a cobertura em outra): use o *🎯 filtro de título* — o relay lista as transmissões no ar do canal e escolhe a que combina com a palavra/regex (ex.: `jogo|brasil`). O botão *🔍 Lives no ar* no editor mostra os títulos atuais para calibrar o filtro. Sem correspondência, o relay aguarda (e re-testa a cada ~30s). A origem pode ser **qualquer URL do canal ou de um vídeo dele** — o canal é descoberto automaticamente.
   - **Lives**: o yt-dlp baixa a transmissão e alimenta o FFmpeg em tempo real; se a live cair, o relay fica tentando reconectar sozinho.
   - **Vídeos**: são baixados **uma única vez** para o cache local (`media/cache/`, na melhor qualidade H.264 até 1080p) e transmitidos de lá — sem links expirando nem re-downloads a cada loop. O status mostra "BAIXANDO" durante o download. O cache é apagado quando o relay é excluído.
   - **Retransmita apenas conteúdo que você tem direito de redistribuir.**
   - Se o YouTube bloquear o IP do servidor (erro 403 ou "Sign in to confirm you're not a bot" — comum em VPS/datacenter), exporte os cookies do seu navegador (extensão "Get cookies.txt"), salve em `./data/cookies.txt` e defina `YTDLP_COOKIES=/app/data/cookies.txt` no `.env`.
7. Para **transmitir ao vivo do OBS**, crie uma *Entrada*, configure o OBS com o servidor `rtmp://SEU_IP:1935/live` e a chave gerada.

### Enviando vídeos já normalizados

O upload detecta automaticamente o quanto precisa converter:

- **Vídeo e áudio já no padrão do perfil** → só reempacota para o formato de playout (**segundos**, sem re-encode nem perda de qualidade). O badge mostra "✅ normalizado ⚡".
- **Vídeo no padrão, áudio diferente** (ex.: 48 kHz) → o vídeo é aproveitado como está e apenas o áudio é convertido (muito rápido).
- **Fora do padrão** → conversão completa, como sempre.

Para pré-normalizar na sua máquina e ter upload instantâneo, gere o arquivo com o perfil padrão (720p30, H.264/AAC 44,1 kHz estéreo):

```bash
ffmpeg -i entrada.mp4 \
  -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30" \
  -c:v libx264 -preset veryfast -profile:v high -level 4.1 \
  -b:v 2500k -maxrate 2500k -bufsize 5000k -g 60 -sc_threshold 0 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -ar 44100 -ac 2 \
  saida.mp4
```

(Se mudou o perfil via `NORMALIZE_*`, ajuste resolução/fps/bitrates de acordo. `NORMALIZE_SMART=false` desativa a detecção e força re-encode sempre.)

**No Windows**, use a ferramenta gráfica em [`tools/normalizador-windows`](tools/normalizador-windows/LEIA-ME.md): duplo clique no `Normalizador.bat`, arraste os vídeos e pronto — ela baixa o FFmpeg sozinha, aplica o mesmo perfil e a mesma detecção inteligente do servidor (inclusive avisa quando o vídeo já está no padrão e nem precisa converter).

### Modos de saída dos canais

- **⚡ Normalizado** (padrão, recomendado): cada vídeo é convertido **uma única vez** no upload para um perfil uniforme (H.264/AAC, em background e com prioridade baixa de CPU). O streaming usa `-c copy` — **CPU quase zero durante a transmissão**, sem risco de travar por falta de processamento.
- **Transcodificar ao vivo**: re-encoda 24/7 na resolução/bitrate/preset escolhidos. Use só se precisar de um perfil diferente por canal — consome muita CPU continuamente.
- **Cópia direta dos originais**: não re-encoda, mas exige que **todos os vídeos da playlist tenham codec, resolução e parâmetros idênticos** — caso contrário o stream quebra na troca de vídeo.

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PANEL_PORT` | `3000` | Porta do painel web |
| `RTMP_PORT` | `1935` | Porta RTMP |
| `HTTP_MEDIA_PORT` | `8000` | Porta HTTP-FLV (preview) |
| `PUBLIC_HOST` | *(host da requisição)* | Host/IP exibido nas URLs do painel |
| `ADMIN_USER` / `ADMIN_PASS` | `admin` / `admin` | Credenciais do painel |
| `SESSION_SECRET` | *(aleatório)* | Segredo do cookie de sessão (defina para manter login entre restarts) |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Caminho dos binários |
| `YTDLP_PATH` | `yt-dlp` | Caminho do yt-dlp (relays de YouTube/Twitch) |
| `YTDLP_FORMAT` | *(H.264+AAC ≤1080p)* | Seletor de formato do yt-dlp (VOD) |
| `YTDLP_LIVE_FORMAT` | `b` | Seletor de formato para lives |
| `YTDLP_COOKIES` | *(vazio)* | Arquivo de cookies para IPs bloqueados pelo YouTube |
| `CACHE_DIR` | `media/cache` | Cache dos vídeos baixados do YouTube |
| `MAX_UPLOAD_MB` | `4096` | Tamanho máximo por arquivo de upload |
| `ALLOW_ANY_PUBLISH` | `false` | Aceitar publicação RTMP com qualquer chave |
| `STALL_TIMEOUT_SEC` | `45` | Watchdog: reinicia o ffmpeg se ficar este tempo sem progresso (`0` desativa) |
| `BLOCK_GRACE_MAX_SEC` | `600` | Espera máxima pelo fim do programa atual na troca de bloco da grade |
| `SCHEDULER_INTERVAL_SEC` | `20` | Frequência com que o agendador confere a grade |
| `TZ` | *(do sistema)* | Fuso horário usado pela grade de programação |
| `FFMPEG_THREADS` | *(auto)* | Limita threads do ffmpeg nos streams ao vivo |
| `NORMALIZE_ENABLED` | `true` | Normalizar vídeos no upload |
| `NORMALIZE_RESOLUTION` / `NORMALIZE_FPS` | `1280x720` / `30` | Perfil de normalização |
| `NORMALIZE_VIDEO_BITRATE` / `NORMALIZE_AUDIO_BITRATE` | `2500k` / `128k` | Bitrates do perfil |
| `NORMALIZE_PRESET` | `veryfast` | Preset x264 da normalização |
| `NORMALIZE_THREADS` | *(auto)* | Limita threads da normalização |
| `NORMALIZE_CONCURRENCY` | `1` | Vídeos normalizados em paralelo |
| `NORMALIZE_SMART` | `true` | Pula o re-encode de vídeos enviados já no padrão (só remux) |
| `NORMALIZE_LOUDNORM` | `true` | Normaliza loudness (EBU R128) no upload — volume uniforme entre programas |
| `NORMALIZE_LOUDNORM_TARGET` | `I=-16:TP=-1.5:LRA=11` | Alvo do loudnorm (LUFS) |
| `FONT_PATH` | *(autodetecta)* | Fonte para textos sobrepostos (classificação indicativa) |

## Baixa latência nas lives (sem "gol do vizinho antes")

O atraso de uma live tem três fontes: o encoder (OBS), o servidor e o **buffer
do player** — este último é o que mais cresce com o tempo. O famoso "truque do
2x" do YouTube só força o player a consumir o buffer e colar na borda ao vivo.
Aqui isso é **automático**:

- **Player do painel (preview)**: roda em modo baixa latência (sem stash
  buffer) e **persegue a borda ao vivo sozinho** — atrasou mais de 2s, acelera
  1.15x; passou de 4s, pula direto para perto do vivo. A latência atual aparece
  ao lado do player.
- **Servidor**: a cadeia RTMP com cópia direta (entradas ao vivo, fallback de
  live e relays em modo cópia) não adiciona buffer relevante.

Para espremer ainda mais:

1. **No OBS**: *Configurações → Saída →* **Intervalo de keyframes = 1s**,
   controle de taxa CBR e, se a CPU permitir, preset rápido. Keyframe curto é o
   que mais reduz o atraso de quem entra no stream.
2. **No VLC** (espectadores): abra com cache reduzido —
   `vlc --network-caching=300 rtmp://servidor:1935/live/chave` (o padrão do VLC
   é ~1s ou mais).
3. **`GOP_CACHE=false`** no `.env` (opcional): quem entra fica colado no vivo,
   mas a imagem só aparece no próximo keyframe (com keyframe de 1s no OBS, é
   imperceptível). Com `true` (padrão), a imagem é instantânea e o player do
   painel persegue a borda em seguida.
4. **Relays do YouTube/HLS**: a fonte já chega com 10–30s de atraso de origem —
   não há o que fazer do nosso lado; para latência mínima, publique direto no
   servidor via OBS.

Com OBS (keyframe 1s) → servidor → player do painel ou VLC ajustado, a latência
fim-a-fim típica fica em **1–3 segundos**.

## Desempenho (stream travando?)

O vilão típico é **CPU saturada pelo transcode ao vivo**. Nesta ordem:

1. **Use o modo Normalizado nos canais** (padrão para canais novos). Os vídeos são convertidos uma única vez no upload; a transmissão vira cópia direta com CPU ~zero. Canais antigos podem ser trocados em *Editar → Modo de saída*.
2. **Acompanhe a velocidade do encoder no painel**: canais/relays no ar mostram a velocidade (ex.: `1.00x`). Se aparecer `⚠️ 0.87x`, a CPU não está acompanhando o tempo real e o stream vai engasgar — troque para o modo normalizado, reduza resolução/bitrate ou use um preset mais rápido (`superfast`/`ultrafast`).
3. **Olhe o card de CPU no Dashboard**: carga acima de ~85% sustentada significa que falta processamento para o que está rodando.
4. **Watchdog automático**: se um ffmpeg congelar (sem produzir frames por `STALL_TIMEOUT_SEC`), ele é morto e reiniciado sozinho — sem stream travado pendurado.
5. **Prioridades de CPU**: os streams ao vivo rodam com prioridade alta e a normalização com prioridade baixa, então subir vídeos novos não derruba o que está no ar.
6. **Docker**: confira `docker stats` — se o container está no limite, dê mais CPUs à VM ou reduza o número de canais em transcode simultâneos. Evite `cpus:`/`cpu_quota` apertados no compose.
7. **Relays**: prefira o modo *cópia direta* (padrão). Fontes HTTP têm reconexão automática e timeout de 15s para derrubar conexões mortas; RTSP usa TCP para evitar vídeo picotado.

## Arquitetura

```
┌─────────────┐   upload    ┌──────────────┐
│ Painel web  │────────────▶│ media/uploads │
│ (Express,   │             └──────┬───────┘
│  porta 3000)│  gerencia          │ concat + loop
└──────┬──────┘──────────┐         ▼
       │            ┌────┴─────────────┐  push   ┌─────────────────┐
       │            │ FFmpeg (1/canal, │────────▶│ node-media-server│
       ▼            │ 1/relay)         │  rtmp   │ RTMP :1935       │
  data/db.json      └──────────────────┘         │ HTTP-FLV :8000   │
                                                 └─────────────────┘
                                                   ▲            │
                                          OBS ─────┘            ▼
                                                        players / VLC /
                                                        restream / flv.js
```

Cada canal/relay ativo é um processo FFmpeg supervisionado pelo app (logs, restart automático, parada limpa). O estado fica em `data/db.json` — sem banco de dados externo.

## Segurança

- Troque `ADMIN_PASS` antes de expor o painel.
- O painel roda em HTTP puro; para acesso pela internet, coloque atrás de um reverse proxy com TLS (nginx/caddy).
- Publicações RTMP com chave desconhecida são rejeitadas (a menos que `ALLOW_ANY_PUBLISH=true`).
- A reprodução (play) dos streams é aberta — qualquer pessoa com o link assiste. Se precisar restringir, filtre as portas 1935/8000 no firewall.
