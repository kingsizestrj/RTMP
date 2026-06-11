# 📡 RTMP Panel

Servidor RTMP com painel de gerência web. Permite:

- **🎬 Acervo de vídeos** — upload de vídeos pelo painel (drag & drop, multi-arquivo, barra de progresso)
- **📺 Canais (playlist em loop)** — monte uma playlist com os vídeos enviados e o servidor gera um link RTMP que reproduz tudo em loop infinito, 24/7, como um canal de TV
- **🔁 Relays** — informe um link HTTP/HLS/RTMP/RTSP/SRT/UDP e ele é retransmitido como um novo link RTMP (com opção de loop para VOD)
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

1. **Suba vídeos** na aba *Vídeos* (arraste arquivos ou clique em Enviar).
2. **Crie um canal** na aba *Canais*, adicione os vídeos na ordem desejada e clique em **Iniciar**.
3. Copie o link **RTMP** gerado — ele fica reproduzindo a playlist em loop. Use em qualquer player (VLC: *Mídia → Abrir transmissão de rede*) ou aponte como fonte para outra plataforma.
4. Para **retransmitir um link HTTP** (m3u8, mp4, outra live), crie um *Relay* com a URL de origem — o painel gera o link RTMP de saída. Marque *loop* se a origem for um arquivo de vídeo.
5. Para **transmitir ao vivo do OBS**, crie uma *Entrada*, configure o OBS com o servidor `rtmp://SEU_IP:1935/live` e a chave gerada.

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
| `MAX_UPLOAD_MB` | `4096` | Tamanho máximo por arquivo de upload |
| `ALLOW_ANY_PUBLISH` | `false` | Aceitar publicação RTMP com qualquer chave |
| `STALL_TIMEOUT_SEC` | `45` | Watchdog: reinicia o ffmpeg se ficar este tempo sem progresso (`0` desativa) |
| `FFMPEG_THREADS` | *(auto)* | Limita threads do ffmpeg nos streams ao vivo |
| `NORMALIZE_ENABLED` | `true` | Normalizar vídeos no upload |
| `NORMALIZE_RESOLUTION` / `NORMALIZE_FPS` | `1280x720` / `30` | Perfil de normalização |
| `NORMALIZE_VIDEO_BITRATE` / `NORMALIZE_AUDIO_BITRATE` | `2500k` / `128k` | Bitrates do perfil |
| `NORMALIZE_PRESET` | `veryfast` | Preset x264 da normalização |
| `NORMALIZE_THREADS` | *(auto)* | Limita threads da normalização |
| `NORMALIZE_CONCURRENCY` | `1` | Vídeos normalizados em paralelo |

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
